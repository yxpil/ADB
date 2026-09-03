// 虚拟 MCP 服务器（Streamable HTTP / JSON-RPC 2.0，与 BIT 的 MCP 客户端完全兼容）
// - 端点：POST /mcp（BIT 侧把服务器 URL 填成 http://127.0.0.1:<port>/mcp）
// - initialize → Mcp-Session-Id → notifications/initialized(202) → tools/list → tools/call
// - 工具来源：内置 echo/add/now + 面板自定义（mode: fixed 固定结果 / manual 人工应答=扮演 AI）
// - 每笔 JSON-RPC 全量入库（tags: mcp / mcp:<method> / tool:<name>，由 server 端补 'mcp' 基础 tag）
'use strict';
const { hold, respond, list } = require('./virtual');

const PROTOCOL_VERSION = '2025-03-26';
const SESSION = 'adb-virtual-mcp-session';

const BUILTIN_TOOLS = [
  {
    name: 'echo', description: 'Echo back the input message (connectivity test)',
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'text to echo' } }, required: ['message'] },
  },
  {
    name: 'add', description: 'Add two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  {
    name: 'now', description: 'Return the server current time',
    inputSchema: { type: 'object', properties: {} },
  },
];

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

// 工具清单 = 内置 + 用户自定义（DB config vmcp_tools）
function allTools(cfg) {
  const custom = Array.isArray(cfg.vmcp_tools) ? cfg.vmcp_tools : [];
  return [...BUILTIN_TOOLS, ...custom.filter(t => t && t.name).map(t => ({
    name: String(t.name), description: String(t.description || ''),
    inputSchema: (t.inputSchema && typeof t.inputSchema === 'object') ? t.inputSchema : { type: 'object', properties: {} },
  }))];
}

// 写回 JSON。body 由调用方序列化；入库由调用方显式调 done
function finish(res, payload, status, contentType, extraHeaders) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = { 'content-type': contentType, 'content-length': Buffer.byteLength(body), ...(extraHeaders || {}) };
  res.writeHead(status, headers);
  res.end(body);
  return body;
}

// 主入口：server.js 挂载在 POST /mcp。
// record(status, resBodyText, started, reqText, extraTags) 负责入库（server.js 提供）
function handle(req, res, url, cfg, record) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ server: 'ADB Virtual MCP', protocol: 'streamable-http', endpoint: '/mcp', tools: allTools(cfg).map(t => t.name) }));
  }
  if (req.method !== 'POST') { res.writeHead(405); return res.end('method not allowed'); }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const started = Date.now();
    const reqText = Buffer.concat(chunks).toString('utf8');
    let rpc = null;
    try { rpc = JSON.parse(reqText); } catch {}
    if (!rpc || typeof rpc !== 'object') {
      record(400, 'invalid json', started, reqText, ['mcp', 'error']);
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('invalid json');
    }
    const method = String(rpc.method || '');
    const params = rpc.params || {};
    const isNotify = rpc.id === undefined || rpc.id === null;

    // 入库：record(status, resBodyText, tags)
    const done = (status, resBody, tags) => record(status, resBody, started, reqText, ['mcp', ...(tags || [])]);
    // 写回 JSON 并入库
    const reply = (payload, status, tags, extraHeaders) =>
      done(status ?? 200, finish(res, payload, status ?? 200, 'application/json; charset=utf-8', extraHeaders), tags);

    // initialize：握手（BIT 要求 result.protocolVersion / capabilities / serverInfo + Mcp-Session-Id 头）
    if (method === 'initialize') {
      return reply(rpcResult(rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'ADB Virtual MCP', version: '0.1.0' },
      }), 200, ['mcp:initialize'], { 'Mcp-Session-Id': SESSION });
    }
    // 通知：无响应体，202
    if (isNotify || method.startsWith('notifications/')) {
      res.writeHead(202, { 'content-type': 'text/plain' });
      res.end();
      return done(202, '', ['mcp:notify']);
    }
    // tools/list
    if (method === 'tools/list') {
      return reply(rpcResult(rpc.id, { tools: allTools(cfg) }), 200, ['mcp:tools/list']);
    }
    // tools/call
    if (method === 'tools/call') {
      const name = String(params.name || '');
      const args = params.arguments || {};
      const wrap = (text, isError) => rpcResult(rpc.id, { content: [{ type: 'text', text }], isError: !!isError });
      const toolTags = ['mcp:tools/call', 'tool:' + name];

      // 内置工具：真实计算（与 BIT e2e fake MCP 行为对齐）
      if (name === 'echo') return reply(wrap(`ECHO<${args.message ?? ''}>`), 200, toolTags);
      if (name === 'add') {
        const a = Number(args.a), b = Number(args.b);
        if (Number.isNaN(a) || Number.isNaN(b)) return reply(wrap('arguments a/b must be numbers', true), 200, toolTags);
        const s = a + b;
        return reply(wrap(`SUM=${Number.isInteger(s) ? s : +s.toFixed(6)}`), 200, toolTags);
      }
      if (name === 'now') return reply(wrap(`NOW=${new Date().toLocaleString('sv-SE')}`), 200, toolTags);

      const custom = (cfg.vmcp_tools || []).find(t => t && t.name === name);
      if (!custom) {
        return reply(wrap(`unknown tool ${name}`, true), 200, [...toolTags, 'error']);
      }
      // fixed：固定结果
      if (custom.mode !== 'manual') {
        return reply(wrap(String(custom.result ?? '')), 200, toolTags);
      }
      // manual：人工应答（扮演 AI）——挂起等面板回复
      const pendingMeta = { kind: 'mcp', tool_name: name, tool_args: args, rpc_id: rpc.id ?? null, preview: JSON.stringify(args).slice(0, 200) };
      const write = (r, answer) => {
        if (answer && answer.__timeout) {
          return done(200, finish(r, rpcError(rpc.id, -32000, 'virtual tool call timeout: no manual response'), 200, 'application/json; charset=utf-8'), [...toolTags, 'error']);
        }
        done(200, finish(r, wrap(String(answer.text ?? ''), !!answer.is_error), 200, 'application/json; charset=utf-8'), toolTags);
      };
      hold('mcp', res, pendingMeta, write);
      return;
    }
    // 未知方法
    return reply(rpcError(rpc.id, -32601, `method not found: ${method}`), 200, ['mcp:unknown', 'error']);
  });
}

module.exports = { handle, allTools, listPending: () => list('mcp'), respond };
