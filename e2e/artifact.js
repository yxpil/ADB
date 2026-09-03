// 最终产物 E2E：对「打包后的 BIT.app」与「打包后的 ADB 包」做真实联动测试
// 前置：ADB 产物解压目录 + BIT 构建出的 .app 二进制
// 用法：node e2e/artifact.js <ADB产物目录> <BIT可执行文件路径>
// 隔离：BIT_DATA_DIR 种子化配置（远程访问 + ADB mock 上游），不碰真实用户数据
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ADB_PKG = process.argv[2];
const BIT_BIN = process.argv[3];
if (!ADB_PKG || !BIT_BIN || !fs.existsSync(path.join(ADB_PKG, 'server.js')) || !fs.existsSync(BIT_BIN)) {
  console.error('用法: node e2e/artifact.js <ADB产物目录> <BIT可执行文件>');
  process.exit(2);
}

const BIT_PORT = 8701;
const ADB_PORT = 8993;
const BIT_KEY = 'bit_artifact_e2e_0001';
const BIT_PWD = '44556677';
const BIT_URL = `http://127.0.0.1:${BIT_PORT}`;
const ADB_URL = `http://127.0.0.1:${ADB_PORT}`;
const BIT_DATA = '/tmp/bit-artifact-e2e';

let pass = 0, fail = 0;
function record(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}  ${detail ?? ''}`); }
}

function req(base, method, p, { body, headers } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(base + p, {
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ code: res.statusCode, buf: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', e => resolve({ code: 0, buf: '', err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ code: 0, buf: '', err: 'timeout' }); });
    if (payload) r.write(payload);
    r.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

function seedBitData() {
  fs.rmSync(BIT_DATA, { recursive: true, force: true });
  fs.mkdirSync(BIT_DATA, { recursive: true });
  fs.writeFileSync(path.join(BIT_DATA, 'config.json'), JSON.stringify({
    remote_enabled: true, host: '127.0.0.1', port: BIT_PORT,
    client_key: BIT_KEY, access_password: BIT_PWD, password_enabled: true,
    revision: 1, tool_approval: 'allow_all',
  }));
  fs.writeFileSync(path.join(BIT_DATA, 'ai_config.json'), JSON.stringify({
    providers: [{
      id: 'p1', name: 'ADB-Mock', protocol: 'openai',
      base_url: `${ADB_URL}/mock/chat`, api_key: 'sk-noop', model: 'mock-chat', active: true,
    }],
    reasoning_effort: '', temperature: null,
  }));
}

(async () => {
  // ── 启动 ADB 产物实例 ──
  const adb = spawn(process.execPath, ['server.js'], {
    cwd: ADB_PKG,
    env: { ...process.env, PORT: String(ADB_PORT), ADB_DB: '/tmp/adb-artifact-e2e/adb.db', ADB_INSTANCE_TOKEN: 'artifact-token' },
    stdio: 'ignore',
  });
  const adbUp = await until(async () => {
    const r = await req(ADB_URL, 'GET', '/api/health');
    return r.code === 200 && JSON.parse(r.buf).token === 'artifact-token';
  }, 10000);
  record('ADB 产物实例启动（含实例 token 回显）', adbUp);

  // ── 启动打包的 BIT.app ──
  seedBitData();
  const bit = spawn(BIT_BIN, [], {
    env: { ...process.env, BIT_DATA_DIR: BIT_DATA },
    stdio: 'ignore',
  });
  const bitUp = await until(async () => {
    const r = await req(BIT_URL, 'GET', '/api/health');
    return r.code === 200;
  }, 30000);
  record('BIT 打包产物启动（远程访问就绪）', bitUp);
  if (!bitUp) {
    adb.kill(); bit.kill(); process.exit(1);
  }

  const bitHeaders = { authorization: `Bearer ${BIT_KEY}`, 'x-access-password': BIT_PWD };

  // ── 1. 直连打包 BIT 的调试接口 ──
  {
    const st = await req(BIT_URL, 'GET', '/api/debug/state', { headers: bitHeaders });
    const stBody = JSON.parse(st.buf);
    record('产物 debug/state：版本 0.5.0', st.code === 200 && stBody.version === '0.5.0', st.buf.slice(0, 120));
    record('产物 debug/state：Provider 密钥脱敏', typeof stBody.provider?.api_key_hint === 'string' && stBody.provider.api_key_hint.includes('…'), stBody.provider?.api_key_hint);
    record('产物 debug/sessions', (await req(BIT_URL, 'GET', '/api/debug/sessions', { headers: bitHeaders })).code === 200);
    record('产物 debug/mcp', (await req(BIT_URL, 'GET', '/api/debug/mcp', { headers: bitHeaders })).code === 200);
    record('产物 认证边界：缺密码 401', (await req(BIT_URL, 'GET', '/api/debug/state', { headers: { authorization: `Bearer ${BIT_KEY}` } })).code === 401);
    record('产物 认证边界：错 Key 401', (await req(BIT_URL, 'GET', '/api/debug/state', { headers: { authorization: 'Bearer wrong', 'x-access-password': BIT_PWD } })).code === 401);

    // 直连对话：BIT → ADB 产物 /mock/chat（上游流量落在 ADB 产物记录里）
    const chat = await req(BIT_URL, 'POST', '/api/chat', { headers: bitHeaders, body: { message: '产物直连对话' } });
    const chatBody = JSON.parse(chat.buf);
    record('产物 /api/chat 经 mock 上游回答', chat.code === 200 && typeof chatBody.reply === 'string' && chatBody.reply.includes('产物直连对话'), chat.buf.slice(0, 150));
    await sleep(400);
    const mockRecs = JSON.parse((await req(ADB_URL, 'GET', '/api/records?limit=5&tag=mock')).buf);
    const mockRec = mockRecs.find(r => (r.path || '').includes('chat/completions'));
    record('BIT 上游流量落在 ADB 产物记录（tag=mock）', !!mockRec, JSON.stringify(mockRecs.map(r => r.path)));

    // 会话分析：对话内容可追溯
    const sessions = JSON.parse((await req(BIT_URL, 'GET', '/api/debug/sessions', { headers: bitHeaders })).buf);
    const sid = sessions.active || sessions.sessions?.[0]?.id;
    const detail = JSON.parse((await req(BIT_URL, 'GET', `/api/debug/sessions/${sid}`, { headers: bitHeaders })).buf);
    record('产物 会话详情含完整对话', detail.messages?.some(m => m.content === '产物直连对话') === true
      && detail.messages?.some(m => (m.content || '').includes('[mock]')), JSON.stringify(detail).slice(0, 120));

    // 审计
    const audit = JSON.parse((await req(BIT_URL, 'GET', '/api/audit', { headers: bitHeaders })).buf);
    record('产物 审计含 chat.remote', audit.entries?.some(e => e.action === 'chat.remote') === true, JSON.stringify(audit).slice(0, 120));
  }

  // ── 2. 产物对产物：ADB 产物控制打包 BIT ──
  {
    await req(ADB_URL, 'POST', '/api/config', { body: { bit_url: BIT_URL, bit_key: BIT_KEY, bit_pwd: BIT_PWD } });
    const cfg = JSON.parse((await req(ADB_URL, 'GET', '/api/config')).buf);
    record('ADB 产物：BIT 凭据脱敏', !JSON.stringify(cfg).includes(BIT_KEY) && !!cfg.bit_key_hint, cfg.bit_key_hint);

    const st = JSON.parse((await req(ADB_URL, 'GET', '/api/bit/state')).buf);
    record('ADB 产物 → BIT 产物：state 代理', st.version === '0.5.0', JSON.stringify(st).slice(0, 100));

    const chat = await req(ADB_URL, 'POST', '/api/bit/chat', { body: { message: '产物经ADB驱动' } });
    const chatBody = JSON.parse(chat.buf);
    record('ADB 产物 → BIT 产物：驱动对话', chat.code === 200 && typeof chatBody.reply === 'string' && chatBody.reply.includes('产物经ADB驱动'), chat.buf.slice(0, 150));

    const tools = JSON.parse((await req(ADB_URL, 'GET', '/api/bit/tools')).buf);
    record('ADB 产物 → BIT 产物：工具注册表', Array.isArray(tools.tools) && tools.tools.length > 0, JSON.stringify(tools).slice(0, 100));

    await sleep(400);
    const bitRecs = JSON.parse((await req(ADB_URL, 'GET', '/api/records?limit=10&tag=bit')).buf);
    record('ADB 产物：控制动作入库 bit:chat', bitRecs.some(r => r.path === '/api/bit/chat' && (r.tags || []).includes('bit:chat')), JSON.stringify(bitRecs.map(r => r.path)));

    // 错误凭据透传
    await req(ADB_URL, 'POST', '/api/config', { body: { bit_key: 'wrong-key' } });
    record('ADB 产物：错 Key → 401 透传', (await req(ADB_URL, 'GET', '/api/bit/state')).code === 401);
    await req(ADB_URL, 'POST', '/api/config', { body: { bit_key: BIT_KEY } });
  }

  // ── 收尾 ──
  bit.kill('SIGTERM');
  adb.kill('SIGTERM');
  await sleep(500);
  console.log(`\n==== artifact ${pass}/${pass + fail} passed ====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('artifact runner error:', e); process.exit(1); });
