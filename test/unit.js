// ADB 单元测试（不依赖 E2E）：node test/unit.js
// 覆盖 BIT 联动（lib/bit.js）调用与控制边界、对话分析（lib/classify.js）、
// BIT 凭据脱敏（lib/db.js）。全部使用本机回环临时服务，零外部依赖。
'use strict';
const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bit = require('../lib/bit');
const classify = require('../lib/classify');
const db = require('../lib/db');
const fakeBit = require('../e2e/fake-bit');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}  ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log(`PASS  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}  ${e.message}`); }
}

// ---------- 测试辅助 ----------

// bit.handle 用的假 req（EventEmitter，异步吐 body）
function fakeReq(method, bodyObj) {
  const req = new EventEmitter();
  req.method = method;
  process.nextTick(() => {
    if (bodyObj !== undefined) req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
    req.emit('end');
  });
  return req;
}

// 捕获 writeHead/end 的假 res
function fakeRes() {
  const res = {
    code: 0, headers: null, body: '',
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end(body) { this.body += body ?? ''; },
  };
  return res;
}

const URL_BASE = 'http://127.0.0.1';
function bitPath(p) { return new URL(URL_BASE + p); }

(async () => {
  // ========== 1. lib/bit.js — call() 底层边界 ==========
  {
    // 临时回环服务：回显收到的认证头
    const seen = {};
    const echo = http.createServer((req, res) => {
      seen.authorization = req.headers.authorization || '';
      seen.pwd = req.headers['x-access-password'] || '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: 1 }));
    });
    await new Promise(r => echo.listen(0, '127.0.0.1', r));
    const port = echo.address().port;
    const goodCfg = { bit_url: `http://127.0.0.1:${port}`, bit_key: 'bit_k1', bit_pwd: 'pwd1' };

    await ta('call 成功：JSON 解析 + 状态透传', async () => {
      const r = await bit.call(goodCfg, 'GET', '/api/health', undefined, 3000);
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.json, { ok: true, echo: 1 });
      assert.ok(r.ms >= 0 && r.size > 0);
    });

    await ta('call 携带 Bearer Key + X-Access-Password 双凭据', async () => {
      await bit.call(goodCfg, 'GET', '/api/health', undefined, 3000);
      assert.strictEqual(seen.authorization, 'Bearer bit_k1');
      assert.strictEqual(seen.pwd, 'pwd1');
    });

    await ta('call 无密码时不发送 x-access-password 头', async () => {
      seen.pwd = 'SENT';
      await bit.call({ bit_url: goodCfg.bit_url, bit_key: 'k' }, 'GET', '/api/health', undefined, 3000);
      assert.strictEqual(seen.pwd, '');
    });

    await ta('call 非法协议拒绝（ftp/file/javascript）', async () => {
      for (const proto of ['ftp://a', 'file:///etc', 'javascript:alert(1)']) {
        const r = await bit.call({ bit_url: proto }, 'GET', '/x');
        assert.strictEqual(r.status, 400, proto);
        assert.ok(/仅支持 http\/https/.test(r.json.error), proto);
      }
    });

    await ta('call 未配置地址 400', async () => {
      const r = await bit.call({}, 'GET', '/x');
      assert.strictEqual(r.status, 400);
      assert.ok(/未配置 BIT 地址/.test(r.json.error));
    });

    await ta('call 空白/残缺地址：一律 4xx/5xx + 错误信息，绝不抛异常', async () => {
      for (const bad of ['   ', 'http://', 'http://[', 'http://:99999', 'http:///', 'no-scheme']) {
        const r = await bit.call({ bit_url: bad }, 'GET', '/x');
        assert.ok(r.status >= 400 && r.status < 600, `bad=${JSON.stringify(bad)} got=${r.status}`);
        assert.ok(r.json && r.json.error, `bad=${JSON.stringify(bad)} 缺错误信息`);
      }
    });

    await ta('call 地址尾斜杠归一（不产生 //）', async () => {
      const r = await bit.call({ ...goodCfg, bit_url: goodCfg.bit_url + '///' }, 'GET', '/api/health', undefined, 3000);
      assert.strictEqual(r.status, 200);
    });

    await ta('call POST 携带 JSON body 与 content-length', async () => {
      const captured = {};
      const cap = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          captured.body = Buffer.concat(chunks).toString('utf8');
          captured.len = req.headers['content-length'];
          captured.ctype = req.headers['content-type'];
          res.writeHead(200); res.end('{}');
        });
      });
      await new Promise(r => cap.listen(0, '127.0.0.1', r));
      const cport = cap.address().port;
      const r = await bit.call({ bit_url: `http://127.0.0.1:${cport}` }, 'POST', '/api/chat', { message: '边界消息↯' }, 3000);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(captured.body).message, '边界消息↯');
      assert.strictEqual(Number(captured.len), Buffer.byteLength(captured.body));
      assert.strictEqual(captured.ctype, 'application/json');
      cap.close();
    });

    await ta('call 非 JSON 响应回退 raw（截断 2000）', async () => {
      const txt = http.createServer((_req, res) => { res.writeHead(503); res.end('oops-not-json'); });
      await new Promise(r => txt.listen(0, '127.0.0.1', r));
      const r = await bit.call({ bit_url: `http://127.0.0.1:${txt.address().port}` }, 'GET', '/x', undefined, 3000);
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.raw, 'oops-not-json');
      txt.close();
    });

    await ta('call 超时 → 502', async () => {
      const slow = http.createServer(() => { /* 永不响应 */ });
      await new Promise(r => slow.listen(0, '127.0.0.1', r));
      const r = await bit.call({ bit_url: `http://127.0.0.1:${slow.address().port}` }, 'GET', '/x', undefined, 200);
      assert.strictEqual(r.status, 502);
      assert.ok(/BIT 连接失败/.test(r.json.error));
      slow.close();
    });

    await ta('call 不可达端口 → 502', async () => {
      const r = await bit.call({ bit_url: 'http://127.0.0.1:59997' }, 'GET', '/x', undefined, 1000);
      assert.strictEqual(r.status, 502);
    });

    echo.close();
  }

  // ========== 2. lib/bit.js — handle() 路由与控制边界（真 fake BIT）==========
  {
    const FB_PORT = 9923; // 与 E2E(9912) 错开
    const orig = fakeBit.PORT;
    Object.defineProperty(fakeBit, 'PORT', { value: FB_PORT });
    await new Promise(r => fakeBit.server.listen(FB_PORT, '127.0.0.1', r));
    const FB = `http://127.0.0.1:${FB_PORT}`;
    const okCfg = { bit_url: FB, bit_key: fakeBit.CLIENT_KEY, bit_pwd: fakeBit.PASSWORD };

    async function handle(method, p, cfg, bodyObj) {
      const res = fakeRes();
      await bit.handle(fakeReq(method, bodyObj), res, bitPath(p), cfg, r => records.push(r));
      return res;
    }
    const records = [];

    await ta('handle 只读代理：state 快照', async () => {
      const res = await handle('GET', '/api/bit/state', okCfg);
      assert.strictEqual(res.code, 200);
      assert.strictEqual(JSON.parse(res.body).version, '0.5.0-e2e');
    });

    await ta('handle 错误凭据 401 原样透传', async () => {
      const res = await handle('GET', '/api/bit/state', { ...okCfg, bit_key: 'wrong' });
      assert.strictEqual(res.code, 401);
    });

    await ta('handle 缺密码 401', async () => {
      const res = await handle('GET', '/api/bit/state', { ...okCfg, bit_pwd: '' });
      assert.strictEqual(res.code, 401);
    });

    await ta('handle 会话 id 白名单字符：斜杠/点/Unicode 不匹配 → 404（路径穿越阻断）', async () => {
      for (const bad of ['/api/bit/sessions/a/b', '/api/bit/sessions/a.b', '/api/bit/sessions/会话', '/api/bit/sessions/', '/api/bit/sessions/%2e%2e']) {
        const res = await handle('GET', bad, okCfg);
        assert.strictEqual(res.code, 404, `bad=${bad} got=${res.code}`);
      }
    });

    await ta('handle 工具名白名单字符：路径穿越 → 404', async () => {
      for (const bad of ['/api/bit/tool/a/b/invoke', '/api/bit/tool/../invoke', '/api/bit/tool/']) {
        const res = await handle('POST', bad, okCfg, {});
        assert.strictEqual(res.code, 404, `bad=${bad} got=${res.code}`);
      }
    });

    await ta('handle 未知 /api/bit/* 路由 404', async () => {
      const res = await handle('GET', '/api/bit/whatever', okCfg);
      assert.strictEqual(res.code, 404);
    });

    await ta('handle GET 打到 POST-only 路由 → 404', async () => {
      assert.strictEqual((await handle('GET', '/api/bit/chat', okCfg)).code, 404);
      assert.strictEqual((await handle('GET', '/api/bit/tool/shell', okCfg)).code, 404);
    });

    await ta('handle chat：驱动 BIT + 动作入库（ts/tags/target/provider 全量）', async () => {
      const res = await handle('POST', '/api/bit/chat', okCfg, { message: '单元对话✓', session_id: 's-1' });
      assert.strictEqual(res.code, 200);
      assert.strictEqual(JSON.parse(res.body).reply, 'BIT-REPLY<单元对话✓>');
      const rec = records[records.length - 1];
      assert.strictEqual(rec.target, 'bit');
      assert.strictEqual(rec.provider, 'bit');
      assert.ok(rec.ts && !Number.isNaN(Date.parse(rec.ts)), 'record 必须带合法 ts');
      assert.deepStrictEqual(rec.tags, ['bit', 'bit:chat']);
      assert.ok(rec.req_body.includes('单元对话✓'));
      assert.strictEqual(rec.status, 200);
    });

    await ta('handle chat：空 body / 空白 message → 400 且不入库', async () => {
      const n0 = records.length;
      assert.strictEqual((await handle('POST', '/api/bit/chat', okCfg, undefined)).code, 400);
      assert.strictEqual((await handle('POST', '/api/bit/chat', okCfg, { message: '   ' })).code, 400);
      assert.strictEqual(records.length, n0, '失败请求不得产生记录');
    });

    await ta('handle chat：非 JSON body 容错为空对象 → 400', async () => {
      const req = new EventEmitter();
      req.method = 'POST';
      process.nextTick(() => { req.emit('data', Buffer.from('not-json{{')); req.emit('end'); });
      const res = fakeRes();
      await bit.handle(req, res, bitPath('/api/bit/chat'), okCfg, () => {});
      assert.strictEqual(res.code, 400);
    });

    await ta('handle tool：直调 + bit:tool 入库', async () => {
      const res = await handle('POST', '/api/bit/tool/shell', okCfg, { args: { command: 'echo 单元' } });
      assert.strictEqual(res.code, 200);
      assert.ok(JSON.parse(res.body).result.includes('echo 单元'));
      const rec = records[records.length - 1];
      assert.deepStrictEqual(rec.tags, ['bit', 'bit:tool']);
      assert.strictEqual(rec.status, 200);
    });

    await ta('handle tool：未知工具 404 透传且入库带 error', async () => {
      const res = await handle('POST', '/api/bit/tool/ghost', okCfg, {});
      assert.strictEqual(res.code, 404);
      const rec = records[records.length - 1];
      assert.strictEqual(rec.status, 404);
      assert.ok(rec.error, '4xx/5xx 动作必须带 error 字段');
    });

    await ta('handle 未配置地址 → 400', async () => {
      assert.strictEqual((await handle('GET', '/api/bit/state', {})).code, 400);
    });

    await ta('handle 短会话 id 合法可用（连字符/下划线/数字）', async () => {
      assert.strictEqual((await handle('GET', '/api/bit/sessions/s-1', okCfg)).code, 200);
      assert.strictEqual((await handle('GET', '/api/bit/sessions/a_B-09', okCfg)).code, 404); // 格式合法但不存在
    });

    fakeBit.server.close();
    Object.defineProperty(fakeBit, 'PORT', { value: orig });
  }

  // ========== 3. lib/classify.js — 对话分析边界 ==========
  {
    t('analyzeRequest：null/标量安全返回空结构', () => {
      for (const bad of [null, undefined, 42, 'str', true]) {
        const out = classify.analyzeRequest(bad);
        assert.deepStrictEqual(out, { categories: [], tools: [], toolCalls: [], model: null, session_id: null, messages: 0 }, String(bad));
      }
    });

    t('analyzeRequest：model/messages/session_id 提取（含 conversation_id 变体）', () => {
      assert.strictEqual(classify.analyzeRequest({ model: 'm1', messages: [{}, {}, {}] }).model, 'm1');
      assert.strictEqual(classify.analyzeRequest({ model: 'm1', messages: [{}, {}, {}] }).messages, 3);
      assert.strictEqual(classify.analyzeRequest({ session_id: 'a' }).session_id, 'a');
      assert.strictEqual(classify.analyzeRequest({ conversation_id: 'b' }).session_id, 'b');
      assert.strictEqual(classify.analyzeRequest({ conversationId: 'c' }).session_id, 'c');
      assert.strictEqual(classify.analyzeRequest({}).session_id, null);
    });

    t('analyzeRequest：tools-defined + 嵌套 tool_calls + function_call 兼容', () => {
      const out = classify.analyzeRequest({
        tools: [{ type: 'function', function: { name: 'shell' } }, { name: 'now' }, { /* 无名 */ }],
        messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'shell', arguments: '{"a":1}' } }] }, { role: 'assistant', function_call: { name: 'legacy', arguments: 'x' } }],
      });
      assert.ok(out.categories.includes('tools-defined'));
      assert.ok(out.tools.includes('shell') && out.tools.includes('now'));
      const names = out.toolCalls.map(c => c.name).sort();
      assert.deepStrictEqual(names, ['legacy', 'shell']);
      assert.strictEqual(out.toolCalls.find(c => c.name === 'shell').args, '{"a":1}');
      assert.ok(out.categories.includes('tool:shell') && out.categories.includes('tool:legacy'));
    });

    t('analyzeRequest：content 数组（多模态分段）拼接后识别 markdown', () => {
      const out = classify.analyzeRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: '前半 ' }, { type: 'image_url', image_url: {} }, { type: 'text', text: '```js\ncode\n```' }] }] });
      assert.ok(out.categories.includes('md:code'), JSON.stringify(out.categories));
    });

    t('analyzeResponseJson：usage 缺 total 自动求和 / 坏 usage 忽略', () => {
      const ok = classify.analyzeResponseJson({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
      assert.strictEqual(ok.usage.total_tokens, 15);
      assert.strictEqual(classify.analyzeResponseJson({ usage: 'bad' }).usage, null);
      assert.strictEqual(classify.analyzeResponseJson(null).usage, null);
      assert.strictEqual(classify.analyzeResponseJson({ model: 'm2' }).model, 'm2');
    });

    t('analyzeSseText：取流内 usage / 跳过 [DONE] / 非 JSON 行忽略', () => {
      const text = [
        'data: {"model":"m3"}',
        'data: not-json',
        'data: {"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}',
        'data: [DONE]',
        '',
      ].join('\n');
      const out = classify.analyzeSseText(text);
      assert.strictEqual(out.model, 'm3');
      assert.strictEqual(out.usage.total_tokens, 10);
      assert.strictEqual(classify.analyzeSseText('data: [DONE]\n\n').usage, null);
      assert.strictEqual(classify.analyzeSseText('').usage, null);
    });

    t('sseCounter：多字节字符逐字节跨块事件计数不损坏', () => {
      const raw = Buffer.from('data: 你好世界 🌕\n\ndata: [DONE]\n\n', 'utf8');
      const c = classify.sseCounter();
      for (const b of raw) c.feed([b]);   // 逐字节喂入（最恶劣分块）
      assert.strictEqual(c.events, 2);
      const c2 = classify.sseCounter();
      c2.feed([...raw.subarray(0, 5)]); c2.feed([...raw.subarray(5)]);
      assert.strictEqual(c2.events, 2);
    });
  }

  // ========== 4. lib/db.js — BIT 凭据脱敏边界 ==========
  {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-unit-')), 'unit.db');
    db.open(tmp);
    const KEY = 'bit_secret_key_abcdef_中文';
    const PWD = 'pwd-中文-123';

    t('setConfig→getConfig：完整 Key/密码绝不出现在返回值里', () => {
      db.setConfig({ bit_url: 'http://127.0.0.1:9921', bit_key: KEY, bit_pwd: PWD });
      const cfg = db.getConfig();
      const text = JSON.stringify(cfg);
      assert.ok(!text.includes(KEY), '完整 Key 不得回传');
      assert.ok(!text.includes(PWD), '完整密码不得回传');
      assert.ok(!('bit_key' in cfg) && !('bit_pwd' in cfg), '不得存在 bit_key/bit_pwd 字段');
      assert.strictEqual(cfg.bit_key_set, true);
      assert.strictEqual(cfg.bit_pwd_set, true);
      // 中文按 char 计数（不是字节）
      assert.strictEqual(cfg.bit_key_hint, 'bit_se…(' + [...KEY].length + ')');
      assert.strictEqual(cfg.bit_url, 'http://127.0.0.1:9921');
    });

    t('getBitCredentials：内部通道返回完整凭据', () => {
      const cred = db.getBitCredentials();
      assert.strictEqual(cred.bit_key, KEY);
      assert.strictEqual(cred.bit_pwd, PWD);
    });

    t('凭据未设置时 getBitCredentials 返回空串', () => {
      db.setConfig({ bit_key: '', bit_pwd: '' });
      assert.deepStrictEqual(db.getBitCredentials(), { bit_key: '', bit_pwd: '' });
      const cfg = db.getConfig();
      assert.strictEqual(cfg.bit_key_set, false);
      assert.strictEqual(cfg.bit_key_hint, '');
    });

    t('setConfig 部分更新：未提及的键保持不变', () => {
      db.setConfig({ bit_url: 'http://a', bit_key: 'k1', bit_pwd: 'p1' });
      db.setConfig({ default_target: 'http://b' });
      const cred = db.getBitCredentials();
      assert.strictEqual(cred.bit_key, 'k1');
      assert.strictEqual(cred.bit_pwd, 'p1');
      assert.strictEqual(db.getConfig().bit_url, 'http://a');
    });

    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }

  // ========== 汇总 ==========
  console.log(`\n==== ${pass}/${pass + fail} passed ====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('unit runner error:', e); process.exit(1); });
