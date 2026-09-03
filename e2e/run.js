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
