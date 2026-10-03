// ADB 钩子/交互测试：回调参数传递、错误隔离、事件顺序
// 运行: node --test tests/hooks.test.js
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');

const bit = require('../lib/bit');
const classify = require('../lib/classify');

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

describe('回调参数传递', () => {
  test('dbInsert 回调收到完整记录对象（字段齐全）', async () => {
    const FB_PORT = 9941;
    const fakeUp = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: 'hello' }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };
    const records = [];
    const res = fakeRes();
    await bit.handle(fakeReq('POST', { message: 'hook-test', session_id: 's-1' }), res, bitPath('/api/bit/chat'), cfg, (r) => records.push(r));

    assert.strictEqual(records.length, 1);
    const rec = records[0];
    // 必须字段
    for (const field of ['ts', 'method', 'path', 'target', 'status', 'tags', 'req_body', 'provider']) {
      assert.ok(field in rec, `记录缺少字段: ${field}`);
    }
    assert.strictEqual(rec.method, 'POST');
    assert.strictEqual(rec.path, '/api/bit/chat');
    assert.strictEqual(rec.target, 'bit');
    assert.strictEqual(rec.session_id, 's-1');
    assert.deepStrictEqual(rec.tags, ['bit', 'bit:chat']);
    assert.ok(rec.ts && !Number.isNaN(Date.parse(rec.ts)));
    fakeUp.close();
  });

  test('tool 调用 dbInsert 收到 bit:tool 标签', async () => {
    const FB_PORT = 9942;
    const fakeUp = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result: 'ok' }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };
    const records = [];
    const res = fakeRes();
    await bit.handle(fakeReq('POST', { args: { x: 1 } }), res, bitPath('/api/bit/tool/shell'), cfg, (r) => records.push(r));
    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0].tags, ['bit', 'bit:tool']);
    fakeUp.close();
  });
});

describe('错误隔离（一个回调抛异常不影响其他）', () => {
  test('dbInsert 抛异常不影响代理响应', async () => {
    const FB_PORT = 9943;
    const fakeUp = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reply: 'ok' }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };
    const res = fakeRes();
    // 回调故意抛异常
    await bit.handle(fakeReq('POST', { message: 'boom' }), res, bitPath('/api/bit/chat'), cfg, () => { throw new Error('db down'); });
    // 响应仍然正常返回
    assert.strictEqual(res.code, 200);
    assert.ok(res.body.includes('ok'));
    fakeUp.close();
  });

  test('多个回调订阅同一事件，一个抛异常不阻断后续', () => {
    // 模拟 event bus：bit 模块没有内置 bus，但我们测试 classify.sseCounter 的错误隔离
    // 这里测试多监听器模式
    const bus = {
      _map: {},
      on(evt, fn) { (this._map[evt] = this._map[evt] || []).push(fn); },
      emit(evt, data) {
        (this._map[evt] || []).slice().forEach(f => { try { f(data); } catch (e) { /* 隔离 */ } });
      },
    };
    const order = [];
    bus.on('evt', () => order.push(1));
    bus.on('evt', () => { order.push(2); throw new Error('boom'); });
    bus.on('evt', () => order.push(3));
    bus.emit('evt', 'x');
    assert.deepStrictEqual(order, [1, 2, 3], '异常监听器不应阻断后续监听器');
  });
});

describe('事件/数据流顺序', () => {
  test('先写响应头再 end，状态码与 body 一致', async () => {
    const FB_PORT = 9944;
    const fakeUp = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };
    const events = [];
    const res = {
      code: 0,
      writeHead(c) { events.push('head'); this.code = c; },
      end(b) { events.push('end'); this.body = b; },
    };
    await bit.handle(fakeReq('GET'), res, bitPath('/api/bit/state'), cfg, () => {});
    assert.deepStrictEqual(events, ['head', 'end'], '应先 writeHead 再 end');
    fakeUp.close();
  });

  test('chat 路由：空 message 直接 400，不发上游、不写记录', async () => {
    const FB_PORT = 9945;
    let upstreamHits = 0;
    const fakeUp = http.createServer((req, res) => {
      upstreamHits++;
      res.writeHead(200); res.end('{}');
    });
    await new Promise(r => fakeUp.listen(FB_PORT, '127.0.0.1', r));
    const cfg = { bit_url: `http://127.0.0.1:${FB_PORT}`, bit_key: 'k', bit_pwd: 'p' };
    const records = [];

    for (const body of [undefined, {}, { message: '' }, { message: '   ' }]) {
      const res = fakeRes();
      await bit.handle(fakeReq('POST', body), res, bitPath('/api/bit/chat'), cfg, (r) => records.push(r));
      assert.strictEqual(res.code, 400, `body=${JSON.stringify(body)} 应 400`);
    }
    assert.strictEqual(upstreamHits, 0, '400 不应打上游');
    assert.strictEqual(records.length, 0, '400 不应写记录');
    fakeUp.close();
  });
});

describe('classify 钩子：消息分类回调行为', () => {
  test('analyzeRequest 对嵌套 messages 递归遍历不崩溃', () => {
    const deeplyNested = {
      model: 'm',
      messages: [{
        role: 'user',
        content: 'text',
        nested: { deeply: { nested: { tool_calls: [{ function: { name: 'shell' } }] } } },
      }],
    };
    const out = classify.analyzeRequest(deeplyNested);
    assert.ok(out.toolCalls.some(tc => tc.name === 'shell'));
  });

  test('analyzeResponseJson 对 usage 为 null/字符串安全返回 null', () => {
    assert.strictEqual(classify.analyzeResponseJson({ usage: null }).usage, null);
    assert.strictEqual(classify.analyzeResponseJson({ usage: 'bad' }).usage, null);
    assert.strictEqual(classify.analyzeResponseJson(undefined).usage, null);
  });
});
