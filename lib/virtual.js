// 虚拟调试基础设施：待应答队列（人工扮演 AI / 人工应答 MCP 工具调用）
// - hold(): 挂起一个 HTTP 响应，进入待应答队列（面板可见）
// - respond(): 面板/API 应答后按类型写回客户端（JSON / SSE 事件流 / JSON-RPC 结果）
// - 超时兜底：超时后返回错误并入库，不悬挂
'use strict';
const crypto = require('crypto');

const TIMEOUT_MS = Number(process.env.ADB_VIRTUAL_TIMEOUT) || 300000;

const pending = new Map();   // id -> { type, meta, res, timer, started, write }

// 挂起请求。write(res, answer) 由调用方提供（决定应答如何写回客户端）
function hold(type, res, meta, write) {
  const id = crypto.randomUUID().slice(0, 8);
  const entry = { type, meta, res, write, started: Date.now(), timer: null, onAbandon: meta.onAbandon || null };
  pending.set(id, entry);
  entry.timer = setTimeout(() => {
    if (!pending.has(id)) return;
    pending.delete(id);
    write(res, { __timeout: true });
  }, meta.timeout_ms || TIMEOUT_MS);
  // 客户端中途断开：直接出队并回调 onAbandon（由调用方决定是否记录）
  res.on('close', () => {
    if (pending.has(id)) {
      clearTimeout(entry.timer);
      pending.delete(id);
      meta.abandoned = true;
      if (entry.onAbandon) entry.onAbandon();
    }
  });
  return id;
}

// 应答。answer 由 UI/API 传入；返回是否成功
function respond(id, answer) {
  const e = pending.get(id);
  if (!e) return false;
  clearTimeout(e.timer);
  pending.delete(id);
  e.meta.answer = answer;
  e.write(e.res, answer);
  return true;
}

function list(type) {
  const out = [];
  for (const [id, e] of pending) {
    if (type && e.type !== type) continue;
    out.push({ id, type: e.type, ts: new Date(e.started).toISOString(), waited_ms: Date.now() - e.started, ...e.meta });
  }
  return out;
}

function count(type) { let n = 0; for (const e of pending.values()) if (!type || e.type === type) n++; return n; }

module.exports = { hold, respond, list, count, TIMEOUT_MS };
