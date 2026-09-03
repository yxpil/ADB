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

const SPOOL_DIR = path.join(os.tmpdir(), 'adb-spool');
fs.mkdirSync(SPOOL_DIR, { recursive: true });

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

module.exports = { forward, resolveTarget };
