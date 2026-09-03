// 面板 UI（黑白圆角简约，无外部依赖）
'use strict';

const UI = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ADB · Agent Debug Bridge</title>
<style>
  :root { --bg:#fff; --fg:#111; --line:#e5e5e5; --dim:#888; --radius:16px; }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,"Segoe UI",sans-serif; padding:24px; max-width:1200px; margin:0 auto; }
  h1 { font-size:20px; font-weight:600; letter-spacing:.5px; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:16px; }
  .tabs { display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
  .tabs button { border:1px solid var(--fg); background:var(--bg); color:var(--fg); border-radius:999px; padding:5px 18px; font-size:13px; cursor:pointer; }
  .tabs button.on { background:var(--fg); color:var(--bg); }
  .filters { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; align-items:center; }
  .filters button { border:1px solid var(--line); background:var(--bg); color:var(--fg); border-radius:999px; padding:3px 12px; font-size:12px; cursor:pointer; }
  .filters button.on { border-color:var(--fg); background:var(--fg); color:var(--bg); }
  input[type=text] { border:1px solid var(--line); border-radius:999px; padding:6px 16px; font-size:13px; outline:none; min-width:220px; }
  input[type=text]:focus { border-color:var(--fg); }
  textarea { border:1px solid var(--line); border-radius:12px; padding:8px 14px; font:13px/1.6 -apple-system,"Segoe UI",sans-serif; width:100%; outline:none; resize:vertical; }
  textarea:focus { border-color:var(--fg); }
  .card { border:1px solid var(--line); border-radius:var(--radius); margin-bottom:10px; overflow:hidden; }
  .row { display:flex; align-items:center; gap:12px; padding:11px 18px; cursor:pointer; flex-wrap:wrap; }
  .row:hover { background:#fafafa; }
  .method { font-weight:700; font-size:11px; border:1px solid var(--fg); border-radius:8px; padding:1px 8px; }
  .path { font-family:ui-monospace,monospace; font-size:12px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:200px; }
  .meta { font-size:12px; color:var(--dim); display:flex; gap:10px; flex-wrap:wrap; }
  .status.bad { color:#000; font-weight:700; }
  .badge { font-size:11px; border:1px solid var(--line); border-radius:999px; padding:0 8px; color:var(--dim); }
  .badge.sse { border-color:var(--fg); color:var(--fg); }
  .tags { display:flex; flex-wrap:wrap; gap:6px; padding:0 18px 11px; }
  .tag { font-size:11px; border:1px solid var(--line); border-radius:999px; padding:1px 10px; color:var(--dim); }
  .detail { display:none; border-top:1px solid var(--line); }
  .open .detail { display:block; }
  .detail pre { padding:14px 18px; font-size:12px; overflow:auto; max-height:420px; font-family:ui-monospace,monospace; background:#fcfcfc; white-space:pre-wrap; word-break:break-word; }
  .detail h4 { font-size:12px; color:var(--dim); padding:10px 18px 0; font-weight:600; }
  .empty { text-align:center; color:var(--dim); padding:60px 0; border:1px dashed var(--line); border-radius:var(--radius); }
  .bar-row { display:flex; align-items:center; gap:10px; margin-bottom:6px; font-size:12px; }
  .bar-row .lbl { width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; color:var(--dim); font-family:ui-monospace,monospace; }
  .bar-row .bar { height:14px; background:var(--fg); border-radius:7px; min-width:2px; }
  .bar-row .n { color:var(--dim); }
  .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:20px; }
  .tile { border:1px solid var(--line); border-radius:var(--radius); padding:14px 16px; }
  .tile .v { font-size:22px; font-weight:700; font-family:ui-monospace,monospace; }
  .tile .k { font-size:11px; color:var(--dim); }
  .sec { margin-bottom:24px; }
  .sec h3 { font-size:14px; margin-bottom:10px; font-weight:600; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td, th { border-bottom:1px solid var(--line); padding:8px 10px; text-align:left; }
  th { color:var(--dim); font-weight:500; font-size:12px; }
  .pill { border:1px solid var(--fg); background:var(--bg); color:var(--fg); border-radius:999px; padding:5px 16px; font-size:12px; cursor:pointer; }
  .pill:hover { background:var(--fg); color:var(--bg); }
  .danger { border-color:#c00; color:#c00; }
  .danger:hover { background:#c00; color:#fff; }
  code, pre.code { font-family:ui-monospace,monospace; background:#f7f7f7; border-radius:10px; padding:2px 8px; font-size:12px; }
  pre.code { padding:14px 16px; overflow:auto; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--fg); margin-right:8px; animation:p 1.2s infinite alternate; }
  @keyframes p { to { opacity:.3; } }
  .hintbox { border:1px solid var(--line); border-radius:var(--radius); padding:16px 18px; margin-bottom:16px; font-size:13px; }
  a { color:inherit; }
  .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:var(--fg); color:var(--bg); border-radius:999px; padding:8px 22px; font-size:13px; opacity:0; transition:opacity .2s; pointer-events:none; }
  .toast.show { opacity:1; }
</style></head><body>
<h1>ADB — Agent Debug Bridge</h1>
<div class="sub"><span class="dot"></span>转发运行中 · 端口 ${'<span id="port"></span>'} · 存储 SQLite · 完整记录不截断</div>
<div class="tabs">
  <button data-t="req" class="on">请求</button>
  <button data-t="sess">会话</button>
  <button data-t="stats">分析</button>
  <button data-t="virt">虚拟</button>
  <button data-t="bit">BIT</button>
  <button data-t="cfg">设置</button>
  <span style="flex:1"></span>
  <button id="pause" style="border:1px solid var(--line);border-radius:999px;padding:5px 16px;font-size:12px;cursor:pointer;background:#fff">暂停刷新</button>
  <button id="clear" class="pill danger" style="padding:5px 16px;font-size:12px">清空记录</button>
</div>
<div id="req" class="tab">
  <div class="filters" id="filters"></div>
  <div id="list"></div>
</div>
<div id="sess" class="tab" style="display:none"><div id="sessList"></div></div>
<div id="stats" class="tab" style="display:none"><div id="statBox"></div></div>
<div id="virt" class="tab" style="display:none">
  <div class="hintbox">
    <b>BIT 调试接入（三种玩法）</b><br>
    <b>1. 虚拟 MCP 服务器</b> — BIT「MCP 服务器」里添加 <code>http://127.0.0.1:<span class="vp"></span>/mcp</code>。
    内置 echo/add/now，还可在下方定义自己的工具：fixed 模式返回固定结果（模拟工具行为），manual 模式把调用挂起等你回复（你扮演工具，观察 AI 拿到结果后怎么做）。<br>
    <b>2. 人工扮演 AI</b> — BIT 新建 OpenAI 协议 provider，Base URL 填 <code>http://127.0.0.1:<span class="vp"></span>/manual</code>。
    BIT 的每条消息都会挂起到下方「待应答」，你输入什么 AI 就"说"什么：可用来复现对话问题、扮演故障 AI、验证 BIT 对异常回复的处理。勾选流式则模拟逐字输出。<br>
    <b>3. 虚拟 E2E 场景</b> — Base URL 填 <code>http://127.0.0.1:<span class="vp"></span>/mock</code>，用 query 选择场景：
    <code>/mock/chat</code> 正常回复 · <code>/mock/toolcall?name=shell</code> 工具调用 · <code>/mock/stream?events=50</code> 流式 ·
    <code>/mock/slow?ms=500</code> 慢流 · <code>/mock/die?after=3</code> 中途断开 · <code>/mock/big?kb=1024</code> 大响应 · <code>/mock/fail</code> 500 错误 · <code>/mock/echo</code> 回显透传校验。
    全部交互自动入库，在「请求」页可查。
  </div>
  <div class="sec">
    <h3>待应答 <span class="sub" style="display:inline" id="pendHint">（挂起中的请求，回复后写回客户端；超时 5 分钟自动报错）</span></h3>
    <div id="pendList"></div>
  </div>
  <div class="sec">
    <h3>虚拟 MCP 自定义工具</h3>
    <table id="vtoolTable"></table>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
      <input type="text" id="vtName" placeholder="工具名（如 report_issue）" style="min-width:170px">
      <input type="text" id="vtDesc" placeholder="描述（给 AI 看）" style="flex:1;min-width:220px">
      <select id="vtMode" style="border:1px solid var(--line);border-radius:999px;padding:6px 14px;font-size:13px;background:#fff">
        <option value="fixed">固定结果</option>
        <option value="manual">人工应答</option>
      </select>
    </div>
    <textarea id="vtResult" rows="2" placeholder="固定结果文本（fixed 模式使用）" style="margin-top:8px"></textarea>
    <div style="margin-top:10px"><button class="pill" onclick="addVTool()">添加工具</button></div>
  </div>
</div>
<div id="bit" class="tab" style="display:none">
  <div class="hintbox">
    <b>BIT 联动（控制 + 分析）</b> — 在 BIT「设置 → 远程访问」开启服务，把端口、Client Key、访问密码填到下方。
    保存后 ADB 可直接驱动 BIT（发对话、调工具）并读取内部状态（Provider / 工具注册表 / MCP / 会话 / 审计）。
    进阶：把 BIT 激活 Provider 的 Base URL 指到本代理（<code>/forward/…</code> 或默认目标），从下方发送的对话会经 ADB 记录每一笔模型请求——<b>控制 BIT 的同时逐字节观测它</b>。完整说明见 <a href="https://github.com/yxpil/ADB#readme" target="_blank">ADB Wiki</a>。
  </div>
  <div class="sec">
    <h3>连接 <span class="sub" style="display:inline" id="bitConnState"></span></h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input type="text" id="bitUrl" placeholder="BIT 地址（如 http://127.0.0.1:8600）" style="flex:1;min-width:240px">
      <input type="text" id="bitKey" placeholder="Client Key（bit_…，留空保持不变）" style="flex:1;min-width:200px">
      <input type="text" id="bitPwd" placeholder="访问密码（留空保持不变）" style="min-width:160px">
      <button class="pill" onclick="saveBitConn()">保存</button>
      <button class="pill" onclick="loadBit()">连接 / 刷新</button>
    </div>
    <div class="sub" id="bitKeyHint" style="margin-top:6px"></div>
  </div>
  <div id="bitBody" style="display:none">
    <div class="tiles" id="bitTiles"></div>
    <div class="sec"><h3>激活 Provider</h3><div id="bitProvider" class="sub"></div></div>
    <div class="sec"><h3>工具注册表</h3><table id="bitToolTable"></table></div>
    <div class="sec">
      <h3>控制 BIT</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
        <input type="text" id="bitChatSess" placeholder="会话 ID（留空用激活会话）" style="min-width:220px">
        <span class="sub" style="margin:0">发送一轮完整 Agent 对话（AI 可自行调用工具）</span>
      </div>
      <textarea id="bitChatText" rows="2" placeholder="要发给 BIT 的消息…"></textarea>
      <div style="margin-top:8px"><button class="pill" onclick="sendBitChat()">发送对话</button></div>
      <pre id="bitChatOut" class="code" style="display:none;max-height:300px"></pre>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:12px">
        <input type="text" id="bitToolId" placeholder="工具 ID（见下方工具注册表）" style="min-width:220px">
        <input type="text" id="bitToolArgs" placeholder='参数 JSON（如 {"cmd":"echo hi"}）' style="flex:1;min-width:240px">
        <button class="pill" onclick="invokeBitTool()">直接调用工具</button>
      </div>
      <pre id="bitToolOut" class="code" style="display:none;max-height:300px"></pre>
    </div>
    <div class="sec"><h3>MCP 服务器</h3><table id="bitMcpTable"></table></div>
    <div class="sec"><h3>会话 <span class="sub" style="display:inline">（点击查看全部消息）</span></h3><div id="bitSessions"></div></div>
    <div class="sec"><h3>审计日志（最近 20 条）</h3><table id="bitAuditTable"></table></div>
  </div>
</div>
<div id="cfg" class="tab" style="display:none">
  <div class="hintbox">
    <b>接入方式</b> — 把 Agent 的 baseURL 指到 ADB，目标三选一：<br>
    1. 请求头 <code>x-adb-target: https://api.example.com</code>（URL 或下方预设名）<br>
    2. 路径前缀 <code>/forward/api.example.com/v1/chat/completions</code><br>
    3. 在下方设默认目标，不带头的请求全部转过去
  </div>
  <div class="sec">
    <h3>默认目标</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <input type="text" id="defTarget" placeholder="https://api.example.com（留空关闭）" style="flex:1;min-width:300px">
      <button class="pill" onclick="saveCfg()">保存</button>
    </div>
  </div>
  <div class="sec">
    <h3>AI 主动发消息（注入系统指令）</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <button class="pill" id="injToggle" onclick="toggleInject()">已关闭</button>
      <span class="sub" style="margin:0">开启后，转发请求的 messages 末尾追加一条 system 指令（可编辑），用于调试 Agent（如 BIT）的主动发消息/系统事件处理；单次请求可用头 <code>x-adb-inject: 自定义文本</code> 覆盖，<code>x-adb-inject: off</code> 强制关闭</span>
    </div>
    <textarea id="injText" rows="2" placeholder="注入的 system 指令文本"></textarea>
    <div style="margin-top:10px"><button class="pill" onclick="saveCfg()">保存指令</button></div>
  </div>
  <div class="sec">
    <h3>上游预设（可用 x-adb-target: 名称 引用）</h3>
    <table id="presetTable"></table>
    <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
      <input type="text" id="pName" placeholder="名称（如 my-api）" style="min-width:160px">
      <input type="text" id="pUrl" placeholder="Base URL（https://...）" style="flex:1;min-width:260px">
      <button class="pill" onclick="addPreset()">添加</button>
    </div>
  </div>
  <div class="sec">
    <h3>记录导出</h3>
    <a class="pill" href="/api/export" style="text-decoration:none">导出全部记录（JSONL）</a>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
let all = [], filterTag = null, filterStatus = null, q = '', tab = 'req', paused = false, cfgData = null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => n == null ? '-' : (n > 1048576 ? (n/1048576).toFixed(1)+'MB' : n > 1024 ? (n/1024).toFixed(1)+'KB' : String(n));
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1500); }

document.querySelectorAll('.tabs button[data-t]').forEach(b => b.onclick = () => {
  tab = b.dataset.t;
  document.querySelectorAll('.tabs button[data-t]').forEach(x => x.classList.toggle('on', x === b));
  for (const id of ['req','sess','stats','virt','bit','cfg']) document.getElementById(id).style.display = id === tab ? '' : 'none';
  if (tab === 'sess') loadSessions();
  if (tab === 'stats') loadStats();
  if (tab === 'virt') { loadPending(); loadVTools(); }
  if (tab === 'bit') loadBit();
  if (tab === 'cfg') loadCfg();
});
document.getElementById('pause').onclick = e => { paused = !paused; e.target.textContent = paused ? '继续刷新' : '暂停刷新'; };
document.getElementById('clear').onclick = async () => {
  if (!confirm('清空全部记录？SQLite 数据将删除，不可恢复。')) return;
  await fetch('/api/records/clear', { method: 'POST' }); toast('已清空'); refresh();
};

async function refresh() {
  if (paused || tab !== 'req') return;
  try {
    const p = new URLSearchParams({ limit: 300 });
    if (filterTag) p.set('tag', filterTag);
    if (filterStatus) p.set('status', filterStatus);
    if (q) p.set('q', q);
    const r = await fetch('/api/records?' + p); all = await r.json(); render();
  } catch {}
}
function render() {
  document.getElementById('port').textContent = location.port;
  const f = document.getElementById('filters');
  const cats = [...new Set(all.flatMap(r => r.tags || []))].filter(c => c.startsWith('tool:') || c === 'sse' || c.startsWith('md:')).sort();
  f.innerHTML = '<input type="text" id="qbox" placeholder="搜索路径/内容/模型…" value="'+esc(q)+'">' +
    '<button class="'+(!filterStatus?'on':'')+'" data-s="">全部状态</button>' +
    '<button class="'+(filterStatus==='200'?'on':'')+'" data-s="200">2xx</button>' +
    '<button class="'+(filterStatus==='400'?'on':'')+'" data-s="400">4xx</button>' +
    '<button class="'+(filterStatus==='500'?'on':'')+'" data-s="500">5xx</button>' +
    cats.map(c => '<button class="'+(filterTag===c?'on':'')+'" data-c="'+esc(c)+'">'+esc(c)+'</button>').join('');
  const qb = f.querySelector('#qbox');
  let deb; qb.oninput = () => { clearTimeout(deb); deb = setTimeout(() => { q = qb.value; refresh(); }, 350); };
  f.querySelectorAll('button[data-s]').forEach(b => b.onclick = () => { filterStatus = b.dataset.s || null; refresh(); });
  f.querySelectorAll('button[data-c]').forEach(b => b.onclick = () => { filterTag = filterTag === b.dataset.c ? null : b.dataset.c; refresh(); });

  document.getElementById('list').innerHTML = all.length ? all.map(r => \`
    <div class="card" id="r\${r.id}" onclick="openDetail(\${r.id}, this)">
      <div class="row">
        <span class="method">\${esc(r.method)}</span>
        <span class="path">\${esc(r.path)}</span>
        <span class="meta">
          <span class="status \${r.status>=400?'bad':''}">\${r.status ?? '-'} · \${r.duration_ms ?? '-'}ms</span>
          \${r.is_sse ? '<span class="badge sse">SSE '+r.sse_events+' events</span>' : ''}
          \${r.aborted ? '<span class="badge">aborted</span>' : ''}
          \${r.model ? '<span class="badge">'+esc(r.model)+'</span>' : ''}
          \${r.session_id ? '<span class="badge">sess:'+esc(r.session_id)+'</span>' : ''}
          <span>\${esc(fmt(r.res_size))}</span>
        </span>
      </div>
      <div class="tags">\${(r.tags||[]).map(c=>'<span class="tag">'+esc(c)+'</span>').join('')}
        \${r.preview ? '<span class="tag" style="max-width:520px;overflow:hidden;text-overflow:ellipsis">'+esc(r.preview)+'</span>' : ''}</div>
      <div class="detail"><div id="d\${r.id}" class="detail-body">加载中…</div></div>
    </div>\`).join('') : '<div class="empty">还没有请求 · 把 Agent 的 baseURL 指到本代理即可开始记录</div>';
}
async function openDetail(id, card) {
  card.classList.toggle('open');
  if (!card.classList.contains('open')) return;
  const box = card.querySelector('.detail-body');
  try {
    const r = await fetch('/api/record/' + id); const d = await r.json();
    box.innerHTML =
      '<h4>请求头</h4><pre>' + esc(JSON.stringify(d.req_headers, null, 2)) + '</pre>' +
      '<h4>请求体 (' + fmt(d.req_size) + ')</h4><pre>' + esc(pretty(d.req_body)) + '</pre>' +
      '<h4>响应头</h4><pre>' + esc(JSON.stringify(d.res_headers, null, 2)) + '</pre>' +
      '<h4>响应体 (' + fmt(d.res_size) + (d.is_sse ? ' · SSE ' + d.sse_events + ' events · ' + d.sse_ms + 'ms' : '') + ')</h4><pre>' + esc(pretty(d.res_body)) + '</pre>' +
      (d.usage ? '<h4>Token 用量</h4><pre>' + esc(JSON.stringify(d.usage)) + '</pre>' : '') +
      (d.error ? '<h4>错误</h4><pre>' + esc(d.error) + '</pre>' : '');
  } catch (e) { box.textContent = '加载失败: ' + e; }
}
function pretty(s) {
  if (s == null || s === '') return '(空)';
  try { const j = JSON.parse(s); return JSON.stringify(j, null, 2); } catch { return s; }
}

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions'); const list = await r.json();
    document.getElementById('sessList').innerHTML = list.length ? list.map(s => \`
      <div class="card" onclick="jumpSession('\${esc(s.session_id)}')" style="cursor:pointer">
        <div class="row"><span class="path" style="flex:0 0 auto;font-weight:600">\${esc(s.session_id)}</span>
        <span class="meta"><span>\${s.n} 请求</span><span>SSE \${s.sse_n}</span><span>token \${s.total_tokens ?? 0}</span>
        <span>\${esc(s.models.join(', '))}</span><span>\${esc(s.first_ts)} → \${esc(s.last_ts)}</span></span></div>
      </div>\`).join('') : '<div class="empty">暂无会话 · 请求体带 session_id / conversation_id 字段或 x-adb-session 头即可自动分组</div>';
  } catch {}
}
function jumpSession(id) {
  document.querySelector('.tabs button[data-t="req"]').click();
  q = id; refresh();
}

async function loadStats() {
  try {
    const r = await fetch('/api/stats'); const s = await r.json();
    const tiles = [
      ['总请求', s.total], ['SSE 流', s.sse_count ?? 0], ['错误', s.err_count ?? 0], ['中断', s.aborted_count ?? 0],
      ['平均耗时', Math.round(s.avg_ms) + 'ms'], ['最大耗时', s.max_ms + 'ms'],
      ['Prompt Tokens', s.prompt_tokens ?? 0], ['Completion Tokens', s.completion_tokens ?? 0],
      ['总 Tokens', s.total_tokens ?? 0], ['请求字节', fmt(s.req_bytes)], ['响应字节', fmt(s.res_bytes)],
    ];
    const bars = (rows, key, val) => {
      const max = Math.max(...rows.map(r => r[val] || 0), 1);
      return rows.map(x => '<div class="bar-row"><span class="lbl">' + esc(x[key] ?? '-') + '</span>' +
        '<span class="bar" style="width:' + Math.max(2, (x[val]||0)/max*60) + '%"></span><span class="n">' + (x[val] ?? 0) + '</span></div>').join('') || '<span class="sub">暂无数据</span>';
    };
    document.getElementById('statBox').innerHTML =
      '<div class="tiles">' + tiles.map(t => '<div class="tile"><div class="v">' + t[1] + '</div><div class="k">' + t[0] + '</div></div>').join('') + '</div>' +
      '<div class="sec"><h3>按目标</h3>' + bars(s.byTarget, 'target', 'n') + '</div>' +
      '<div class="sec"><h3>按模型</h3>' + bars(s.byModel, 'model', 'n') + '</div>' +
      '<div class="sec"><h3>按天（请求 / tokens）</h3>' + s.byDay.map(d => '<div class="bar-row"><span class="lbl">' + esc(d.day) + '</span><span class="bar" style="width:' + Math.max(2, d.n / Math.max(...s.byDay.map(x=>x.n),1) * 60) + '%"></span><span class="n">' + d.n + ' / ' + (d.tokens||0) + ' tok</span></div>').join('') + '</div>' +
      '<div class="sec"><h3>工具调用 Top</h3>' + bars(s.tools, 'tag', 'n') + '</div>';
  } catch {}
}

async function loadCfg() {
  try {
    cfgData = await (await fetch('/api/config')).json();
    document.getElementById('defTarget').value = cfgData.default_target || '';
    document.getElementById('injText').value = cfgData.inject_text || '';
    renderInject();
    document.getElementById('presetTable').innerHTML =
      '<tr><th>名称</th><th>Base URL</th><th></th></tr>' +
      cfgData.presets.map((p, i) => '<tr><td><code>' + esc(p.name) + '</code></td><td>' + esc(p.base_url) + '</td>' +
        '<td><button class="pill danger" style="padding:2px 12px;font-size:11px" onclick="delPreset(' + i + ')">删除</button></td></tr>').join('');
  } catch {}
}
function renderInject() {
  const b = document.getElementById('injToggle');
  const on = !!cfgData.inject_system;
  b.textContent = on ? '开启中 · 点击关闭' : '已关闭 · 点击开启';
  b.style.background = on ? 'var(--fg)' : 'var(--bg)';
  b.style.color = on ? 'var(--bg)' : 'var(--fg)';
}
async function toggleInject() {
  cfgData.inject_system = !cfgData.inject_system;
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfgData) });
  renderInject(); toast(cfgData.inject_system ? '注入已开启' : '注入已关闭');
}
async function saveCfg() {
  cfgData.default_target = document.getElementById('defTarget').value.trim();
  cfgData.inject_text = document.getElementById('injText').value;
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfgData) });
  toast('已保存'); loadCfg();
}
async function addPreset() {
  const name = document.getElementById('pName').value.trim(), base_url = document.getElementById('pUrl').value.trim();
  if (!name || !base_url) return toast('名称与 URL 都要填');
  cfgData.presets.push({ name, base_url });
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfgData) });
  document.getElementById('pName').value = ''; document.getElementById('pUrl').value = '';
  toast('已添加'); loadCfg();
}
async function delPreset(i) {
  cfgData.presets.splice(i, 1);
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfgData) });
  toast('已删除'); loadCfg();
}

// ── 虚拟页 ──
let pendData = { ai: [], mcp: [] };
function renderPending() {
  document.querySelectorAll('.vp').forEach(el => el.textContent = location.port);
  const box = document.getElementById('pendList');
  const items = [
    ...pendData.ai.map(p => ({ ...p, kindLabel: '扮演 AI', kindColor: p.stream ? 'SSE 流式' : '整包' })),
    ...pendData.mcp.map(p => ({ ...p, kindLabel: 'MCP 工具', kindColor: 'tool:' + p.tool_name })),
  ];
  if (!items.length) { box.innerHTML = '<div class="empty">没有挂起中的请求<br><span class="sub">把 BIT 的 provider Base URL 填 http://127.0.0.1:' + location.port + '/manual，或调用 manual 模式的 MCP 工具</span></div>'; return; }
  box.innerHTML = items.map(p => \`
    <div class="card">
      <div class="row" style="cursor:default">
        <span class="method">\${esc(p.kindLabel)}</span>
        <span class="path">\${esc(p.preview || p.path || '')}</span>
        <span class="meta">
          <span class="badge sse">\${esc(p.kindColor)}</span>
          \${p.model ? '<span class="badge">'+esc(p.model)+'</span>' : ''}
          \${p.session_id ? '<span class="badge">sess:'+esc(p.session_id)+'</span>' : ''}
          <span>等待 \${Math.round(p.waited_ms/1000)}s</span>
        </span>
      </div>
      <div class="tags" style="padding-bottom:14px">
        \${p.kindLabel === '扮演 AI' ? \`
          <textarea id="pa-\${p.id}" rows="2" placeholder="你扮演 AI 要回复的内容…" style="max-width:640px"></textarea>
          <label style="font-size:12px;color:var(--dim);display:flex;align-items:center;gap:4px"><input type="checkbox" id="ps-\${p.id}">流式输出</label>
          <button class="pill" onclick="doRespond('\${p.id}','ai')">回复</button>
          <button class="pill danger" onclick="doRespondErr('\${p.id}')">回 500</button>\`
        : \`
          <textarea id="pa-\${p.id}" rows="2" placeholder="工具执行结果文本…" style="max-width:640px"></textarea>
          <label style="font-size:12px;color:var(--dim);display:flex;align-items:center;gap:4px"><input type="checkbox" id="pe-\${p.id}">标记为错误</label>
          <button class="pill" onclick="doRespond('\${p.id}','mcp')">回复</button>\`}
      </div>
    </div>\`).join('');
}
async function loadPending() {
  try { pendData = await (await fetch('/api/pending')).json(); renderPending(); } catch {}
}
async function doRespond(id, kind) {
  const text = document.getElementById('pa-' + id)?.value ?? '';
  const body = kind === 'ai'
    ? { mode: 'auto', text, stream: document.getElementById('ps-' + id)?.checked }
    : { text, is_error: document.getElementById('pe-' + id)?.checked };
  const r = await fetch('/api/pending/' + id + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) { toast('已回复'); loadPending(); } else toast((await r.json()).error || '回复失败');
}
async function doRespondErr(id) {
  const r = await fetch('/api/pending/' + id + '/respond', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'error', message: 'manual 500 (debug)' }) });
  if (r.ok) { toast('已回复 500'); loadPending(); }
}

async function loadVTools() {
  try {
    cfgData = await (await fetch('/api/config')).json();
    const ts = cfgData.vmcp_tools || [];
    document.getElementById('vtoolTable').innerHTML = ts.length
      ? '<tr><th>工具名</th><th>描述</th><th>模式</th><th>固定结果</th><th></th></tr>' + ts.map((t, i) =>
        '<tr><td><code>' + esc(t.name) + '</code></td><td>' + esc(t.description) + '</td><td>' +
        (t.mode === 'manual' ? '人工应答' : '固定结果') + '</td><td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.result || '-') + '</td>' +
        '<td><button class="pill danger" style="padding:2px 12px;font-size:11px" onclick="delVTool(' + i + ')">删除</button></td></tr>').join('')
      : '<tr><th>工具名</th><th>描述</th><th>模式</th><th>固定结果</th><th></th></tr><tr><td colspan="5" class="sub">暂无自定义工具（内置 echo / add / now 始终可用）</td></tr>';
  } catch {}
}
async function saveVTools() {
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vmcp_tools: cfgData.vmcp_tools || [] }) });
}
async function addVTool() {
  const name = document.getElementById('vtName').value.trim();
  const description = document.getElementById('vtDesc').value.trim();
  const mode = document.getElementById('vtMode').value;
  const result = document.getElementById('vtResult').value;
  if (!name) return toast('工具名必填');
  if (mode === 'manual' && !description) return toast('人工应答工具请填描述（AI 靠它决定何时调用）');
  cfgData.vmcp_tools = (cfgData.vmcp_tools || []).filter(t => t.name !== name);
  cfgData.vmcp_tools.push({ name, description, mode, result });
  await saveVTools();
  document.getElementById('vtName').value = ''; document.getElementById('vtDesc').value = ''; document.getElementById('vtResult').value = '';
  toast('已添加，MCP 客户端重新连接后生效'); loadVTools();
}
async function delVTool(i) {
  cfgData.vmcp_tools.splice(i, 1);
  await saveVTools(); toast('已删除'); loadVTools();
}

// ── BIT 联动页 ──
async function loadBit() {
  try {
    cfgData = await (await fetch('/api/config')).json();
    document.getElementById('bitUrl').value = cfgData.bit_url || '';
    document.getElementById('bitKey').value = '';
    document.getElementById('bitPwd').value = '';
    document.getElementById('bitKeyHint').textContent = !cfgData.bit_key_set
      ? '尚未保存 Client Key' : '已保存 Key: ' + cfgData.bit_key_hint + (cfgData.bit_pwd_set ? ' · 已保存访问密码' : ' · 未保存访问密码（/api/* 需要时必填）');
  } catch {}
  document.getElementById('bitConnState').textContent = '连接中…';
  const ok = await renderBitState();
  document.getElementById('bitConnState').textContent = ok ? '已连接' : '未连接（检查地址 / 远程访问开关 / 凭据）';
}
async function saveBitConn() {
  const patch = { bit_url: document.getElementById('bitUrl').value.trim() };
  const k = document.getElementById('bitKey').value.trim();
  const pwd = document.getElementById('bitPwd').value.trim();
  if (k) patch.bit_key = k;
  if (pwd) patch.bit_pwd = pwd;
  await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  document.getElementById('bitKey').value = ''; document.getElementById('bitPwd').value = '';
  toast('已保存'); loadBit();
}
async function renderBitState() {
  let st;
  try { st = await (await fetch('/api/bit/state')).json(); } catch { return false; }
  if (st.error) { document.getElementById('bitBody').style.display = 'none'; return false; }
  const pv = st.provider || {};
  const tiles = [
    ['BIT 版本', st.version], ['工具', (st.tools && st.tools.count) || 0], ['MCP 服务器', (st.mcp && st.mcp.count) || 0],
    ['会话', (st.sessions && st.sessions.count) || 0], ['消息', (st.sessions && st.sessions.messages) || 0],
    ['记忆', st.memories ?? 0], ['技能', st.skills ?? 0],
  ];
  document.getElementById('bitTiles').innerHTML = tiles.map(t => '<div class="tile"><div class="v">' + esc(t[1]) + '</div><div class="k">' + t[0] + '</div></div>').join('');
  document.getElementById('bitProvider').innerHTML = pv.model
    ? '<b>' + esc(pv.name || '-') + '</b> · ' + esc(pv.protocol) + ' · 模型 <b>' + esc(pv.model) + '</b> · ' + esc(pv.base_url) + ' · Key ' + esc(pv.api_key_hint || '-') +
      ' · 远程端口 ' + (st.remote ? st.remote.port : '-')
    : '未激活任何 Provider';
  loadBitTools(); loadBitMcp(); loadBitSessions(); loadBitAudit();
  document.getElementById('bitBody').style.display = '';
  return true;
}
async function loadBitTools() {
  try {
    const r = await (await fetch('/api/bit/tools')).json();
    const ts = r.tools || [];
    document.getElementById('bitToolTable').innerHTML = ts.length
      ? '<tr><th>名称</th><th>类型</th><th>状态</th><th>描述</th><th>ID（用于直接调用）</th></tr>' + ts.map(t =>
        '<tr><td><b>' + esc(t.name) + '</b></td>' +
        '<td>' + esc(Object.keys(t.kind || {})[0] || '-') + '</td>' +
        '<td>' + (t.enabled === false ? '暂停' : '启用') + '</td>' +
        '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t.description || '-') + '</td>' +
        '<td><code>' + esc(t.id) + '</code></td></tr>').join('')
      : '<tr><td class="sub">BIT 工具注册表为空</td></tr>';
  } catch {}
}
async function loadBitMcp() {
  try {
    const r = await (await fetch('/api/bit/mcp')).json();
    const ss = r.servers || [];
    document.getElementById('bitMcpTable').innerHTML = ss.length
      ? '<tr><th>名称</th><th>URL</th><th>状态</th><th>协议</th><th>导入工具</th></tr>' + ss.map(s =>
        '<tr><td><b>' + esc(s.name) + '</b></td><td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.url) + '</td>' +
        '<td>' + (s.enabled ? '启用' : '暂停') + '</td><td>' + esc(s.protocol || '-') + '</td><td>' + esc((s.tools || []).join(', ') || '-') + '</td></tr>').join('')
      : '<tr><td class="sub">BIT 未添加 MCP 服务器</td></tr>';
  } catch {}
}
async function loadBitSessions() {
  try {
    const r = await (await fetch('/api/bit/sessions')).json();
    const ss = r.sessions || [];
    document.getElementById('bitSessions').innerHTML = ss.length ? ss.map(s => \`
      <div class="card" onclick="viewBitSession('\${esc(s.id)}')" style="cursor:pointer">
        <div class="row" style="cursor:default">
          <span class="path" style="flex:0 0 auto;font-weight:600">\${esc(s.title)}\${s.id === r.active ? ' <span class="badge sse">激活</span>' : ''}</span>
          <span class="meta"><span>\${s.messages} 消息</span><span>\${esc(s.updated)}</span><span>\${esc(s.preview || '')}</span></span>
        </div>
      </div>\`).join('') : '<div class="sub">BIT 暂无会话</div>';
  } catch {}
}
async function viewBitSession(id) {
  const r = await fetch('/api/bit/sessions/' + id);
  const d = await r.json();
  if (d.error) return toast(d.error);
  document.getElementById('bitChatOut').style.display = '';
  document.getElementById('bitChatOut').textContent = (d.title ? '【' + d.title + '】\n' : '') +
    (d.messages || []).map(m => '[' + m.role + '] ' + m.content + (m.tool_calls && m.tool_calls.length ? '\n  tool_calls: ' + JSON.stringify(m.tool_calls) : '')).join('\n\n');
  document.getElementById('bitChatOut').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function sendBitChat() {
  const text = document.getElementById('bitChatText').value.trim();
  if (!text) return toast('输入消息内容');
  const body = { message: text };
  const sess = document.getElementById('bitChatSess').value.trim();
  if (sess) body.session_id = sess;
  const out = document.getElementById('bitChatOut');
  out.style.display = ''; out.textContent = 'BIT Agent 执行中（可能包含多轮工具调用，最长 10 分钟）…';
  try {
    const r = await fetch('/api/bit/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    out.textContent = r.ok ? (d.reply || '(空回复)') : '错误 ' + r.status + ': ' + (d.error || JSON.stringify(d));
    if (r.ok) { document.getElementById('bitChatText').value = ''; renderBitState(); toast('已完成'); }
  } catch (e) { out.textContent = '请求失败: ' + e; }
}
async function invokeBitTool() {
  const id = document.getElementById('bitToolId').value.trim();
  if (!id) return toast('填工具 ID');
  let args = {};
  const raw = document.getElementById('bitToolArgs').value.trim();
  if (raw) { try { args = JSON.parse(raw); } catch { return toast('参数不是合法 JSON'); } }
  const out = document.getElementById('bitToolOut');
  out.style.display = ''; out.textContent = '执行中…';
  try {
    const r = await fetch('/api/bit/tool/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    const d = await r.json();
    out.textContent = 'HTTP ' + r.status + '\n' + JSON.stringify(d, null, 2);
  } catch (e) { out.textContent = '请求失败: ' + e; }
}
async function loadBitAudit() {
  try {
    const r = await (await fetch('/api/bit/audit')).json();
    const es = (r.entries || []).slice(0, 20);
    document.getElementById('bitAuditTable').innerHTML = es.length
      ? '<tr><th>时间</th><th>来源</th><th>动作</th><th>对象</th></tr>' + es.map(e =>
        '<tr><td>' + esc(e.ts) + '</td><td>' + esc(e.actor) + '</td><td>' + esc(e.action) + '</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e.target) + '</td></tr>').join('')
      : '<tr><td class="sub">暂无审计记录</td></tr>';
  } catch {}
}

render(); refresh(); setInterval(refresh, 2000);
setInterval(() => { if (tab === 'virt' && !paused) loadPending(); }, 2000);
</script></body></html>`;

function serveUI(res, port) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(UI.replaceAll('${PORT}', String(port)));
}

module.exports = { serveUI };
