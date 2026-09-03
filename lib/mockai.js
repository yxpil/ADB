// 虚拟 E2E：内置 mock AI 场景端点（挂在 /mock/* 之下，不经转发，直接应答）
// 用途：BIT 用户零配置做端到端联调 —— 把 provider base_url 指到 ADB，按场景选择端点：
//   POST /mock/chat                 正常 JSON 对话响应（回显 model 与最后一条 user 消息）
//   POST /mock/toolcall?name=shell  tool_calls 响应（?name= 指定工具名）
//   POST /mock/stream?events=N&interval=ms   SSE 流式（N 个事件 + usage + [DONE]）
//   POST /mock/slow?ms=D            慢流（每 chunk 间隔 D ms，共 5 个事件）
//   POST /mock/die?after=N          发 N 个事件后异常断开（测试中断恢复）
//   GET  /mock/big?kb=N             N KB 大响应
//   POST /mock/echo                 原样回显请求体与关键请求头（透传校验）
//   POST /mock/fail                 500 错误
// 所有交互全量入库（tags: mock）。
'use strict';
const { analyzeRequest, analyzeResponseJson, analyzeSseText } = require('./classify');

function sseHead(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

// 生成标准 OpenAI 流事件文本
function evt(text) { return `data: ${JSON.stringify({ id: 'mock', choices: [{ delta: { content: text } }] })}\n\n`; }

// 主入口。store(record) 入库
// 场景取 /mock/ 后第一段：BIT 填 base_url=http://127.0.0.1:<port>/mock 时，
// 请求路径为 /mock/chat/completions → scene=chat，天然兼容。
function handle(req, res, url, store) {
  const started = Date.now();
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}
    const reqInfo = analyzeRequest(Object.keys(body).length ? body : null);
    const lastMsg = Array.isArray(body.messages) && body.messages.length ? body.messages[body.messages.length - 1] : null;
    const preview = lastMsg
      ? String(typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg)).replace(/\s+/g, ' ').trim().slice(0, 120)
      : (bodyText.slice(0, 120) || null);
    const p = url.pathname;
    const scene = p.startsWith('/mock/') ? p.slice(6).split('/')[0] : null;
    let stored = false;
    const finish = (status, resBody, { isSSE = false, events = 0, tags = [], usage = null, model = null } = {}) => {
      if (stored) return;   // 防重复入库（JSON 场景先 end 后 finish 也必须入库）
      stored = true;
      let respInfo = { usage: null, model: null };
      if (isSSE) respInfo = analyzeSseText(resBody);
      else { try { respInfo = analyzeResponseJson(JSON.parse(resBody)); } catch {} }
      store({
        ts: new Date().toISOString(), method: req.method, path: p, target: 'mock', status,
        duration_ms: Date.now() - started, req_size: Buffer.byteLength(bodyText), res_size: Buffer.byteLength(resBody),
        content_type: isSSE ? 'text/event-stream' : 'application/json',
        is_sse: isSSE, sse_events: events, sse_ms: isSSE ? Date.now() - started : 0, aborted: 0,
        model: reqInfo.model || model || respInfo.model || null, provider: 'mock',
        session_id: reqInfo.session_id, api_key_hint: null, preview,
        req_headers: { ...req.headers }, res_headers: {}, req_body: bodyText || null, res_body: resBody,
        tags: ['mock', ...tags], tools: reqInfo.tools, tool_calls: reqInfo.toolCalls,
        usage: usage || respInfo.usage, error: null,
      });
    };

    // ── 正常 JSON 对话（/mock/chat[/chat/completions]）──
    if (scene === 'chat') {
      const lastUser = [...(body.messages || [])].reverse().find(m => m.role === 'user');
      const reply = `[mock] 收到：${typeof lastUser?.content === 'string' ? lastUser.content.slice(0, 200) : '(空)'}`;
      const payload = JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion', model: body.model || 'mock-chat',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return finish(200, payload);
    }

    // ── tool_calls 响应 ──
    if (scene === 'toolcall') {
      const name = url.searchParams.get('name') || 'shell';
      const payload = JSON.stringify({
        id: 'chatcmpl-mock-tc', object: 'chat.completion', model: body.model || 'mock-chat',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [
          { id: 'call_mock_1', type: 'function', function: { name, arguments: JSON.stringify({ message: 'from adb mock' }) } },
        ] } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return finish(200, payload, { tags: ['tool:' + name], model: body.model || null });
    }

    // ── SSE 流式 ──
    if (scene === 'stream' || scene === 'sse') {
      const n = Math.min(Number(url.searchParams.get('events')) || 8, 100000);
      const interval = Number(url.searchParams.get('interval')) || 0;
      sseHead(res);
      let i = 0;
      const transcript = [];
      const timer = setInterval(() => {
        const burst = interval ? 1 : 50;
        for (let k = 0; k < burst && i < n; k++, i++) {
          const t = evt(`mock-${i + 1}`);
          transcript.push(t);
          res.write(t);
        }
        if (i >= n) {
          clearInterval(timer);
          const usage = { prompt_tokens: 10, completion_tokens: n, total_tokens: 10 + n };
          const tail = `data: {"id":"mock","choices":[{"delta":{},"finish_reason":"stop"}],"usage":${JSON.stringify(usage)}}\n\ndata: [DONE]\n\n`;
          transcript.push(tail);
          res.write(tail);
          res.end();
          finish(200, transcript.join(''), { isSSE: true, events: n + 2, usage, model: body.model || 'mock-chat' });
        }
      }, interval || 1);
      return;
    }

    // ── 慢流 ──
    if (scene === 'slow') {
      const d = Number(url.searchParams.get('ms')) || 300;
      sseHead(res);
      let i = 0;
      const transcript = [];
      const timer = setInterval(() => {
        i++;
        const t = evt(`slow-${i}`);
        transcript.push(t);
        res.write(t);
        if (i >= 5) {
          clearInterval(timer);
          const tail = 'data: [DONE]\n\n';
          transcript.push(tail);
          res.write(tail);
          res.end();
          finish(200, transcript.join(''), { isSSE: true, events: 6 });
        }
      }, d);
      return;
    }

    // ── 异常断开 ──
    if (scene === 'die') {
      const after = Math.min(Number(url.searchParams.get('after')) || 3, 1000);
      sseHead(res);
      let i = 0;
      const transcript = [];
      const timer = setInterval(() => {
        i++;
        const t = evt(`die-${i}`);
        transcript.push(t);
        res.write(t);
        if (i >= after) {
          clearInterval(timer);
          setTimeout(() => { res.destroy(); finish(200, transcript.join(''), { isSSE: true, events: after, tags: ['error'] }); }, 80);
        }
      }, 30);
      return;
    }

    // ── 大响应 ──
    if (scene === 'big') {
      const kb = Math.min(Number(url.searchParams.get('kb')) || 1024, 102400);
      const payload = JSON.stringify({ marker: 'MOCK-BIG-OK', blob: 'x'.repeat(kb * 1024) });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return finish(200, payload);
    }

    // ── 回显 ──
    if (scene === 'echo') {
      const payload = JSON.stringify({
        body, size: bodyText.length,
        accept_encoding: req.headers['accept-encoding'] || null,
        authorization: req.headers['authorization'] || null,
        inject_header: req.headers['x-adb-inject'] || null,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return finish(200, payload);
    }

    // ── 500 ──
    if (scene === 'fail') {
      const payload = JSON.stringify({ error: { message: 'mock 500 (from adb /mock/fail)', type: 'mock_error' } });
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return finish(500, payload, { tags: ['error'] });
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unknown mock endpoint', endpoints: ['/mock/chat', '/mock/toolcall', '/mock/stream', '/mock/slow', '/mock/die', '/mock/big', '/mock/echo', '/mock/fail'] }));
  });
}

module.exports = { handle };
