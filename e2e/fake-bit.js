// 假 BIT：e2e 测试用的 BIT 远程访问接口模拟器（对齐 BIT http_api.rs 的 /api/* 行为）
// 双重认证：Bearer Client Key + X-Access-Password（与真实 BIT 一致，缺一 401）
// 端点：
//   GET  /api/health                 免认证
//   GET  /api/debug/state            运行快照（密钥脱敏）
//   GET  /api/tools                  工具注册表
//   GET  /api/debug/mcp              MCP 服务器与导入工具
//   GET  /api/audit                  审计日志
//   GET  /api/debug/sessions         会话列表
//   GET  /api/debug/sessions/:id     会话详情（未知 id → 404）
//   POST /api/chat                   Agent 对话（回显 message，模拟工具循环）
//   POST /api/tools/:id/invoke       工具直调（未知工具 → 404）
'use strict';
const http = require('http');

const PORT = Number(process.env.FAKE_BIT_PORT || 9912);
const CLIENT_KEY = 'bit_e2e_client_key_0001';
const PASSWORD = 'pwd-e2e-8888';

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// 与真实 BIT 相同的认证语义：/api/health 免认证；其余必须双凭据
function checkAuth(req, path) {
  if (path === '/api/health') return null;
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (bearer !== CLIENT_KEY) return 401;
  if ((req.headers['x-access-password'] || '') !== PASSWORD) return 401;
  return null;
}

const STATE = {
  version: '0.5.0-e2e',
  remote: { port: 9921, access_password_enabled: true },
  provider: { name: 'e2e-provider', protocol: 'openai', model: 'fake-model', base_url: 'http://127.0.0.1:9911', api_key_hint: 'sk_e2e…(16)' },
  reasoning_effort: 'medium',
  tools: { count: 3, names: ['shell', 'add_tool', 'now'] },
  mcp: {
    count: 1,
    servers: [{ id: 'mcp-1', name: 'ADB 虚拟 MCP', url: 'http://127.0.0.1:8987/mcp', enabled: true, protocol: 'streamable-http', version: '2025-03-26' }],
  },
  sessions: { count: 2, active: 's-1', messages: 5 },
  memories: 4,
  skills: 2,
};

const SESSIONS = [
  { id: 's-1', title: 'E2E 会话一', created: '2026-09-04T00:00:00Z', updated: '2026-09-04T01:00:00Z', messages: 3, preview: 'E2E 会话一预览' },
  { id: 's-2', title: 'E2E 会话二', created: '2026-09-04T00:30:00Z', updated: '2026-09-04T00:40:00Z', messages: 2, preview: 'E2E 会话二预览' },
];

const SESSION_DETAIL = {
  's-1': {
    id: 's-1', title: 'E2E 会话一', created: '2026-09-04T00:00:00Z', updated: '2026-09-04T01:00:00Z',
    messages: [
      { role: 'user', content: 'E2E-BIT-Q1' },
      { role: 'assistant', content: 'E2E-BIT-A1', tool_calls: [{ id: 'call_1', function: { name: 'shell', arguments: '{"command":"echo hi"}' } }] },
      { role: 'user', content: 'E2E-BIT-Q2' },
    ],
  },
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const authFail = checkAuth(req, p);
    if (authFail) {
      return json(res, authFail, { error: authFail === 401
        ? { message: '无效的 API Key（BIT Client Key）', type: 'invalid_request_error', code: 'invalid_api_key' }
        : 'unauthorized' });
    }
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = bodyText ? JSON.parse(bodyText) : {}; } catch {}

    if (req.method === 'GET') {
      if (p === '/api/health') return json(res, 200, { ok: true });
      if (p === '/api/debug/state') return json(res, 200, STATE);
      if (p === '/api/tools') {
        return json(res, 200, {
          tools: STATE.tools.names.map((n, i) => ({ id: 't' + (i + 1), name: n, kind: 'builtin', enabled: true })),
        });
      }
      if (p === '/api/debug/mcp') {
        return json(res, 200, { servers: [{ ...STATE.mcp.servers[0], connected_at: '2026-09-04T00:00:00Z', tools: ['echo', 'add'] }] });
      }
      if (p === '/api/audit') {
        return json(res, 200, { entries: [{ ts: '2026-09-04T01:00:00Z', actor: 'user', action: 'chat', target: 's-1', ok: true }] });
      }
      if (p === '/api/debug/sessions') return json(res, 200, { active: 's-1', sessions: SESSIONS });
      const mSession = p.match(/^\/api\/debug\/sessions\/([A-Za-z0-9_-]+)$/);
      if (mSession) {
        const s = SESSION_DETAIL[mSession[1]];
        return s ? json(res, 200, s) : json(res, 404, { error: 'session not found' });
      }
    }

    if (req.method === 'POST') {
      if (p === '/api/chat') {
        const message = String(body.message || '');
        if (!message.trim()) return json(res, 400, { error: 'message is empty' });
        return json(res, 200, {
          session_id: body.session_id || 's-1',
          reply: 'BIT-REPLY<' + message + '>',
          tool_used: message.includes('E2E-BIT-TOOL') ? 'shell' : null,
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        });
      }
      const mTool = p.match(/^\/api\/tools\/([A-Za-z0-9_-]+)\/invoke$/);
      if (mTool) {
        if (!STATE.tools.names.includes(mTool[1])) return json(res, 404, { error: 'tool not found' });
        return json(res, 200, { ok: true, tool: mTool[1], result: 'TOOL-OK<' + JSON.stringify(body.args ?? body) + '>' });
      }
    }

    json(res, 404, { error: 'not found' });
  });
});

if (require.main === module) server.listen(PORT, '127.0.0.1', () => console.log(`fake-bit on ${PORT}`));
module.exports = { server, PORT, CLIENT_KEY, PASSWORD };
