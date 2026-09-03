// 确定性 SSE 事件生成器：fake-upstream 发送、e2e 断言两侧共用同一函数 → 字节级比对
'use strict';

function genSseEvents(model) {
  const events = [];
  // 首块：带 model
  events.push(`data: ${JSON.stringify({ id: 'e2e', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`);
  // 20 个内容块：中文 + emoji + markdown（多字节密集）
  const contents = [
    '# ADB 标题\n', '段落一：转发**完整**记录。\n', '```js\nconst x = 1;\n```\n',
    '- 列表 甲\n', '- 列表 乙 🌑\n', '中文混 English 混 🌏 emoji。\n', '> 引用一行\n',
    '| 表 | 格 |\n', '|---|---|\n', '[链接](https://example.com)\n',
    '多字节换行测试：\n', '你好世界 🌕🌑🌒\n', 'سطر عربي\n', '日本語のテスト\n', '한국어 텍스트\n',
    '特殊字符 <>&"\'\n', 'tab\ttest\n', '数字 1234567890\n', '尾随空格   \n', 'END-MARKER-DONE\n',
  ];
  for (const c of contents) {
    events.push(`data: ${JSON.stringify({ id: 'e2e', choices: [{ index: 0, delta: { content: c } }] })}\n\n`);
  }
  // 尾块：usage
  events.push(`data: ${JSON.stringify({ id: 'e2e', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 21, completion_tokens: 65, total_tokens: 86 } })}\n\n`);
  events.push('data: [DONE]\n\n');
  return events;
}

function expectedSseText(model) {
  return genSseEvents(model).join('');
}

module.exports = { genSseEvents, expectedSseText };
