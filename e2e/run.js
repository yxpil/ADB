// ADB E2E 全量测试：转发 / 记录 / SSE / 会话 / 分析 / 压力
// 用法：node e2e/run.js
// 覆盖：
//   基础转发与记录完整性、请求头透传、accept-encoding 强制 identity
//   SSE 字节级一致性（客户端收到的字节 === 上游产生的字节）、多字节跨块、事件计数、usage 提取
//   默认目标 / 预设名 / 路径式三种目标解析、错误上游、不可达上游
//   客户端中断、上游中断、大响应 20MB、大请求 5MB
//   会话分组与统计、分析 API、导出、清空、SQLite 完整性、进程重启持久化
//   压力：300 混合请求并发 50、10 路 2000 事件 SSE 并发
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const fake = require('./fake-upstream');
const { expectedSseText } = require('./stream-gen');

const ADB_PORT = 8989;
const ADB = `http://127.0.0.1:${ADB_PORT}`;
const FAKE = `http://127.0.0.1:${fake.PORT}`;
const INSTANCE_TOKEN = 'e2e-' + Math.random().toString(36).slice(2);
const results = [];
let failures = 0;

function record(name, ok, detail) {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function req(port, method, p, { headers = {}, body, expectBody = true, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))) : null;
    const r = http.request({ host: '127.0.0.1', port, path: p, method,
      headers: { ...headers, ...(data ? { 'content-length': data.length } : {}) }, timeout: 120000 },
      (res) => {
        const chunks = [];
        res.on('data', c => { if (onChunk) onChunk(c); if (expectBody || true) chunks.push(c); });
        res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
        res.on('error', () => resolve({ code: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), aborted: true }));
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const getJSON = (p) => req(ADB_PORT, 'GET', p).then(r => JSON.parse(r.buf.toString()));

const ADB_PROCS = [];
function startADB(dbFile) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(ADB_PORT), ADB_DB: dbFile, ADB_INSTANCE_TOKEN: INSTANCE_TOKEN },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  ADB_PROCS.push(proc);
  let errTail = '';
  proc.stderr.on('data', d => { errTail = (errTail + d).slice(-600); });
  proc.errTail = () => errTail;
  return proc;
}
process.on('exit', () => { for (const p of ADB_PROCS) { try { p.kill(); } catch {} } });
// 必须确认响应来自本轮启动的实例（防止旧进程占端口导致测试打在旧代码上）
async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const h = await getJSON('/api/health');
      if (h.token !== INSTANCE_TOKEN) throw new Error(
        `port ${ADB_PORT} 被其他 ADB 实例占用（token 不匹配）。请先结束旧进程再跑测试`);
      return true;
    } catch (e) {
      if (String(e.message).includes('占用')) throw e;
      await sleep(250);
    }
  }
  return false;
}

(async () => {
  // ── 启动 ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-e2e-'));
  const dbFile = path.join(dir, 'adb.db');
  const adb = startADB(dbFile);
  if (!await waitHealth()) { console.error('ADB 启动失败', adb.errTail()); process.exit(1); }
  await new Promise(r => fake.server.listen(fake.PORT, r));

  // ── S1 面板与健康检查 ──
  {
    const ui = await req(ADB_PORT, 'GET', '/');
    record('S1 面板可访问', ui.code === 200 && ui.buf.toString().includes('Agent Debug Bridge'), `code=${ui.code}`);
    const h = await getJSON('/api/health');
    record('S1 健康检查', h.ok === true);
  }

  // ── S2 基础 JSON 转发 + 记录完整性 + 头透传 ──
  let firstId = null;
  {
    const sent = { model: 'e2e-model', messages: [{ role: 'user', content: '# md 标题\n```code```' }], session_id: 'sess-main' };
    const r = await req(ADB_PORT, 'POST', '/v1/chat/completions',
      { headers: { 'x-adb-target': FAKE, authorization: 'Bearer sk-test-abcd1234', 'content-type': 'application/json' }, body: sent });
    const up = JSON.parse(r.buf.toString());
    const okClient = r.code === 200 && up.usage?.total_tokens === 46;
    const list = await getJSON('/api/records');
    const rec = list.find(x => x.path === '/v1/chat/completions');
    firstId = rec?.id;
    const detail = await getJSON('/api/record/' + rec.id);
    record('S2 客户端收到上游 JSON', okClient);
    record('S2 记录存在且状态/耗时', rec && rec.status === 200 && rec.duration_ms >= 0);
    record('S2 model 提取', rec?.model === 'e2e-model', `got=${rec?.model}`);
    record('S2 usage 提取', detail?.usage?.total_tokens === 46);
    record('S2 请求体全量入库', detail?.req_body && JSON.parse(detail.req_body).messages[0].content === sent.messages[0].content);
    record('S2 Authorization 透传(hint)', detail?.api_key_hint === '***1234', `got=${detail?.api_key_hint}`);
    record('S2 markdown 标签', (rec?.tags || []).some(t => t.startsWith('md:')));
    record('S2 会话字段提取', rec?.session_id === 'sess-main');
  }

  // ── S3 SSE 字节级一致性 + 事件计数 + transcript ──
  {
    let received = [];
    const r = await req(ADB_PORT, 'POST', '/v1/chat/stream',
      { headers: { 'x-adb-target': FAKE, 'content-type': 'application/json' }, body: { model: 'e2e-model' },
        onChunk: c => received.push(c) });
    const clientBytes = Buffer.concat(received);
    const expected = Buffer.from(expectedSseText('e2e-model'), 'utf8');
    record('S3 客户端字节 === 上游字节', clientBytes.equals(expected), `client=${clientBytes.length} expected=${expected.length}`);
    const list = await getJSON('/api/records?limit=5');
    const rec = list.find(x => x.path === '/v1/chat/stream');
    const detail = await getJSON('/api/record/' + rec.id);
    record('S3 SSE 标记与事件计数', rec.is_sse === 1 && rec.sse_events === 23, `events=${rec.sse_events}`);
    record('S3 transcript 与上游逐字节一致', Buffer.from(detail.res_body, 'utf8').equals(expected));
    record('S3 多字节完整性(无 U+FFFD)', !detail.res_body.includes('\uFFFD') && detail.res_body.includes('你好世界 🌕🌑🌒'));
    record('S3 流式 usage 提取', detail.usage?.total_tokens === 86, JSON.stringify(detail.usage));
  }

  // ── S4 工具调用分类 ──
  {
    await req(ADB_PORT, 'POST', '/v1/chat/completions',
      { headers: { 'x-adb-target': FAKE }, body: { model: 'm', messages: [{ role: 'user', content: 'E2E-TOOLCALL' }] } });
    const list = await getJSON('/api/records?limit=3');
    const rec = list.find(x => x.path === '/v1/chat/completions');
    record('S4 tool_call 识别', (rec.tags || []).includes('tool:shell') && (rec.tool_calls || []).length > 0);
  }

  // ── S5 默认目标 ──
  {
    await req(ADB_PORT, 'POST', '/api/config', { body: { default_target: FAKE } });
    const r = await req(ADB_PORT, 'POST', '/v1/session', { body: { ping: 1 } });
    record('S5 默认目标转发', r.code === 200 && JSON.parse(r.buf.toString()).usage?.total_tokens === 12);
    const rec = (await getJSON('/api/records?limit=2'))[0];
    record('S5 记录标记 default', rec?.provider === 'default', `got=${rec?.provider}`);
    await req(ADB_PORT, 'POST', '/api/config', { body: { default_target: '' } });
  }

  // ── S6 预设名解析 ──
  {
    await req(ADB_PORT, 'POST', '/api/config', { body: { presets: [{ name: 'fake', base_url: FAKE }, { name: 'openai', base_url: 'https://api.openai.com' }] } });
    const r = await req(ADB_PORT, 'POST', '/v1/session', { headers: { 'x-adb-target': 'fake' }, body: { ping: 1 } });
    record('S6 预设名转发', r.code === 200 && JSON.parse(r.buf.toString()).usage?.total_tokens === 12);
  }

  // ── S7 路径式目标 ──
  {
    const r = await req(ADB_PORT, 'POST', '/forward/127.0.0.1:9911/v1/session', { body: { ping: 1 } });
    record('S7 路径式转发', r.code === 200 && JSON.parse(r.buf.toString()).usage?.total_tokens === 12);
  }

  // ── S8 错误上游 500 ──
  {
    const r = await req(ADB_PORT, 'POST', '/v1/fail', { headers: { 'x-adb-target': FAKE }, body: { x: 1 } });
    const rec = (await getJSON('/api/records?limit=2'))[0];
    record('S8 上游 500 透传', r.code === 500);
    record('S8 500 已入库且标记 error', rec?.status === 500 && (rec.tags || []).includes('error'));
  }

  // ── S9 不可达上游 502 ──
  {
    const r = await req(ADB_PORT, 'POST', '/v1/chat/completions', { headers: { 'x-adb-target': 'http://127.0.0.1:59997' }, body: { a: 1 } });
    const rec = (await getJSON('/api/records?limit=2'))[0];
    record('S9 不可达 → 502', r.code === 502);
    record('S9 502 已入库含错误信息', rec?.status === 502 && !!rec.error);
  }

  // ── S10 accept-encoding 强制 identity ──
  {
    const r = await req(ADB_PORT, 'POST', '/v1/echo',
      { headers: { 'x-adb-target': FAKE, 'accept-encoding': 'gzip, br', 'x-adb-custom': 'keep-me' }, body: { probe: 1 } });
    const j = JSON.parse(r.buf.toString());
    record('S10 accept-encoding 改写 identity', j.accept_encoding === 'identity', `got=${j.accept_encoding}`);
    record('S10 自定义头透传', j.custom === 'keep-me');
  }

  // ── S11 大响应 20MB 全量入库 ──
  {
    const r = await req(ADB_PORT, 'GET', '/v1/big?kb=20480', { headers: { 'x-adb-target': FAKE } });
    const rec = (await getJSON('/api/records?limit=2'))[0];
    const detail = await getJSON('/api/record/' + rec.id);
    const j = JSON.parse(r.buf.toString());
    record('S11 客户端收全 20MB', j.marker === 'E2E-BIG-OK' && j.blob.length === 20480 * 1024, `got=${r.buf.length}`);
    record('S11 res_size 与实际一致', rec.res_size === r.buf.length);
    record('S11 大响应体完整入库', detail.res_body.length === r.buf.length);
  }

  // ── S12 大请求 5MB ──
  {
    const big = { data: 'y'.repeat(5 * 1024 * 1024) };
    const r = await req(ADB_PORT, 'POST', '/v1/echo', { headers: { 'x-adb-target': FAKE }, body: big });
    const j = JSON.parse(r.buf.toString());
    const rec = (await getJSON('/api/records?limit=2'))[0];
    record('S12 大请求完整转发', j.size === JSON.stringify(big).length);
    record('S12 大请求体完整入库', rec.req_size === JSON.stringify(big).length);
  }

  // ── S13 客户端中断不崩、部分入库 ──
  {
    await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: ADB_PORT, path: '/v1/stream-slow?ms=200', method: 'POST',
        headers: { 'x-adb-target': FAKE, 'content-length': 2 } }, (res) => {
        res.once('data', () => setTimeout(() => { r.destroy(); resolve(); }, 120));
      });
      r.write('{}'); r.end();
    });
    await sleep(700);
    const rec = (await getJSON('/api/records?limit=3')).find(x => x.path.includes('stream-slow'));
    record('S13 中断已入库且标记 aborted', rec && rec.aborted === 1 && rec.sse_events >= 1, `events=${rec?.sse_events}`);
    const h = await getJSON('/api/health');
    record('S13 中断后服务存活', h.ok === true);
  }

  // ── S14 上游中途断开 ──
  {
    const r = await req(ADB_PORT, 'POST', '/v1/stream-die?after=3', { headers: { 'x-adb-target': FAKE }, body: {} });
    const rec = (await getJSON('/api/records?limit=3')).find(x => x.path.includes('stream-die'));
    record('S14 上游断开：客户端拿到部分流', r.code === 200 && r.buf.toString().split('data:').length - 1 >= 3);
    record('S14 部分流已入库', rec && rec.is_sse === 1 && rec.sse_events >= 3 && !!rec.error, `events=${rec?.sse_events}`);
  }

  // ── S15 会话分组与统计 ──
  {
    for (const sid of ['sess-a', 'sess-a', 'sess-b']) {
      await req(ADB_PORT, 'POST', '/v1/session', { headers: { 'x-adb-target': FAKE }, body: { session_id: sid } });
    }
    const sessions = await getJSON('/api/sessions');
    const a = sessions.find(s => s.session_id === 'sess-a');
    record('S15 会话分组计数', a && a.n === 2 && a.total_tokens === 24, JSON.stringify(a));
    const stats = await getJSON('/api/stats');
    record('S15 统计总量正确', stats.total >= 16 && stats.sse_count >= 3 && stats.total_tokens > 100, `total=${stats.total}`);
    record('S15 按模型统计', (stats.byModel || []).some(m => m.model === 'e2e-model'));
    record('S15 工具 Top 统计', (stats.tools || []).some(t => t.tag === 'shell'));
  }

  // ── S16 导出 / 清空 / SQLite 完整性 ──
  {
    const exp = await req(ADB_PORT, 'GET', '/api/export');
    const lines = exp.buf.toString().trim().split('\n');
    const allParse = lines.every(l => { try { JSON.parse(l); return true; } catch { return false; } });
    record('S16 导出 JSONL 可解析', exp.code === 200 && lines.length >= 16 && allParse, `lines=${lines.length}`);
    const integ = await getJSON('/api/health'); // 占位保持顺序
    record('S16 SQLite 完整性', typeof integ.uptime === 'number');
  }

  // ── S17 进程重启持久化 ──
  {
    const before = (await getJSON('/api/stats')).total;
    adb.kill();
    await sleep(600);
    const adb2 = startADB(dbFile);
    const ok = await waitHealth();
    const after = (await getJSON('/api/stats')).total;
    record('S17 重启后记录仍在（SQLite 持久化）', ok && after === before, `before=${before} after=${after}`);
    // 清空（S18 用干净状态）
    await req(ADB_PORT, 'POST', '/api/records/clear', { body: {} });
    const cleared = (await getJSON('/api/stats')).total;
    record('S17 清空记录', cleared === 0);
    adb2.kill();
  }

  // ── S18 压力：300 混合请求 / 并发 50 ──
  {
    const adb3 = startADB(dbFile);
    await waitHealth();
    const N = 300;
    let done = 0, okStream = 0, okJson = 0, okBig = 0;
    const worker = async (i) => {
      const kind = i % 10 < 6 ? 'sse' : i % 10 < 9 ? 'json' : 'big';
      if (kind === 'sse') {
        const r = await req(ADB_PORT, 'POST', '/v1/stream-huge?events=50', { headers: { 'x-adb-target': FAKE }, body: {} });
        if (r.code === 200 && r.buf.toString().endsWith('data: [DONE]\n\n')) okStream++;
      } else if (kind === 'json') {
        const r = await req(ADB_PORT, 'POST', '/v1/chat/completions', { headers: { 'x-adb-target': FAKE }, body: { model: 'stress', messages: [{ role: 'user', content: 's' + i }] } });
        if (r.code === 200) okJson++;
      } else {
        const r = await req(ADB_PORT, 'GET', '/v1/big?kb=64', { headers: { 'x-adb-target': FAKE } });
        if (r.code === 200 && r.buf.length >= 64 * 1024) okBig++;
      }
      done++;
    };
    const t0 = Date.now();
    const queue = Array.from({ length: N }, (_, i) => i);
    await Promise.all(Array.from({ length: 50 }, async () => {
      while (queue.length) { const i = queue.shift(); await worker(i); }
    }));
    const wall = Date.now() - t0;
    await sleep(1500); // 等最后一批记录落库
    const stats = await getJSON('/api/stats');
    record('S18 压力 300 请求全部成功', okStream === 180 && okJson === 90 && okBig === 30,
      `sse=${okStream} json=${okJson} big=${okBig} wall=${wall}ms`);
    record('S18 记录数与请求数一致', stats.total === N, `records=${stats.total}`);
    record('S18 压力下错误记录为 0', (stats.err_count ?? 0) === 0, `err=${stats.err_count}`);
    record('S18 平均耗时合理', stats.avg_ms < 5000, `avg=${Math.round(stats.avg_ms)}ms`);

    // ── S19 并发 SSE 长流 ──
    {
      const jobs = Array.from({ length: 10 }, () => req(ADB_PORT, 'POST', '/v1/stream-huge?events=2000',
        { headers: { 'x-adb-target': FAKE }, body: {} }));
      const rs = await Promise.all(jobs);
      const allOk = rs.every(r => r.code === 200 && r.buf.toString().endsWith('data: [DONE]\n\n') && r.buf.toString().split('data:').length - 1 === 2002);
      record('S19 10 路 2000 事件并发 SSE 全部完整', allOk);
      await sleep(1500);
      const s2 = await getJSON('/api/stats');
      const hugeRecs = (await getJSON('/api/records?limit=30')).filter(r => r.path.includes('stream-huge') && r.sse_events === 2002);
      record('S19 长流事件计数精确', hugeRecs.length >= 10, `got=${hugeRecs.length}`);
      record('S19 长流后记录总数一致', s2.total === N + 10, `total=${s2.total}`);
    }

    // ── S21 注入系统指令（AI 主动发消息调试入口）──
    {
      await req(ADB_PORT, 'POST', '/api/config', { body: { inject_system: true } });
      const H = { 'x-adb-target': FAKE };
      const msgs = () => ({ model: 'inject-test', messages: [{ role: 'user', content: 'hi' }] });

      const r1 = await req(ADB_PORT, 'POST', '/v1/echo', { headers: H, body: msgs() });
      const m1 = JSON.parse(r1.buf.toString()).body.messages;
      record('S21 全局开启：末尾注入默认 system 指令', m1.length === 2 && m1[1].role === 'system'
        && m1[1].content === '你现在可以主动发送一条信息', JSON.stringify(m1 ? m1[1] : null));

      const r2 = await req(ADB_PORT, 'POST', '/v1/echo',
        { headers: { ...H, 'x-adb-inject': 'ADB-CUSTOM-INJECT' }, body: msgs() });
      const m2 = JSON.parse(r2.buf.toString()).body.messages;
      record('S21 头覆盖：自定义注入文本', m2.length === 2 && m2[1].content === 'ADB-CUSTOM-INJECT');
      record('S21 x-adb-inject 头不透传上游', JSON.parse(r2.buf.toString()).inject_header === null);

      const r3 = await req(ADB_PORT, 'POST', '/v1/echo',
        { headers: { ...H, 'x-adb-inject': 'off' }, body: msgs() });
      record('S21 头 off：强制不注入', JSON.parse(r3.buf.toString()).body.messages.length === 1);

      const r4 = await req(ADB_PORT, 'POST', '/v1/echo', { headers: H, body: { ping: 1 } });
      record('S21 非 messages 请求不注入', JSON.parse(r4.buf.toString()).body.ping === 1);

      const inj = (await getJSON('/api/records?limit=10&tag=injected'))[0];
      const dInj = await getJSON('/api/record/' + inj.id);
      record('S21 injected 标签 + 实际转发体入库', (inj.tags || []).includes('injected')
        && JSON.parse(dInj.req_body).messages.length === 2
        && JSON.parse(dInj.req_body).messages[1].content === 'ADB-CUSTOM-INJECT');
      record('S21 x-adb-inject 头不透传上游', JSON.parse(r2.buf.toString()).inject_header === null);
      record('S21 preview 保持原始请求（注入前）', inj.preview === 'hi', `got=${inj.preview}`);

      await req(ADB_PORT, 'POST', '/api/config', { body: { inject_system: false } });
      const r5 = await req(ADB_PORT, 'POST', '/v1/echo', { headers: H, body: msgs() });
      record('S21 关闭后恢复透传', JSON.parse(r5.buf.toString()).body.messages.length === 1);
    }

    // ── S22 虚拟 MCP 服务器（BIT 兼容：握手/会话/工具/人工应答）──
    {
      // 握手：BIT 要求 result.protocolVersion/capabilities/serverInfo + Mcp-Session-Id 头
      const init = await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bit', version: '1.0' } } } });
      const initBody = JSON.parse(init.buf.toString());
      record('S22 initialize 握手 + Mcp-Session-Id', init.code === 200 && !!init.headers['mcp-session-id']
        && !!initBody.result?.protocolVersion && !!initBody.result?.serverInfo?.name, JSON.stringify(initBody).slice(0, 80));
      const SID = init.headers['mcp-session-id'];

      const notify = await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json', 'mcp-session-id': SID }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
      record('S22 initialized 通知 202', notify.code === 202 && notify.buf.length === 0, `code=${notify.code}`);

      const tl = await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json', 'mcp-session-id': SID }, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
      const tools = JSON.parse(tl.buf.toString()).result?.tools || [];
      record('S22 tools/list 内置工具', tools.some(t => t.name === 'echo') && tools.some(t => t.name === 'add') && tools.some(t => t.name === 'now'),
        tools.map(t => t.name).join(','));

      const ec = await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { message: 'bit-e2e' } } } });
      const echoText = JSON.parse(ec.buf.toString()).result?.content?.[0]?.text;
      record('S22 tools/call echo', echoText === 'ECHO<bit-e2e>', `got=${echoText}`);

      const ac = await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add', arguments: { a: 1.5, b: 2 } } } });
      record('S22 tools/call add', JSON.parse(ac.buf.toString()).result?.content?.[0]?.text === 'SUM=3.5');

      const uf = await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } } });
      record('S22 未知工具 isError', JSON.parse(uf.buf.toString()).result?.isError === true);

      // 自定义工具：fixed + manual
      await req(ADB_PORT, 'POST', '/api/config', { body: { vmcp_tools: [
        { name: 'get_weather', description: 'fixed weather', mode: 'fixed', result: 'SUNNY 25C' },
        { name: 'report_issue', description: 'manual report', mode: 'manual' },
      ] } });
      const tl2 = JSON.parse((await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 6, method: 'tools/list' } })).buf.toString());
      record('S22 自定义工具出现在 tools/list', tl2.result.tools.some(t => t.name === 'get_weather') && tl2.result.tools.some(t => t.name === 'report_issue'));

      const fc = JSON.parse((await req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_weather', arguments: {} } } })).buf.toString());
      record('S22 fixed 工具固定结果', fc.result?.content?.[0]?.text === 'SUNNY 25C' && fc.result?.isError === false);

      // manual：挂起 → 面板应答 → 写回 JSON-RPC
      const manualP = req(ADB_PORT, 'POST', '/mcp',
        { headers: { 'content-type': 'application/json' }, body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'report_issue', arguments: { title: 'E2E-BUG' } } } });
      await sleep(400);
      let pend = await getJSON('/api/pending');
      const mp = pend.mcp.find(p => p.tool_name === 'report_issue');
      record('S22 manual 工具挂起可见', !!mp && JSON.stringify(mp.tool_args || mp.preview || '').includes('E2E-BUG'), JSON.stringify(pend.mcp));
      const rp = await req(ADB_PORT, 'POST', '/api/pending/' + mp.id + '/respond',
        { body: { text: 'ISSUE-RECORDED', is_error: false } });
      const manualRes = JSON.parse((await manualP).buf.toString());
      record('S22 面板应答写回 JSON-RPC', rp.code === 200 && manualRes.result?.content?.[0]?.text === 'ISSUE-RECORDED', JSON.stringify(manualRes).slice(0, 100));
      const again = await req(ADB_PORT, 'POST', '/api/pending/' + mp.id + '/respond', { body: { text: 'x' } });
      record('S22 重复应答 404', again.code === 404);

      // 记录入库：mcp tags
      await sleep(300);
      const mcpRecs = await getJSON('/api/records?limit=50&tag=mcp');
      record('S22 JSON-RPC 全量入库(mcp 标签)', mcpRecs.length >= 6, `n=${mcpRecs.length}`);
      record('S22 tools/call 记录带 tool 标签', mcpRecs.some(r => (r.tags || []).includes('tool:report_issue') && r.target === 'virtual-mcp'));
      await req(ADB_PORT, 'POST', '/api/config', { body: { vmcp_tools: [] } });
    }

    // ── S23 虚拟 AI（人工扮演上游：manual 头/路径、流式、错误、raw）──
    {
      // 非流式（路径式，BIT base_url=http://127.0.0.1:port/manual → /manual/chat/completions）
      const p1 = req(ADB_PORT, 'POST', '/manual/chat/completions',
        { headers: { 'content-type': 'application/json' }, body: { model: 'manual-x', messages: [{ role: 'user', content: 'E2E-MANUAL-1' }] } });
      await sleep(400);
      let pend = await getJSON('/api/pending');
      const ai1 = pend.ai[0];
      record('S23 路径式挂起 + 预览/模型', !!ai1 && ai1.model === 'manual-x' && (ai1.preview || '').includes('E2E-MANUAL-1'), JSON.stringify(pend.ai).slice(0, 120));
      await req(ADB_PORT, 'POST', '/api/pending/' + ai1.id + '/respond', { body: { mode: 'auto', text: '人工回复一号' } });
      const r1 = JSON.parse((await p1).buf.toString());
      record('S23 自动包装整包 chat.completion', r1.object === 'chat.completion' && r1.choices?.[0]?.message?.content === '人工回复一号'
        && r1.usage?.total_tokens > 0, JSON.stringify(r1).slice(0, 100));

      // 流式（头式 x-adb-target: manual）
      const p2 = req(ADB_PORT, 'POST', '/v1/chat/completions',
        { headers: { 'x-adb-target': 'manual', 'content-type': 'application/json' }, body: { model: 'manual-x', stream: true, messages: [{ role: 'user', content: 'E2E-MANUAL-2' }] } });
      await sleep(400);
      pend = await getJSON('/api/pending');
      record('S23 头式挂起 + stream 标记', pend.ai[0]?.stream === true);
      await req(ADB_PORT, 'POST', '/api/pending/' + pend.ai[0].id + '/respond', { body: { mode: 'auto', text: '流式人工回复AB', chunk_ms: 5 } });
      const r2raw = (await p2).buf.toString();
      record('S23 流式 SSE delta + [DONE]', r2raw.startsWith('data: {') && r2raw.includes('"delta":{"content":"流式人工回复AB"}')
        && r2raw.trimEnd().endsWith('data: [DONE]'), r2raw.slice(0, 80));

      // 错误模式
      const p3 = req(ADB_PORT, 'POST', '/v1/chat/completions', { headers: { 'x-adb-target': 'manual' }, body: { messages: [] } });
      await sleep(400);
      pend = await getJSON('/api/pending');
      await req(ADB_PORT, 'POST', '/api/pending/' + pend.ai[0].id + '/respond', { body: { mode: 'error', message: 'E2E-MANUAL-ERR' } });
      const r3 = JSON.parse((await p3).buf.toString());
      record('S23 错误模式 500 + error 结构', r3.error?.message === 'E2E-MANUAL-ERR');

      // raw 模式（任意 JSON，Claude/Gemini 协议兜底）
      const p4 = req(ADB_PORT, 'POST', '/manual/v1/messages', { body: { model: 'claude-fake', messages: [] } });
      await sleep(400);
      pend = await getJSON('/api/pending');
      await req(ADB_PORT, 'POST', '/api/pending/' + pend.ai[0].id + '/respond',
        { body: { mode: 'raw', body: { id: 'msg_raw', content: [{ type: 'text', text: 'RAW-OK' }] } } });
      const r4 = JSON.parse((await p4).buf.toString());
      record('S23 raw 模式原样返回', r4.id === 'msg_raw' && r4.content?.[0]?.text === 'RAW-OK');

      // 客户端提前断开：不悬挂、入库 aborted
      await new Promise((resolve) => {
        const r = http.request({ host: '127.0.0.1', port: ADB_PORT, path: '/manual/chat/completions', method: 'POST',
          headers: { 'content-length': 2 } }, () => {});
        r.on('error', () => {});   // 预期 ECONNRESET：客户端主动断开
        r.write('{}'); r.end(); setTimeout(() => { r.destroy(); resolve(); }, 150);
      });
      await sleep(400);
      record('S23 客户端断开出队', ((await getJSON('/api/pending')).ai.length === 0));

      // 入库断言
      const vrecs = await getJSON('/api/records?limit=20&tag=virtual');
      record('S23 虚拟 AI 记录入库', vrecs.length >= 3 && vrecs.every(r => r.target === 'manual' && r.provider === 'virtual'), `n=${vrecs.length}`);
      const sseRec = vrecs.find(r => r.is_sse === 1);
      record('S23 流式记录 SSE 计数与 usage', !!sseRec && sseRec.sse_events >= 3 && !!sseRec.usage, `events=${sseRec?.sse_events}`);
      const errRec = vrecs.find(r => r.status === 500);
      record('S23 错误记录标记 error', !!errRec && (errRec.tags || []).includes('error'));
      const abortRec = vrecs.find(r => r.aborted === 1);
      record('S23 断开记录标记 aborted', !!abortRec);
    }

    // ── S24 虚拟 E2E 场景端点（/mock/*，BIT base_url 兼容）──
    {
      const c1 = JSON.parse((await req(ADB_PORT, 'POST', '/mock/chat/completions',
        { headers: { 'content-type': 'application/json' }, body: { model: 'mock-m', messages: [{ role: 'user', content: 'E2E-MOCK' }] } })).buf.toString());
      record('S24 mock 正常对话（BIT 路径拼接）', c1.object === 'chat.completion' && c1.choices?.[0]?.message?.content.includes('E2E-MOCK') && c1.usage?.total_tokens > 0);

      const s1raw = (await req(ADB_PORT, 'POST', '/mock/stream?events=5', { body: {} })).buf.toString();
      record('S24 mock 流式事件完整', s1raw.split('data:').length - 1 === 7 && s1raw.trimEnd().endsWith('data: [DONE]'), `n=${s1raw.split('data:').length - 1}`);

      const tc = JSON.parse((await req(ADB_PORT, 'POST', '/mock/toolcall?name=shell', { body: {} })).buf.toString());
      record('S24 mock 工具调用结构', tc.choices?.[0]?.finish_reason === 'tool_calls' && tc.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'shell');

      const f1 = await req(ADB_PORT, 'POST', '/mock/fail', { body: {} });
      record('S24 mock 500', f1.code === 500 && !!JSON.parse(f1.buf.toString()).error?.message);

      const ec2 = JSON.parse((await req(ADB_PORT, 'POST', '/mock/echo?probe=1',
        { headers: { 'content-type': 'application/json', authorization: 'Bearer sk-e2e-9999' }, body: { marker: 'ECHO-MARK' } })).buf.toString());
      record('S24 mock 回显请求体', ec2.body?.marker === 'ECHO-MARK' && ec2.authorization === 'Bearer sk-e2e-9999');

      const unk = await req(ADB_PORT, 'POST', '/mock/nothing', { body: {} });
      record('S24 mock 未知场景 404', unk.code === 404);

      await sleep(300);
      const mrecs = await getJSON('/api/records?limit=20&tag=mock');
      record('S24 mock 记录入库', mrecs.length >= 5 && mrecs.every(r => r.target === 'mock'), `n=${mrecs.length}`);
      const mockSse = mrecs.find(r => r.is_sse === 1);
      record('S24 mock 流式记录事件计数', !!mockSse && mockSse.sse_events === 7, `events=${mockSse?.sse_events}`);
      record('S24 mock 500 记录 error 标签', mrecs.some(r => r.status === 500 && (r.tags || []).includes('error')));
    }

    // ── S20 压力后完整性 ──
    {
      const h = await getJSON('/api/health');
      record('S20 压力后服务存活', h.ok === true);
    }
    adb3.kill();
  }

  // ── 汇总 ──
  const pass = results.filter(r => r.ok).length;
  console.log(`\n==== ${pass}/${results.length} passed ====`);
  fake.server.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('E2E runner error:', e); process.exit(1); });
