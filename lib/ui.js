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
  for (const id of ['req','sess','stats','cfg']) document.getElementById(id).style.display = (id === tab || (id === 'req' && tab === 'req')) ? '' : 'none';
  document.getElementById('req').style.display = tab === 'req' ? '' : 'none';
  if (tab === 'sess') loadSessions();
  if (tab === 'stats') loadStats();
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
    document.getElementById('presetTable').innerHTML =
      '<tr><th>名称</th><th>Base URL</th><th></th></tr>' +
      cfgData.presets.map((p, i) => '<tr><td><code>' + esc(p.name) + '</code></td><td>' + esc(p.base_url) + '</td>' +
        '<td><button class="pill danger" style="padding:2px 12px;font-size:11px" onclick="delPreset(' + i + ')">删除</button></td></tr>').join('');
  } catch {}
}
async function saveCfg() {
  cfgData.default_target = document.getElementById('defTarget').value.trim();
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

render(); refresh(); setInterval(refresh, 2000);
</script></body></html>`;

function serveUI(res, port) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(UI.replaceAll('${PORT}', String(port)));
}

module.exports = { serveUI };
