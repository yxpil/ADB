// ADB 集成测试：db + classify + bit 模块协作端到端路径
// 运行: node --test tests/integration.test.js
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

function fakeReq(method, bodyObj) {
  const req = new EventEmitter();
  req.method = method;
  process.nextTick(() => {
    if (bodyObj !== undefined) req.emit('data', Buffer.from(JSON.stringify(bodyObj)));
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

describe('端到端：配置 → BIT 联动 → 记录入库 → 列表查询', () => {
  test('完整流程：设置凭据 → chat 代理 → 记录可被 listRequests 查到', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-int-')), 'int.db');
    db.open(tmp);

    const FB_PORT = 9951;
    const fakeUp = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: '集成测试回复', usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));

    // 1. 设置配置
    db.setConfig({ bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'secret-key', bit_pwd: 'secret-pwd' });
    const cred = db.getBitCredentials();
    assert.strictEqual(cred.bit_key, 'secret-key');
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: cred.bit_key, bit_pwd: cred.bit_pwd };

    // 2. 发 chat 请求
    const res = fakeRes();
    await bit.handle(
      fakeReq('POST', { message: '端到端消息', session_id: 'e2e-1' }),
      res, bitPath('/api/bit/chat'), cfg,
      (r) => db.insertRequest(r),
    );
    assert.strictEqual(res.code, 200);

    // 3. 记录可被查到
    const rows = db.listRequests({ session: 'e2e-1' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].session_id, 'e2e-1');
    assert.ok(rows[0].preview.includes('端到端消息'), 'preview 应包含 message 文本');

    // 4. stats 统计正确
    const s = db.stats();
    assert.strictEqual(s.total, 1);

    fakeUp.close();
  });

  test('错误路径：上游 500 → 记录带 error 字段 → stats.err_count 计数', async () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-int2-')), 't.db');
    db.open(tmp);

    const FB_PORT = 9952;
    const fakeUp = http.createServer((req, res) => {
      res.writeHead(500); res.end('{"error":"upstream boom"}');
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };

    const res = fakeRes();
    await bit.handle(fakeReq('POST', { message: 'fail-test' }), res, bitPath('/api/bit/chat'), cfg, (r) => db.insertRequest(r));
    assert.strictEqual(res.code, 500);

    const rows = db.listRequests({});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 500);
    assert.ok(rows[0].error, '5xx 记录应有 error 字段');

    const s = db.stats();
    assert.ok(s.err_count >= 1);

    fakeUp.close();
  });
});

describe('classify + db 协作：响应分类后入库', () => {
  test('analyzeResponseJson 的 usage 可写入记录', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adb-int3-')), 't.db');
    db.open(tmp);
    const analysis = classify.analyzeResponseJson({
      usage: { prompt_tokens: 20, completion_tokens: 10 },
      model: 'test-model',
    });
    db.insertRequest({
      ts: new Date().toISOString(), method: 'POST', path: '/v1/chat/completions',
      target: 'upstream', status: 200, model: analysis.model, usage: analysis.usage,
      req_body: 'test', res_body: '{}', tags: ['upstream'], tools: [], tool_calls: [],
    });
    const rows = db.listRequests({});
    assert.strictEqual(rows[0].model, 'test-model');
    assert.strictEqual(rows[0].usage.total_tokens, 30);
  });
});

describe('BIT 只读路由集：health/state/tools/mcp/audit/sessions', () => {
  test('所有只读路由都能代理并返回 200', async () => {
    const FB_PORT = 9953;
    const routesHit = [];
    const fakeUp = http.createServer((req, res) => {
      routesHit.push(req.url);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };

    const routes = ['/api/bit/health', '/api/bit/state', '/api/bit/tools', '/api/bit/mcp', '/api/bit/audit', '/api/bit/sessions'];
    for (const r of routes) {
      const res = fakeRes();
      await bit.handle(fakeReq('GET'), res, bitPath(r), cfg, () => {});
      assert.strictEqual(res.code, 200, `路由 ${r} 应 200`);
    }
    assert.strictEqual(routesHit.length, 6);
    fakeUp.close();
  });
});
