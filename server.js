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
 * 面板: http://127.0.0.1:8987
 */
'use strict';
const http = require('http');
const { URL } = require('url');
const db = require('./lib/db');
const { forward } = require('./lib/forward');
const { serveUI } = require('./lib/ui');

const VERSION = 'v0.2.0';
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

server.on('error', (err) => {
  console.error(`[adb] 启动失败: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`ADB — Agent Debug Bridge ${VERSION}`);
  console.log(`  面板:   http://127.0.0.1:${PORT}`);
  console.log(`  转发:   x-adb-target: <url|预设名>  /  /forward/<host>/...  /  面板设置默认目标`);
  console.log(`  存储:   SQLite (data/adb.db)，WAL 模式，全量不截断`);
});
