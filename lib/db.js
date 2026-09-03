// SQLite 存储层（node:sqlite，零依赖）
// 设计：requests 全量落库（请求/响应体不截断，SSE 存完整 transcript），
// 大体积响应经临时文件 spool 后入库，避免内存膨胀。
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'adb.db');

let db;

function open(dbPath) {
  const file = dbPath || process.env.ADB_DB || DEFAULT_DB;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  migrate();
  return db;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      target TEXT NOT NULL,
      status INTEGER,
      duration_ms INTEGER,
      req_size INTEGER DEFAULT 0,
      res_size INTEGER DEFAULT 0,
      content_type TEXT,
      is_sse INTEGER DEFAULT 0,
      sse_events INTEGER DEFAULT 0,
      sse_ms INTEGER,
      aborted INTEGER DEFAULT 0,
      model TEXT,
      provider TEXT,
      session_id TEXT,
      api_key_hint TEXT,
      preview TEXT,
      req_headers TEXT,
      res_headers TEXT,
      req_body TEXT,
      res_body TEXT,
      tags TEXT,
      tools TEXT,
      tool_calls TEXT,
      usage TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_requests_ts      ON requests(ts);
    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_requests_target  ON requests(target);
    CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status);
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// ---------- 写入 ----------
const INSERT_SQL = `INSERT INTO requests (
  ts, method, path, target, status, duration_ms, req_size, res_size, content_type,
  is_sse, sse_events, sse_ms, aborted, model, provider, session_id, api_key_hint,
  preview, req_headers, res_headers, req_body, res_body, tags, tools, tool_calls, usage, error
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

function insertRequest(r) {
  db.prepare(INSERT_SQL).run(
    r.ts, r.method, r.path, r.target, r.status ?? null, r.duration_ms ?? null,
    r.req_size ?? 0, r.res_size ?? 0, r.content_type ?? null,
    r.is_sse ? 1 : 0, r.sse_events ?? 0, r.sse_ms ?? null, r.aborted ? 1 : 0,
    r.model ?? null, r.provider ?? null, r.session_id ?? null, r.api_key_hint ?? null,
    r.preview ?? null,
    JSON.stringify(r.req_headers ?? {}), JSON.stringify(r.res_headers ?? {}),
    r.req_body ?? null, r.res_body ?? null,
    JSON.stringify(r.tags ?? []), JSON.stringify(r.tools ?? []),
    JSON.stringify(r.tool_calls ?? []), r.usage ? JSON.stringify(r.usage) : null,
    r.error ?? null
  );
}

// ---------- 查询 ----------
// 列表：不含大字段（req_body/res_body），详情接口单独取
const LIST_COLS = `id, ts, method, path, target, status, duration_ms, req_size, res_size,
  content_type, is_sse, sse_events, sse_ms, aborted, model, provider, session_id,
  api_key_hint, preview, tags, tools, tool_calls, usage, error`;

function listRequests({ limit = 200, offset = 0, session, tag, status, q } = {}) {
  const where = [];
  const params = [];
  if (session) { where.push('session_id = ?'); params.push(session); }
  if (status)  { where.push('status = ?'); params.push(Number(status)); }
  if (tag)     { where.push('tags LIKE ?'); params.push(`%"${tag}"%`); }
  if (q)       { where.push('(path LIKE ? OR preview LIKE ? OR model LIKE ? OR req_body LIKE ?)');
                 params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT ${LIST_COLS} FROM requests
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));
  return db.prepare(sql).all(...params).map(parseJsonCols);
}

function getRequest(id) {
  const row = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(Number(id));
  return row ? parseJsonCols(row) : null;
}

function allRequestsForExport() {
  return db.prepare(`SELECT * FROM requests ORDER BY id ASC`).all().map(parseJsonCols);
}

function stats() {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const total = one(`SELECT COUNT(*) n FROM requests`).n;
  const byStatus = db.prepare(`SELECT status, COUNT(*) n FROM requests GROUP BY status ORDER BY status`).all();
  const byTarget = db.prepare(`SELECT target, COUNT(*) n, AVG(duration_ms) avg_ms FROM requests GROUP BY target ORDER BY n DESC LIMIT 20`).all();
  const byModel  = db.prepare(`SELECT model, COUNT(*) n FROM requests WHERE model IS NOT NULL GROUP BY model ORDER BY n DESC LIMIT 20`).all();
  const byDay    = db.prepare(`SELECT substr(ts,1,10) day, COUNT(*) n, SUM(COALESCE(json_extract(usage,'$.total_tokens'),0)) tokens
                                FROM requests GROUP BY day ORDER BY day DESC LIMIT 30`).all();
  const tools    = db.prepare(`SELECT json_extract(je.value,'$.name') tag, COUNT(*) n
                                FROM requests r, json_each(r.tool_calls) je
                                WHERE json_valid(r.tool_calls) GROUP BY tag ORDER BY n DESC LIMIT 20`).all();
  const agg = one(`SELECT COUNT(*) n,
    COALESCE(AVG(duration_ms),0) avg_ms,
    COALESCE(MAX(duration_ms),0) max_ms,
    SUM(is_sse) sse_count,
    SUM(aborted) aborted_count,
    SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END) err_count,
    SUM(req_size) req_bytes, SUM(res_size) res_bytes,
    SUM(COALESCE(json_extract(usage,'$.prompt_tokens'),0)) prompt_tokens,
    SUM(COALESCE(json_extract(usage,'$.completion_tokens'),0)) completion_tokens,
    SUM(COALESCE(json_extract(usage,'$.total_tokens'),0)) total_tokens
    FROM requests`);
  return { total, ...agg, byStatus, byTarget, byModel, byDay, tools };
}

function sessions(limit = 100) {
  return db.prepare(`
    SELECT session_id, COUNT(*) n,
           MIN(ts) first_ts, MAX(ts) last_ts,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors,
           SUM(is_sse) sse_n,
           SUM(COALESCE(json_extract(usage,'$.total_tokens'),0)) total_tokens,
           GROUP_CONCAT(DISTINCT model) models
    FROM requests WHERE session_id IS NOT NULL
    GROUP BY session_id ORDER BY MAX(id) DESC LIMIT ?`).all(Number(limit)).map(r => ({
    ...r, models: r.models ? r.models.split(',').filter(Boolean) : [],
  }));
}

// ---------- 配置 ----------
const DEFAULT_PRESETS = [
  { name: 'openai',   base_url: 'https://api.openai.com' },
  { name: 'deepseek', base_url: 'https://api.deepseek.com' },
  { name: 'kimi',     base_url: 'https://api.moonshot.cn' },
  { name: 'gemini',   base_url: 'https://generativelanguage.googleapis.com' },
  { name: 'claude',   base_url: 'https://api.anthropic.com' },
  { name: 'ollama',   base_url: 'http://127.0.0.1:11434' },
];

function getConfig() {
  const rows = db.prepare(`SELECT key, value FROM config`).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let presets;
  try { presets = map.presets ? JSON.parse(map.presets) : null; } catch { presets = null; }
  let vmcpTools;
  try { vmcpTools = map.vmcp_tools ? JSON.parse(map.vmcp_tools) : []; } catch { vmcpTools = []; }
  const bitKey = map.bit_key || '';
  return {
    default_target: map.default_target || process.env.ADB_DEFAULT_TARGET || '',
    presets: presets && Array.isArray(presets) ? presets : DEFAULT_PRESETS,
    inject_system: map.inject_system === '1',
    inject_text: map.inject_text !== undefined && map.inject_text !== ''
      ? map.inject_text : '你现在可以主动发送一条信息',
    vmcp_tools: Array.isArray(vmcpTools) ? vmcpTools : [],
    // BIT 联动：Client Key 只存本机，不回传面板（仅脱敏提示）
    bit_url: map.bit_url || '',
    bit_key_set: !!bitKey,
    bit_key_hint: bitKey ? bitKey.slice(0, 6) + '…(' + bitKey.length + ')' : '',
    bit_pwd_set: !!map.bit_pwd,
  };
}

// 内部专用：BIT 联动代理需要完整凭据。绝不通过 /api/config 返回（那里只给脱敏提示）
function getBitCredentials() {
  const rows = db.prepare(`SELECT key, value FROM config WHERE key IN ('bit_key','bit_pwd')`).all();
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { bit_key: map.bit_key || '', bit_pwd: map.bit_pwd || '' };
}

function setConfig(patch) {
  const set = (k, v) => db.prepare(`INSERT INTO config(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
  if (patch.default_target !== undefined) set('default_target', String(patch.default_target || ''));
  if (patch.inject_system !== undefined) set('inject_system', patch.inject_system ? '1' : '0');
  if (patch.inject_text !== undefined) set('inject_text', String(patch.inject_text || ''));
  if (Array.isArray(patch.presets)) {
    const clean = patch.presets
      .filter(p => p && String(p.name || '').trim() && String(p.base_url || '').trim())
      .map(p => ({ name: String(p.name).trim(), base_url: String(p.base_url).trim() }));
    set('presets', JSON.stringify(clean));
  }
  if (Array.isArray(patch.vmcp_tools)) {
    // 虚拟 MCP 自定义工具：name/description 必填，mode ∈ {fixed, manual}，fixed 携带 result
    const clean = patch.vmcp_tools
      .filter(t => t && String(t.name || '').trim())
      .map(t => ({
        name: String(t.name).trim(),
        description: String(t.description || ''),
        mode: t.mode === 'manual' ? 'manual' : 'fixed',
        result: t.result !== undefined ? String(t.result ?? '') : '',
        inputSchema: (t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object')
          ? t.inputSchema : { type: 'object', properties: {} },
      }));
    set('vmcp_tools', JSON.stringify(clean));
  }
  if (patch.bit_url !== undefined) set('bit_url', String(patch.bit_url || '').trim());
  if (patch.bit_key !== undefined) set('bit_key', String(patch.bit_key || '').trim());
  if (patch.bit_pwd !== undefined) set('bit_pwd', String(patch.bit_pwd || '').trim());
  return getConfig();
}

function clearAll() {
  db.exec(`DELETE FROM requests`);
}

function integrity() {
  return db.prepare(`PRAGMA integrity_check`).get();
}

function parseJsonCols(row) {
  for (const k of ['req_headers', 'res_headers', 'tags', 'tools', 'tool_calls', 'usage']) {
    if (typeof row[k] === 'string') {
      try { row[k] = JSON.parse(row[k]); } catch { /* 保持原样 */ }
    }
  }
  return row;
}

module.exports = { open, insertRequest, listRequests, getRequest, allRequestsForExport, stats, sessions, getConfig, getBitCredentials, setConfig, clearAll, integrity };
