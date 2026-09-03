// ADB ↔ BIT 联动：把面板/API 的控制与观测请求代理到 BIT 远程访问调试接口。
// - 控制链路：/api/bit/chat → BIT /api/chat（驱动 BIT 跑一轮 Agent）；
//             /api/bit/tool/:id → BIT /api/tools/:id/invoke（直接调用 BIT 工具）
// - 分析链路：state / tools / mcp / sessions / audit（BIT 0.5.0 起提供的 /api/debug/* 只读快照）
// - 安全：Client Key / 访问密码只存本机 SQLite，不回传面板（GET /api/config 只给脱敏提示）；
//         代理请求不会记入 records（避免密钥类配置信息二次落盘），控制动作本身除外（打 bit 标签）。
'use strict';
const http = require('http');
const https = require('https');

const CHAT_TIMEOUT = 600000;   // BIT Agent 一轮可能跑很久（工具循环）
const TOOL_TIMEOUT = 120000;
const DEF_TIMEOUT = 15000;

function call(cfg, method, bitPath, body, timeoutMs) {
  return new Promise((resolve) => {
    const base = String(cfg.bit_url || '').trim().replace(/\/+$/, '');
    if (!base) return resolve({ status: 400, json: { error: '未配置 BIT 地址（面板「设置」→「BIT 联动」）' } });
    let u;
    try { u = new URL(base + bitPath); } catch (e) {
      return resolve({ status: 400, json: { error: 'BIT 地址无效: ' + e.message } });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return resolve({ status: 400, json: { error: 'BIT 地址仅支持 http/https' } });
    }
    if (!u.hostname) {
      return resolve({ status: 400, json: { error: 'BIT 地址缺少主机名: ' + base } });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      authorization: 'Bearer ' + (cfg.bit_key || ''),
      accept: 'application/json',
    };
    if (cfg.bit_pwd) headers['x-access-password'] = cfg.bit_pwd;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const started = Date.now();
    const req = mod.request(u, { method, headers, timeout: timeoutMs || DEF_TIMEOUT }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let out;
        try { out = JSON.parse(raw); } catch { out = { raw: raw.slice(0, 2000) }; }
        resolve({ status: res.statusCode || 502, json: out, ms: Date.now() - started, size: raw.length });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 502, json: { error: 'BIT 连接失败: ' + e.message }, ms: Date.now() - started }));
    if (payload) req.write(payload);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      resolve({ raw, body });
    });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 记录一次控制动作（chat / tool invoke），打 bit 标签供「请求」页检索
function record(dbInsert, info, reqBody, resBody) {
  try {
    dbInsert({
      ts: new Date().toISOString(),
      method: info.method,
      path: info.path,
      target: 'bit',
      status: info.status,
      duration_ms: info.ms,
      req_size: Buffer.byteLength(String(reqBody || '')),
      res_size: info.size ?? Buffer.byteLength(String(resBody ?? '')),
      content_type: 'application/json',
      is_sse: 0,
      sse_events: 0,
      sse_ms: 0,
      aborted: 0,
      model: null,
      provider: 'bit',
      session_id: info.session_id ?? null,
      preview: String(reqBody || '').slice(0, 200),
      req_headers: {},
      res_headers: {},
      req_body: reqBody ?? '',
      res_body: typeof resBody === 'string' ? resBody : JSON.stringify(resBody ?? null),
      tags: ['bit', info.kind],
      tools: [],
      tool_calls: [],
      usage: null,
      error: info.status >= 400 ? (resBody && resBody.error ? String(resBody.error) : `upstream ${info.status}`) : null,
    });
  } catch { /* 记录失败不影响代理响应 */ }
}

const ROUTES = [
  ['GET', /^\/api\/bit\/health$/, '/api/health'],
  ['GET', /^\/api\/bit\/state$/, '/api/debug/state'],
  ['GET', /^\/api\/bit\/tools$/, '/api/tools'],
  ['GET', /^\/api\/bit\/mcp$/, '/api/debug/mcp'],
  ['GET', /^\/api\/bit\/audit$/, '/api/audit'],
  ['GET', /^\/api\/bit\/sessions$/, '/api/debug/sessions'],
];

async function handle(req, res, url, cfg, dbInsert) {
  const p = url.pathname;
  const m = req.method;

  // 固定映射的只读路由
  for (const [verb, re, bitPath] of ROUTES) {
    if (m === verb && re.test(p)) {
      const r = await call(cfg, verb, bitPath, undefined, DEF_TIMEOUT);
      return json(res, r.status, r.json);
    }
  }

  // 会话详情
  let mt = p.match(/^\/api\/bit\/sessions\/([A-Za-z0-9_-]+)$/);
  if (m === 'GET' && mt) {
    const r = await call(cfg, 'GET', `/api/debug/sessions/${mt[1]}`, undefined, DEF_TIMEOUT);
    return json(res, r.status, r.json);
  }

  // 控制：驱动 BIT 跑一轮 Agent 对话（BIT 的 provider 若指向 ADB，请求会出现在「请求」页）
  if (m === 'POST' && p === '/api/bit/chat') {
    const { raw, body } = await readBody(req);
    const message = String(body.message || '');
    if (!message.trim()) return json(res, 400, { error: '缺少 message 字段' });
    const payload = { message };
    if (body.session_id) payload.session_id = String(body.session_id);
    if (body.images) payload.images = body.images;
    const r = await call(cfg, 'POST', '/api/chat', payload, CHAT_TIMEOUT);
    record(dbInsert, { method: m, path: p, status: r.status, ms: r.ms, size: r.size, kind: 'bit:chat', session_id: body.session_id || null }, raw, r.json);
    return json(res, r.status, r.json);
  }

  // 控制：直接调用 BIT 工具（绕过 AI 决策，调试工具层）
  mt = p.match(/^\/api\/bit\/tool\/([A-Za-z0-9_-]+)$/);
  if (m === 'POST' && mt) {
    const { raw } = await readBody(req);
    const r = await call(cfg, 'POST', `/api/tools/${mt[1]}/invoke`, raw ? JSON.parse(raw) : {}, TOOL_TIMEOUT);
    record(dbInsert, { method: m, path: p, status: r.status, ms: r.ms, size: r.size, kind: 'bit:tool' }, raw, r.json);
    return json(res, r.status, r.json);
  }

  json(res, 404, { error: 'not found' });
}

module.exports = { handle, call };
