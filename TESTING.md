# ADB 测试说明
- 测试完成：是（2026-10-04）
- 测试日期：2026-10-04
- 测试内容：单元测试覆盖 lib/bit.js（call/handle 路由边界）、lib/classify.js（analyzeRequest/analyzeResponseJson/sseCounter）、lib/db.js（凭据脱敏/参数化查询）；注入测试覆盖路径穿越、XSS、伪协议、SQL注入、SSE流注入；钩子测试覆盖回调参数传递、错误隔离、事件顺序；集成测试覆盖 db+classify+bit 端到端协作
- 运行命令：npm test
- 测试框架：node:test（Node.js 内置测试运行器）
- 模型：豆包（Doubao）生成

## 测试目录结构

| 目录 | 说明 |
|------|------|
| `test/unit.js` | 原有单元测试（BIT 联动、对话分析、凭据脱敏） |
| `e2e/` | 原有端到端测试（fake-bit 模拟上游） |
| `tests/injection.test.js` | **新增** 注入测试：XSS、路径穿越、伪协议、SQL 注入、SSE 流注入 |
| `tests/hooks.test.js` | **新增** 钩子/交互测试：回调参数传递、错误隔离、事件顺序 |
| `tests/integration.test.js` | **新增** 集成测试：db+classify+bit 端到端协作 |

## 运行方式

```bash
# 运行全部测试（原有 unit + e2e + 新增 audit）
npm test

# 仅运行新增测试
npm run test:audit

# 仅运行原有测试
npm run unit
npm run e2e
```

## 测试覆盖说明

### 注入测试（tests/injection.test.js，10 个用例）
- **路径穿越**：session id / tool name 含 `../`、URL 编码穿越、JNDI 注入 → 均被白名单正则拒绝 (404)
- **XSS 载荷**：`<script>`、`<img onerror>`、`javascript:`、SVG onload → 分类器不崩溃，代理原样透传
- **伪协议**：`javascript:`、`data:`、`file:`、`ftp:`、`gopher:`、CRLF 注入 → 均被拒绝 (400)
- **SQL 注入**：config 值注入 DROP TABLE、listRequests q 参数注入 OR 1=1 → 参数化查询防护
- **SSE 流注入**：截断 JSON、超长行、多字节字符跨块切断 → sseCounter 不损坏

### 钩子/交互测试（tests/hooks.test.js，7 个用例）
- **回调参数**：dbInsert 收到完整记录（ts/method/path/target/tags/session_id 字段齐全）
- **错误隔离**：dbInsert 抛异常不影响代理响应；多监听器一个抛异常不阻断后续
- **事件顺序**：先 writeHead 再 end；空 message 直接 400 不打上游不写记录

### 集成测试（tests/integration.test.js，5 个用例）
- **端到端流程**：设置凭据 → chat 代理 → 记录入库 → listRequests 可查到
- **错误路径**：上游 500 → 记录带 error 字段 → stats.err_count 计数
- **模块协作**：classify.analyzeResponseJson 的 usage 写入 db
- **只读路由集**：health/state/tools/mcp/audit/sessions 全部代理成功

## 预期结果

全部 22 个新增测试用例通过（0 失败）。
