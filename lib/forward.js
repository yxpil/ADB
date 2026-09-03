// 转发核心：全量流式转发 + 完整记录（不中断、不截断）
// - 请求体：完整读取后转发（不限制大小）
// - 响应体：逐 chunk 边转发边落临时文件（背压安全），结束后整体入库 SQLite
// - SSE：content-type 识别，逐事件计数（多字节字符跨 TCP 块安全），transcript 全量入库
// - 强制 accept-encoding: identity：保证记录可读、事件可解析（上游不再 gzip）
// - 客户端中断：立即停止上游、按 aborted 标记完整入库，不崩不挂
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { analyzeRequest, analyzeResponseJson, analyzeSseText, sseCounter } = require('./classify');
const { hold } = require('./virtual');

const SPOOL_DIR = path.join(os.tmpdir(), 'adb-spool');
fs.mkdirSync(SPOOL_DIR, { recursive: true });

// 虚拟 AI 目标名：x-adb-target: manual → 人工扮演上游（面板「虚拟」页应答）
const VIRTUAL_TARGETS = new Set(['manual', 'virtual', 'virtual-ai']);

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'x-adb-target', 'x-adb-inject']);

// 解析目标：优先 x-adb-target 头（支持 URL 或预设名），其次 /forward/<host> 路径，最后默认目标
function resolveTarget(req, url, cfg) {
  const raw = req.headers['x-adb-target'];
  const pick = (t) => {
    if (!t) return null;
    let s = String(t).trim();
    if (!s) return null;
    // 预设名解析（如 x-adb-target: deepseek）
    const preset = (cfg?.presets || []).find(p => p.name.toLowerCase() === s.toLowerCase());
    if (preset) s = preset.base_url;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      return { base: u.origin, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
               proto: u.protocol, basePath: u.pathname.replace(/\/$/, '') };
    } catch { return null; }
  };

  let t = pick(raw);
  let via = raw ? 'header' : null;
  if (!t) {
    const m = url.pathname.match(/^\/forward\/([^/]+)(\/.*)?$/);
    if (m) {
      const [host, port] = m[1].split(':');
      const p = Number(port) || 0;
      const proto = !port || p === 443 ? 'https:' : 'http:';   // 无端口/443 → https，显式其他端口 → http
      t = { hostname: host, port: p || 443, proto,
            base: proto + '//' + m[1], basePath: '' };
      via = 'path';
    }
  }
  if (!t && cfg?.default_target) { t = pick(cfg.default_target); via = 'default'; }
  return t ? { ...t, via } : null;
}

function apiKeyHint(headers) {
  const h = headers['authorization'] || headers['x-api-key'] || '';
  const m = String(h).match(/([A-Za-z0-9_-]{4})\s*$/);
  return m ? '***' + m[1] : (h ? '***' : null);
}

// 主入口
function forward(req, res, url, cfg, store) {
  // 虚拟 AI：x-adb-target: manual 头 或 /manual/... 路径（BIT 无法自定义头，走路径式）
  //   base_url 填 http://127.0.0.1:<port>/manual → 实际请求 /manual/chat/completions
  const rawHdr = String(req.headers['x-adb-target'] || '').trim();
  const manualPath = url.pathname === '/manual' || url.pathname.startsWith('/manual/');
  if (VIRTUAL_TARGETS.has(rawHdr.toLowerCase()) || manualPath) return virtualAi(req, res, url, store);

  const started = Date.now();
  const id = crypto.randomUUID().slice(0, 8);

  const target = resolveTarget(req, url, cfg);
  if (!target) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'missing target. set x-adb-target header (url or preset name), /forward/<host>/... path, or configure a default target in settings' }));
    return;
  }

  // 读取完整请求体（不截断）
  let reqBuf = Buffer.alloc(0);
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    reqBuf = Buffer.concat(chunks);
    dispatch();
  });
  req.on('error', () => { /* 客户端读取中断：等 close 兜底 */ });

  function dispatch() {
    let reqJson = null;
    let reqText = reqBuf.length ? reqBuf.toString('utf8') : '';
    try { reqJson = reqText ? JSON.parse(reqText) : null; } catch {}
    const preview = previewOf(reqJson, reqText);   // 预览取原始请求（注入前）

    // 调试入口：向 messages 末尾注入一条 system 指令（如让 AI 主动发消息）
    // 优先级：x-adb-inject 头（自定义文本；'off' 强制关）> 全局开关（设置页可编辑文本）
    const hInject = String(req.headers['x-adb-inject'] || '').trim();
    let injectText = null;
    if (hInject) injectText = hInject.toLowerCase() === 'off' ? null : hInject;
    else if (cfg.inject_system && cfg.inject_text) injectText = String(cfg.inject_text);
    let injected = false;
    if (injectText && reqJson && Array.isArray(reqJson.messages)) {
      reqJson.messages = [...reqJson.messages, { role: 'system', content: injectText }];
      reqText = JSON.stringify(reqJson);
      reqBuf = Buffer.from(reqText, 'utf8');
      injected = true;
    }
    const reqInfo = analyzeRequest(reqJson);

    const realPath = target.basePath + url.pathname.slice(target.via === 'path' ? ('/forward/' + url.pathname.split('/')[2]).length : 0) + url.search;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    }
    headers.host = target.hostname;
    headers['accept-encoding'] = 'identity';   // 强制明文：记录可读 + SSE 可解析
    if (injected) headers['content-length'] = reqBuf.length;   // 请求体已注入，长度同步改写

    const mod = target.proto === 'http:' ? http : https;
    let gotResponse = false;   // 响应已开始：后续 upReq 错误由 finalize 兜底，不再重复入库
    const upReq = mod.request({
      hostname: target.hostname, port: target.port,
      path: realPath, method: req.method, headers,
    }, (up) => { gotResponse = true; onResponse(up); });

    upReq.on('error', (err) => {
      if (gotResponse) { try { res.destroy(); } catch {} return; }   // finalize 已负责记录
      if (res.headersSent) { try { res.destroy(); } catch {} }
      else {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
        try { res.end(JSON.stringify({ error: 'upstream error: ' + err.message })); } catch {}
      }
      store({
        ts: new Date().toISOString(), method: req.method, path: realPath,
        target: target.base, status: 502, duration_ms: Date.now() - started,
        req_size: reqBuf.length, res_size: 0, content_type: null,
        req_headers: { ...req.headers }, res_headers: {},
        req_body: reqText || null, res_body: null,
        model: reqInfo.model, session_id: reqInfo.session_id,
        preview, tags: injected ? ['error', 'injected'] : ['error'], tools: reqInfo.tools,
        tool_calls: reqInfo.toolCalls, error: err.message,
        api_key_hint: apiKeyHint(req.headers),
      });
    });

    if (reqBuf.length) upReq.write(reqBuf);
    upReq.end();

    // ── 响应处理：边转发边 spool ──
    let resSize = 0;
    let counter = null;             // SSE 事件计数
    const spoolPath = path.join(SPOOL_DIR, id + '.spool');
    let spool = null;
    let firstChunkAt = null;
    let finished = false;
    let clientGone = false;
    let spoolEnded = false;

    function onResponse(up) {
      const contentType = String(up.headers['content-type'] || '');
      const isSSE = contentType.includes('text/event-stream');
      if (isSSE) counter = sseCounter();
      spool = fs.createWriteStream(spoolPath);

      // 透传响应头（去掉逐跳头），保持 content-length 原样（字节级转发）
      const outHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(up.statusCode, outHeaders);

      up.on('data', (chunk) => {
        if (firstChunkAt === null) firstChunkAt = Date.now();
        resSize += chunk.length;
        if (counter) counter.feed(chunk);
        spool.write(chunk);
        if (!res.write(chunk)) { up.pause(); res.once('drain', () => up.resume()); }
      });

      // 关键顺序：spool 刷盘 → 入库 → 再 res.end()。客户端看到响应结束时记录必然已落库
      up.on('end', () => endSpool(() => finalize(up.statusCode, up.headers, contentType, isSSE, false)));
      up.on('error', () => endSpool(() => finalize(up.statusCode, up.headers, contentType, isSSE, true,
        clientGone ? 'client aborted' : 'upstream stream error')));
      // 上游过早断开（半关闭）：只触发 aborted/close 不触发 error 时也必须落库
      up.on('aborted', () => {
        if (finished) return;
        endSpool(() => finalize(up.statusCode, up.headers, contentType, isSSE, true,
          clientGone ? 'client aborted' : 'upstream disconnected'));
      });
    }

    function endSpool(cb) {
      if (spool && !spoolEnded) { spoolEnded = true; spool.end(cb); }
      else cb();
    }

    // 客户端中断（连接关闭）：停止上游、标记 aborted、把已收到的部分完整入库
    res.on('close', () => {
      if (!finished && res.writableEnded !== true) {
        clientGone = true;
        try { upReq.destroy(); } catch {}
        endSpool(() => finalize(499, {}, '', !!counter, true, 'client aborted'));
      }
    });

    function finalize(status, resHeaders, contentType, isSSE, failed, errMsg) {
      if (finished) return;
      finished = true;
      // 入库（含 spool 刷盘后读取），完成后再收尾客户端响应
      let resText = '';
      try { resText = fs.readFileSync(spoolPath, 'utf8'); } catch {}
      try { fs.unlinkSync(spoolPath); } catch {}

      // 结构化提取：JSON 响应直接分析；SSE 从 transcript 提取 usage/model
      let respInfo = { categories: [], tools: [], toolCalls: [], usage: null, model: null };
      if (isSSE && resText) {
        respInfo = { ...respInfo, ...analyzeSseText(resText), categories: ['sse'] };
      } else if (resText) {
        try { respInfo = analyzeResponseJson(JSON.parse(resText)); } catch {}
      }
      const reqCats = reqInfo.categories;
      const extra = [];
      if (failed || (status ?? 0) >= 400) extra.push('error');
      if (injected) extra.push('injected');
      const tags = [...new Set([...reqCats, ...respInfo.categories, ...extra])];

      store({
        ts: new Date().toISOString(), method: req.method, path: realPath,
        target: target.base, status: status ?? null, duration_ms: Date.now() - started,
        req_size: reqBuf.length, res_size: resSize, content_type: contentType || null,
        is_sse: isSSE, sse_events: counter ? counter.events : 0,
        sse_ms: firstChunkAt !== null ? Date.now() - firstChunkAt : 0,
        aborted: errMsg === 'client aborted' ? 1 : 0,
        model: reqInfo.model || respInfo.model,
        provider: target.via === 'header' ? 'header' : target.via,
        session_id: reqInfo.session_id,
        api_key_hint: apiKeyHint(req.headers),
        preview,
        req_headers: { ...req.headers }, res_headers: resHeaders,
        req_body: reqText || null, res_body: resText || null,
        tags, tools: [...new Set([...reqInfo.tools, ...respInfo.tools])],
        tool_calls: [...reqInfo.toolCalls, ...respInfo.toolCalls],
        usage: respInfo.usage,
        error: errMsg || null,
      });

      // 记录已落库，客户端尚未收到结尾才需要 end
      if (!clientGone) { try { res.end(); } catch {} }
    }
  }
}

function previewOf(reqJson, reqText) {
  let s = '';
  if (reqJson?.messages?.length) {
    const last = reqJson.messages[reqJson.messages.length - 1];
    s = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? last);
  } else {
    s = reqText || '';
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

// ── 虚拟 AI：人工扮演上游 ─────────────────────────────────────────────
// 请求挂起进入待应答队列（面板「虚拟」页可见），人工回复后写回客户端。
// 应答模式（UI/API 传入）：
//   { mode: 'auto', text, stream?, chunk_ms? }  按 client 请求自动包装：
//       请求 stream=true → SSE 逐块 delta；否则整包 chat.completion（OpenAI 格式）
//   { mode: 'raw', status?, body, content_type? }  原样返回任意 JSON（Claude/Gemini 协议兜底）
//   { mode: 'error', status?, message }  返回错误响应（tags: error）
// 超时/客户端断开也会完整入库，不悬挂。
function virtualAi(req, res, url, store) {
  const started = Date.now();
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const reqText = Buffer.concat(chunks).toString('utf8');
    let reqJson = null;
    try { reqJson = reqText ? JSON.parse(reqText) : null; } catch {}
    const reqInfo = analyzeRequest(reqJson);
    const isStreamReq = !!(reqJson && reqJson.stream === true);
    const model = (reqJson && reqJson.model) || 'manual';
    const meta = {
      kind: 'ai', method: req.method, path: url.pathname, model,
      stream: isStreamReq, preview: previewOf(reqJson, reqText),
      session_id: reqInfo.session_id,
      onAbandon: () => record(499, '', 'client aborted before answer', ['error']),
    };

    const record = (status, resBody, errMsg, extraTags, opts = {}) => {
      const isSSE = !!opts.isSSE;
      let respInfo = { categories: [], tools: [], toolCalls: [], usage: null, model: null };
      if (isSSE && resBody) respInfo = { ...respInfo, ...analyzeSseText(resBody), categories: ['sse'] };
      else if (resBody) { try { respInfo = analyzeResponseJson(JSON.parse(resBody)); } catch {} }
      const tags = [...new Set([...reqInfo.categories, ...respInfo.categories, 'virtual', ...(extraTags || [])])];
      store({
        ts: new Date().toISOString(), method: req.method, path: url.pathname,
        target: 'manual', status, duration_ms: Date.now() - started,
        req_size: Buffer.byteLength(reqText), res_size: Buffer.byteLength(resBody),
        content_type: isSSE ? 'text/event-stream' : (opts.contentType || 'application/json'),
        is_sse: isSSE, sse_events: opts.events || 0, sse_ms: isSSE ? Date.now() - started : 0,
        aborted: errMsg === 'client aborted before answer' ? 1 : 0,
        model: reqInfo.model || respInfo.model || model, provider: 'virtual',
        session_id: reqInfo.session_id, api_key_hint: apiKeyHint(req.headers),
        preview: meta.preview,
        req_headers: { ...req.headers }, res_headers: {},
        req_body: reqText || null, res_body: resBody || null,
        tags, tools: [...new Set([...reqInfo.tools, ...respInfo.tools])],
        tool_calls: [...reqInfo.toolCalls, ...respInfo.toolCalls],
        usage: respInfo.usage, error: errMsg || null,
      });
    };

    const sseHead = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    };
    // OpenAI 流式：把文本切块逐个 delta 发出，最后 finish+usage+[DONE]；返回完整 transcript 供入库
    const streamText = (text, chunkMs, done) => {
      sseHead();
      const pieces = [];
      for (let i = 0; i < text.length; i += 16) pieces.push(text.slice(i, i + 16));
      const transcript = [];
      let i = 0;
      const timer = setInterval(() => {
        if (i < pieces.length) {
          const t = `data: ${JSON.stringify({ id: 'adb-manual', object: 'chat.completion.chunk', model,
            choices: [{ index: 0, delta: { content: pieces[i] } }] })}\n\n`;
          transcript.push(t); res.write(t); i++;
          return;
        }
        clearInterval(timer);
        const usage = { prompt_tokens: 10, completion_tokens: Math.ceil(text.length / 2), total_tokens: 10 + Math.ceil(text.length / 2) };
        const tail = `data: ${JSON.stringify({ id: 'adb-manual', object: 'chat.completion.chunk', model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`;
        transcript.push(tail);
        res.end(tail);
        done(transcript.join(''), pieces.length + 2, usage);
      }, Math.max(Number(chunkMs) || 10, 1));
    };

    const write = (r, answer) => {
      answer = answer || {};
      // 超时兜底
      if (answer.__timeout) {
        const payload = JSON.stringify({ error: { message: 'adb virtual: no manual answer (timeout)', type: 'adb_timeout' } });
        r.writeHead(504, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
        r.end(payload);
        return record(504, payload, 'manual answer timeout', ['error', 'timeout']);
      }
      const mode = answer.mode || 'auto';
      // 原文模式：任意 JSON（Claude / Gemini 协议兜底）
      if (mode === 'raw') {
        const status = Number(answer.status) || 200;
        const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
        const ct = answer.content_type || 'application/json; charset=utf-8';
        r.writeHead(status, { 'content-type': ct, 'content-length': Buffer.byteLength(body) });
        r.end(body);
        return record(status, body, status >= 400 ? 'raw error answer' : null, status >= 400 ? ['error'] : []);
      }
      // 错误模式
      if (mode === 'error') {
        const status = Number(answer.status) || 500;
        const payload = JSON.stringify({ error: { message: String(answer.message || 'manual error (from adb virtual)'), type: 'adb_manual_error' } });
        r.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
        r.end(payload);
        return record(status, payload, 'manual error answer', ['error']);
      }
      // 自动模式：请求要流式就发 SSE，否则整包 OpenAI chat.completion
      const text = String(answer.text ?? '');
      if (isStreamReq || answer.stream === true) {
        streamText(text, answer.chunk_ms, (transcript, events, usage) => {
          record(200, transcript, null, ['sse'], { isSSE: true, events, usage });
        });
        return;
      }
      const payload = JSON.stringify({
        id: 'chatcmpl-adb-manual', object: 'chat.completion', model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
        usage: { prompt_tokens: 10, completion_tokens: Math.ceil(text.length / 2), total_tokens: 10 + Math.ceil(text.length / 2) },
      });
      r.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
      r.end(payload);
      record(200, payload, null, []);
    };

    hold('ai', res, meta, write);
  });
}

module.exports = { forward, resolveTarget };
