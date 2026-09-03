// 请求/响应自动分类与信息提取
// 依据: tools / tool_calls / function_call / markdown 特征 / role / model / usage
'use strict';

const MD_RULES = [
  ['code',    /```|~~~|^\s{4}\S/m],
  ['heading', /^#{1,6}\s/m],
  ['list',    /^\s*([-*+]|\d+\.)\s/m],
  ['table',   /^\|.+\|/m],
  ['quote',   /^>\s/m],
  ['link',    /\[[^\]]+\]\([^)]+\)/],
];

// 从请求体提取的结构化信息
function analyzeRequest(body) {
  const out = { categories: [], tools: [], toolCalls: [], model: null, session_id: null, messages: 0 };
  if (!body || typeof body !== 'object') return out;
  if (body.model) out.model = String(body.model);
  out.session_id = body.session_id || body.conversation_id || body.conversationId || null;
  if (Array.isArray(body.messages)) out.messages = body.messages.length;
  if (Array.isArray(body.tools)) {
    out.tools.push(...body.tools.map(t => t?.function?.name || t?.name).filter(Boolean));
    if (out.tools.length) out.categories.push('tools-defined');
  }
  walk(body, out);
  return out;
}

function walk(obj, out) {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) { obj.forEach(x => walk(x, out)); return; }
  const tc = obj.tool_calls || obj.message?.tool_calls;
  if (Array.isArray(tc)) {
    for (const c of tc) {
      const n = c?.function?.name || c?.name;
      if (n) { out.toolCalls.push({ name: n, args: c?.function?.arguments ?? c?.arguments ?? null }); out.categories.push('tool:' + n); }
    }
  }
  if (obj.function_call?.name) {
    out.toolCalls.push({ name: obj.function_call.name, args: obj.function_call.arguments ?? null });
    out.categories.push('tool:' + obj.function_call.name);
  }
  const text = typeof obj.content === 'string' ? obj.content
    : Array.isArray(obj.content) ? obj.content.map(p => p?.text || '').join('\n') : '';
  for (const [tag, re] of MD_RULES) if (re.test(text)) out.categories.push('md:' + tag);
  if (obj.role) out.categories.push('role:' + obj.role);
  Object.values(obj).forEach(v => walk(v, out));
}

// 从响应体（JSON）提取：tool_calls / usage / markdown
function analyzeResponseJson(body) {
  const out = { categories: [], tools: [], toolCalls: [], usage: null, model: null };
  if (!body || typeof body !== 'object') return out;
  if (body.usage && typeof body.usage === 'object') {
    out.usage = {
      prompt_tokens: body.usage.prompt_tokens ?? null,
      completion_tokens: body.usage.completion_tokens ?? null,
      total_tokens: body.usage.total_tokens ?? (body.usage.prompt_tokens ?? 0) + (body.usage.completion_tokens ?? 0),
    };
  }
  if (body.model) out.model = String(body.model);
  walk(body, out);
  return out;
}

// 从 SSE transcript 提取：usage（通常在最后一个 data 事件）与 model
// transcript 为完整文本（已按行拆过），这里只做轻量扫描
function analyzeSseText(text) {
  const out = { usage: null, model: null, toolCalls: [], categories: [] };
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const j = JSON.parse(data);
      if (!out.usage && j.usage && typeof j.usage === 'object') {
        out.usage = {
          prompt_tokens: j.usage.prompt_tokens ?? null,
          completion_tokens: j.usage.completion_tokens ?? null,
          total_tokens: j.usage.total_tokens ?? (j.usage.prompt_tokens ?? 0) + (j.usage.completion_tokens ?? 0),
        };
      }
      if (!out.model && j.model) out.model = String(j.model);
      if (out.usage && out.model) break;
    } catch { /* 非 JSON data 行忽略 */ }
  }
  return out;
}

// SSE 流式计数器：按字节喂入，按完整行统计 data: 事件数（多字节字符跨块安全）
function sseCounter() {
  let buf = [];
  let events = 0;
  return {
    feed(chunk) {
      buf.push(...chunk);
      let idx;
      while ((idx = buf.indexOf(10)) !== -1) {          // \n
        const line = Buffer.from(buf.slice(0, idx)).toString('utf8').replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.startsWith('data:')) events++;
      }
    },
    get events() { return events; },
  };
}

module.exports = { analyzeRequest, analyzeResponseJson, analyzeSseText, sseCounter };
