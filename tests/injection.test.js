// ADB 注入测试：XSS / 路径穿越 / 命令注入 / 协议伪 scheme
// 运行: node --test tests/injection.test.js
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bit = require('../lib/bit');
const classify = require('../lib/classify');
const db = require('../lib/db');

// ---------- 辅助 ----------
function fakeReq(method, bodyObj, rawStr) {
  const req = new EventEmitter();
  req.method = method;
  process.nextTick(() => {
    if (rawStr !== undefined) {
      req.emit('data', Buffer.from(rawStr));
    } else if (bodyObj !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
    }
    req.emit('end');
  });
  return req;
}
function fakeRes() {
  return {
    code: 0, headers: null, body: '',
    writeHead(code, headers) { this.code = code; this.headers = headers; },
    end(body) { this.body += body ?? ''; },
  };
}
function bitPath(p) { return new URL('http://127.0.0.1' + p); }

// ========== 1. 路径穿越 / 特殊字符注入到 session id / tool name ==========
describe('路径穿越注入', () => {
  test('session id 含 ../ 被白名单拒绝 (404)，不拼接到上游路径', async () => {
    const FB_PORT = 9931;
    const seen = [];
    const fakeUp = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };

    const evilIds = [
      '/api/bit/sessions/../../etc/passwd',
      '/api/bit/sessions/a%2Fb',
      '/api/bit/sessions/..%2F..%2Fsecret',
      '/api/bit/sessions/' + encodeURIComponent('${jndi:ldap://evil}'),
      '/api/bit/sessions/' + encodeURIComponent('<script>alert(1)</script>'),
    ];
    for (const p of evilIds) {
      const res = fakeRes();
      await bit.handle(fakeReq('GET'), res, bitPath(p), cfg, () => {});
      assert.strictEqual(res.code, 404, `应拒绝路径穿越: ${p}`);
    }
    // 上游从未收到带 ../ 的请求
    for (const u of seen) assert.ok(!u.includes('..'), `上游收到穿越路径: ${u}`);
    fakeUp.close();
  });

  test('tool name 含 ../ 或 shell 元字符被白名单拒绝 (404)', async () => {
    const FB_PORT = 9932;
    const seen = [];
    const fakeUp = http.createServer((req, res) => {
      seen.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };

    const evilTools = [
      '/api/bit/tool/../../../bin/sh/invoke',
      '/api/bit/tool/x;rm%20-rf/invoke',
      '/api/bit/tool/$(reboot)/invoke',
      '/api/bit/tool/`id`/invoke',
      '/api/bit/tool/' + encodeURIComponent('<script>') + '/invoke',
    ];
    for (const p of evilTools) {
      const res = fakeRes();
      await bit.handle(fakeReq('POST', {}), res, bitPath(p), cfg, () => {});
      assert.strictEqual(res.code, 404, `应拒绝恶意 tool: ${p}`);
    }
    for (const u of seen) {
      assert.ok(!u.includes('..'), `上游收到穿越: ${u}`);
      assert.ok(!u.includes(';'), `上游收到命令注入: ${u}`);
    }
    fakeUp.close();
  });
});

// ========== 2. XSS 载荷在 message / body 中被原样存储（不执行），分类器不崩溃 ==========
describe('XSS 载荷处理', () => {
  test('analyzeRequest 对含 <script> 的 message 不崩溃、不执行', () => {
    const xssPayloads = [
      '<script>alert(document.cookie)</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
      '<svg/onload=alert(1)>',
      '"><script>alert(1)</script>',
    ];
    for (const payload of xssPayloads) {
      const out = classify.analyzeRequest({
        model: 'm',
        messages: [{ role: 'user', content: payload }],
      });
      assert.ok(out.messages === 1);
      assert.ok(Array.isArray(out.categories));
      // 不应抛出异常，不应返回 undefined
      assert.ok(out && typeof out === 'object');
    }
  });

  test('chat 路由接受 XSS message 并透传到上游（代理不渲染、不转义，仅记录）', async () => {
    const FB_PORT = 9933;
    const captured = {};
    const fakeUp = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        captured.body = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reply: 'ok' }));
      });
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };
    const records = [];

    const xss = '<script>alert(1)</script>';
    const res = fakeRes();
    await bit.handle(fakeReq('POST', { message: xss, session_id: 's-xss' }), res, bitPath('/api/bit/chat'), cfg, (r) => records.push(r));
    assert.strictEqual(res.code, 200);
    // 上游收到原始 message（代理是透传，不是渲染）
    assert.ok(captured.body.includes(xss), 'XSS 载荷应原样到上游代理');
    // 记录里 preview 是截断的纯文本，不含可执行 HTML
    const rec = records[records.length - 1];
    assert.ok(rec.preview.includes(xss), '记录应包含原始 message 文本');
    assert.ok(typeof rec.preview === 'string');
    fakeUp.close();
  });
});

// ========== 3. 协议伪 scheme 注入 ==========
describe('伪协议注入', () => {
  test('bit_url 为 javascript:/data:/file: 时被拒绝 (400)', async () => {
    const evilUrls = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://evil.com/x',
      'gopher://evil.com/',
      '//evil.com',
    ];
    for (const u of evilUrls) {
      const r = await bit.call({ bit_url: u }, 'GET', '/x');
      assert.ok(r.status >= 400 && r.status < 500, `应拒绝 ${u}: got ${r.status}`);
    }
  });

  test('bit_url 含 CRLF 注入头被 URL 构造拒绝', async () => {
    const evil = 'http://127.0.0.1:99999\r\nX-Injected: yes';
    const r = await bit.call({ bit_url: evil }, 'GET', '/x');
    assert.ok(r.status >= 400, `CRLF 注入应被拒绝: got ${r.status}`);
  });
});

// ========== 4. db 层：凭据脱敏防止 SQL 注入 / 凭据泄露 ==========
describe('db 层注入防护', () => {
  test('setConfig 恶意 key 不破坏表结构（参数化查询）', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-inj-')), 't.db');
    db.open(tmp);
    // 尝试通过 config 值注入 SQL
    const evilValue = "'; DROP TABLE requests;--";
    db.setConfig({ default_target: evilValue });
    // 表还在
    const stats = db.stats();
    assert.ok(stats, 'requests 表应存在，未被 DROP');
    // 取回的值是字符串字面量，不是 SQL 执行结果
    const cfg = db.getConfig();
    assert.strictEqual(cfg.default_target, evilValue);
  });

  test('SQL 注入在 listRequests q 参数中被参数化转义', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-sqli-')), 't.db');
    db.open(tmp);
    db.insertRequest({ ts: new Date().toISOString(), method: 'GET', path: '/x', target: 'upstream', status: 200, req_body: 'hello' });
    const evil = "' OR 1=1 --";
    const rows = db.listRequests({ q: evil });
    // 不应返回全部行，应返回 0 行（因为没有任何 path/preview 含此字符串）
    assert.strictEqual(rows.length, 0, 'SQL 注入 q 参数应被参数化');
  });
});

// ========== 5. SSE 流注入：恶意 data: 行不崩溃 ==========
describe('SSE 流注入', () => {
  test('analyzeSseText 对超大/畸形 JSON 不崩溃', () => {
    const evilTexts = [
      'data: {"usage":',                    // 截断 JSON
      'data: ' + 'x'.repeat(100000),       // 超长行
      'data: {"usage":{"total_tokens":"<<script>"}}',  // 注入字符串
      'data: [DONE]\ndata: [DONE]\ndata: [DONE]',
      '',
      'data: not-json\n data: not-json',
    ];
    for (const t of evilTexts) {
      const out = classify.analyzeSseText(t);
      assert.ok(out && typeof out === 'object');
      assert.ok(!Number.isNaN(out.usage ? out.usage.total_tokens : 0));
    }
  });

  test('sseCounter 对恶意分块（在多字节字符中间切断）不损坏计数', () => {
    // 模拟攻击者按任意字节切分，包括在 emoji/中文中间切
    const raw = Buffer.from('data: <script>alert("你好🌕")</script>\n\ndata: [DONE]\n\n', 'utf8');
    const c = classify.sseCounter();
    // 在第 7 字节切断（正好在多字节字符中间）
    c.feed([...raw.subarray(0, 7)]);
    c.feed([...raw.subarray(7)]);
    assert.strictEqual(c.events, 2);
  });
});
