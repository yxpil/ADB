// 假上游：e2e 测试用的确定性 AI API 模拟器
// 端点：
//   POST /v1/chat/completions          JSON 响应（tools / tool_calls / usage / markdown 变体）
//   POST /v1/chat/stream               SSE：24 个 chunk（含多字节字符 + 3 字节逐块发送）+ usage + [DONE]
//   POST /v1/stream-huge?events=N      SSE：N 个 data 事件（压力测试）
//   POST /v1/stream-slow?ms=D          SSE：每 chunk 间隔 D ms（慢流）
//   POST /v1/stream-die?after=N        SSE：发 N 个事件后直接断开（上游中断）
//   GET  /v1/big?kb=N                  JSON：N KB 大响应
//   POST /v1/echo                      原样返回请求体 + 关键请求头（透传校验）
//   POST /v1/fail                      500 错误
//   POST /v1/session                   带 usage 的普通 JSON
'use strict';
const http = require('http');
const { genSseEvents } = require('./stream-gen');

const PORT = Number(process.env.FAKE_PORT || 9911);

function sseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

// 把一段文本按 3 字节一组逐块发送（多字节字符必被 TCP 分块从中间截断）
function writeByteSplit(res, text, cb) {
  const raw = Buffer.from(text, 'utf8');
  let i = 0;
  const timer = setInterval(() => {
    for (let k = 0; k < 3 && i < raw.length; k++, i++) res.write(raw.slice(i, i + 1));
    if (i >= raw.length) { clearInterval(timer); cb && cb(); }
  }, 1);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(bodyText); } catch {}

    // ── JSON 对话 ──
    if (u.pathname === '/v1/chat/completions') {
      const wantsTools = JSON.stringify(body).includes('E2E-TOOLCALL');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'cmpl-e2e', object: 'chat.completion', model: body.model || 'fake-model',
        choices: [{
          index: 0, finish_reason: wantsTools ? 'tool_calls' : 'stop',
          message: wantsTools
            ? { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo E2E-TOOLCALL-OK' }) } }] }
            : { role: 'assistant', content: '# 标题\n\n```js\ncode block\n```\n\n- 列表项\n\n| 表 | 格 |\n|---|---|\n| a | b |\n' },
        }],
        usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
      }));
    }

    // ── SSE 标准（多字节 + 字节级分块）──
    if (u.pathname === '/v1/chat/stream') {
      sseHead(res);
      const events = genSseEvents(body.model || 'fake-model');
      const payload = events.join('');
      return writeByteSplit(res, payload, () => res.end());
    }

    // ── SSE 大量事件（压力）──
    if (u.pathname === '/v1/stream-huge') {
      const n = Number(u.searchParams.get('events')) || 100000;
      sseHead(res);
      let i = 0;
      const timer = setInterval(() => {
        let burst = 50;
        while (burst-- && i < n) {
          i++;
          res.write(`data: {"id":"h","choices":[{"delta":{"content":"块${i}🌑"}}]}\n\n`);
        }
        if (i >= n) {
          clearInterval(timer);
          res.write(`data: {"id":"h","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":${n},"total_tokens":${100 + n}}}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 1);
      return;
    }

    // ── SSE 慢流 ──
    if (u.pathname === '/v1/stream-slow') {
      const d = Number(u.searchParams.get('ms')) || 100;
      sseHead(res);
      let i = 0;
      const timer = setInterval(() => {
        i++;
        res.write(`data: {"choices":[{"delta":{"content":"slow-${i}"}}]}\n\n`);
        if (i >= 5) { clearInterval(timer); res.write('data: [DONE]\n\n'); res.end(); }
      }, d);
      return;
    }

    // ── SSE 上游中途断开 ──
    if (u.pathname === '/v1/stream-die') {
      const after = Number(u.searchParams.get('after')) || 3;
      sseHead(res);
      let i = 0;
      const timer = setInterval(() => {
        i++;
        res.write(`data: {"choices":[{"delta":{"content":"d${i}"}}]}\n\n`);
        if (i >= after) {
          clearInterval(timer);
          // 等 socket 把已写事件刷出去再断开，保证客户端确定性地收到 after 个事件
          setTimeout(() => res.destroy(), 80);
        }
      }, 30);
      return;
    }

    // ── 大响应 ──
    if (u.pathname === '/v1/big') {
      const kb = Number(u.searchParams.get('kb')) || 1024;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ blob: 'x'.repeat(kb * 1024), marker: 'E2E-BIG-OK' }));
    }

    // ── 透传校验 ──
    if (u.pathname === '/v1/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        body: body, auth: req.headers['authorization'] || null,
        accept_encoding: req.headers['accept-encoding'] || null,
        custom: req.headers['x-adb-custom'] || null, size: bodyText.length,
      }));
    }

    // ── 500 ──
    if (u.pathname === '/v1/fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'E2E-FAIL-expected' } }));
    }

    // ── 带 usage 的普通 JSON ──
    if (u.pathname === '/v1/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }));
    }

    res.writeHead(404); res.end('not found');
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`fake-upstream on http://127.0.0.1:${PORT}`));
}
module.exports = { server, PORT };
