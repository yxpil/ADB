#!/usr/bin/env node
/**
 * ADB — Agent Debug Bridge
 * 零依赖 AI Agent 调试桥梁：流式转发代理 + SQLite 全量记录 + 会话分析面板。
 *
 * 用法:
 *   node server.js                  # 监听 8987
 *   PORT=9000 node server.js
 *   ADB_DB=./my.db node server.js   # 自定义 SQLite 路径
 *
 * 接入（三选一）:
 *   1. 请求头 x-adb-target: https://api.example.com   （URL 或面板里配置的预设名）
 *   2. 路径前缀 /forward/api.example.com/v1/chat/completions
 *   3. 面板「设置」里配置默认目标，不带头的请求全部转发
 *
 * 调试入口:
 *   x-adb-inject: <文本|off>   向 messages 末尾注入一条 system 指令（让 AI 主动发消息），
 *                              off 强制关闭；全局开关与默认文本在面板「设置」里配置
 *
 * 面板: http://127.0.0.1:8987
 */
'use strict';
const http = require('http');
const { URL } = require('url');
const db = require('./lib/db');
const { forward } = require('./lib/forward');
const { serveUI } = require('./lib/ui');
const vmcp = require('./lib/vmcp');
const mockai = require('./lib/mockai');
const virtual = require('./lib/virtual');
const bit = require('./lib/bit');
const { analyzeRequest, analyzeResponseJson } = require('./lib/classify');

const VERSION = 'v0.4.0';
const PORT = Number(process.env.PORT || 8987);
db.open(process.env.ADB_DB);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    // ── 面板 ──
    if (p === '/' || p.startsWith('/ui')) return serveUI(res, PORT);

    // ── API ──
    if (p === '/api/records') {
      const q = url.searchParams;
      return json(res, db.listRequests({
        limit: Math.min(Number(q.get('limit')) || 200, 2000),
        offset: Number(q.get('offset')) || 0,
        session: q.get('session') || undefined,
        tag: q.get('tag') || undefined,
        status: q.get('status') || undefined,
        q: q.get('q') || undefined,
      }));
    }
    const mRecord = p.match(/^\/api\/record\/(\d+)$/);
    if (mRecord) {
      const r = db.getRequest(mRecord[1]);
      if (!r) { res.writeHead(404); return res.end('not found'); }
      return json(res, r);
    }
    if (p === '/api/records/clear' && req.method === 'POST') {
      db.clearAll();
      return json(res, { ok: true });
    }
    if (p === '/api/export') {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': 'attachment; filename="adb-records.jsonl"',
      });
      for (const r of db.allRequestsForExport()) res.write(JSON.stringify(r) + '\n');
      return res.end();
    }
    if (p === '/api/stats') return json(res, db.stats());
    if (p === '/api/sessions') return json(res, db.sessions(Number(url.searchParams.get('limit')) || 100));
    if (p === '/api/config') {
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
          try { return json(res, db.setConfig(JSON.parse(body || '{}'))); }
          catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
        });
        return;
      }
      return json(res, db.getConfig());
    }
    if (p === '/api/health') {
      return json(res, { ok: true, uptime: process.uptime(), version: VERSION, token: process.env.ADB_INSTANCE_TOKEN || null });
    }

    // ── 虚拟 MCP 服务器（BIT 把 MCP URL 填 http://127.0.0.1:<port>/mcp）──
    if (p === '/mcp') {
      return vmcp.handle(req, res, url, db.getConfig(), (status, resBody, started, reqText, extraTags) =>
        recordVirtualRpc(req, url, status, resBody, started, reqText, extraTags));
    }

    // ── 虚拟 AI 场景端点（BIT 把 base_url 填 http://127.0.0.1:<port>/mock）──
    if (p === '/mock' || p.startsWith('/mock/')) {
      return mockai.handle(req, res, url, r => db.insertRequest(r));
    }

    // ── 待应答队列（人工扮演 AI / 人工应答 MCP 工具）──
    if (p === '/api/pending') {
      return json(res, { ai: virtual.list('ai'), mcp: virtual.list('mcp') });
    }
    const mRespond = p.match(/^\/api\/pending\/([A-Za-z0-9-]+)\/respond$/);
    if (mRespond && req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        try {
          const ok = virtual.respond(mRespond[1], JSON.parse(body || '{}'));
          if (!ok) { res.writeHead(404); return res.end(JSON.stringify({ error: 'pending request not found (already answered or expired)' })); }
          return json(res, { ok: true });
        } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: e.message })); }
      });
      return;
    }

    // ── BIT 联动（控制与观测 BIT：chat / tool / state / sessions / mcp / audit）──
    if (p.startsWith('/api/bit/')) {
      // 凭据走内部专用读取（/api/config 只回传脱敏提示）
      return bit.handle(req, res, url, { ...db.getConfig(), ...db.getBitCredentials() }, r => db.insertRequest(r));
    }

    // ── 其余全部转发 ──
    return forward(req, res, url, db.getConfig(), r => db.insertRequest(r));
  } catch (e) {
    console.error('[adb] handler error:', e.message);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); }
    try { res.end(JSON.stringify({ error: e.message })); } catch {}
  }
});

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 虚拟 MCP JSON-RPC 入库（与转发记录同结构，tags 由 vmcp 提供）
function recordVirtualRpc(req, url, status, resBody, started, reqText, extraTags) {
  let reqJson = null;
  try { reqJson = reqText ? JSON.parse(reqText) : null; } catch {}
  const reqInfo = analyzeRequest(reqJson);
  let respInfo = { categories: [], tools: [], toolCalls: [], usage: null, model: null };
  if (resBody) { try { respInfo = analyzeResponseJson(JSON.parse(resBody)); } catch {} }
  db.insertRequest({
    ts: new Date(started || Date.now()).toISOString(), method: req.method, path: url.pathname,
    target: 'virtual-mcp', status, duration_ms: Date.now() - (started || Date.now()),
    req_size: Buffer.byteLength(reqText || ''), res_size: Buffer.byteLength(resBody || ''),
    content_type: 'application/json', is_sse: 0, sse_events: 0, sse_ms: 0, aborted: 0,
    model: reqInfo.model || respInfo.model, provider: 'virtual',
    session_id: reqInfo.session_id, api_key_hint: null,
    preview: reqText ? reqText.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    req_headers: { ...req.headers }, res_headers: {},
    req_body: reqText || null, res_body: resBody || null,
    tags: [...new Set(['mcp', ...reqInfo.categories, ...respInfo.categories, ...(extraTags || [])])],
    tools: [...new Set([...reqInfo.tools, ...respInfo.tools])],
    tool_calls: [...reqInfo.toolCalls, ...respInfo.toolCalls],
    usage: respInfo.usage, error: status >= 400 ? `status ${status}` : null,
  });
}

server.on('error', (err) => {
  console.error(`[adb] 启动失败: ${err.message}`);
  process.exit(1);
});

// 仅绑定回环地址：面板可清空/导出记录且转发无认证，不能默认暴露到局域网/公网
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ADB — Agent Debug Bridge ${VERSION}`);
  console.log(`  面板:   http://127.0.0.1:${PORT}`);
  console.log(`  转发:   x-adb-target: <url|预设名>  /  /forward/<host>/...  /  面板设置默认目标`);
  console.log(`  虚拟:   /mcp 虚拟MCP · /manual 人工扮演AI · /mock/* E2E场景 · 面板「虚拟」页`);
  console.log(`  存储:   SQLite (data/adb.db)，WAL 模式，全量不截断`);
});
