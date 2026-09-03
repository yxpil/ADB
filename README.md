# ADB — Agent Debug Bridge

智能体调试桥梁：一个**零依赖**的 Node.js 转发代理，把 Agent（或任意 SDK）的 API 请求
转发到你随便指定的上游，同时**全量、不中断**地记录每一笔请求/响应到 SQLite，
并提供会话分组、统计分析与黑白圆角简约风格的 Web 面板。

- 流式转发：SSE 逐事件透传，客户端收到的字节与上游产生的字节**逐字节一致**（多字节字符跨 TCP 分块安全）
- 全量记录：请求/响应体不截断（大体积经临时文件 spool 落盘），SSE 存完整 transcript 与精确事件数
- 随便填上游：请求头（URL 或预设名）、路径前缀、默认目标三种方式，面板设置页随时改
- 虚拟调试：内置虚拟 MCP 服务器、人工扮演 AI（manual）、虚拟 E2E 场景端点（见下文「调试 BIT」）
- 会话分析：按 session_id 分组统计 token 用量、错误数、SSE 流数；统计按模型 / 目标 / 工具 / 日期聚合
- 零依赖：仅用 Node.js 内置模块（含 `node:sqlite`），无需 npm install

## 环境要求

- Node.js **>= 22.5.0**（需要内置 `node:sqlite`）

## 启动

```bash
node server.js              # 默认监听 8987
PORT=9000 node server.js    # 自定义端口
ADB_DB=./my.db node server.js   # 自定义 SQLite 路径（默认 data/adb.db，WAL 模式）
```

打开面板：http://127.0.0.1:8987

## 调试 BIT（三种玩法）

ADB 面板新增「虚拟」页，专为 BIT 用户设计——不用改 BIT 代码，填个地址就能调试问题、
分析问题、报告问题。

### 1. 虚拟 MCP 服务器

BIT「设置 → MCP 服务器」里把服务器 URL 填成：

```
http://127.0.0.1:8987/mcp
```

完全遵循 Streamable HTTP / JSON-RPC 2.0（initialize 握手 → Mcp-Session-Id →
notifications/initialized → tools/list → tools/call），与 BIT 的 MCP 客户端完全兼容。

- 内置工具：`echo`（回显）/ `add`（加法）/ `now`（时间）
- 面板「虚拟」页可添加自定义工具：
  - **fixed 模式**：返回你预设的固定结果——模拟任意工具行为，观察 AI 拿到结果后的决策
  - **manual 模式**：调用挂起，你在面板里输入结果后 AI 才继续——你扮演工具，可模拟超时、报错、异常返回
- 每笔 JSON-RPC 全量入库（`mcp` / `mcp:<method>` / `tool:<name>` 标签）

### 2. 人工扮演 AI（manual 模式）

BIT 里新建一个 **OpenAI 协议** 的 provider，Base URL 填：

```
http://127.0.0.1:8987/manual
```

BIT 发出的每条消息都会挂起，出现在面板「虚拟」页的「待应答」列表里（含完整请求体预览、
模型名、会话 ID）。你输入什么，AI 就"说"什么：

- **整包回复**：输入文本，以标准 `chat.completion` 结构返回
- **流式回复**：勾选流式，文本被切成 delta 事件逐字输出（模拟真实打字机）
- **回 500**：一键模拟上游故障，验证 BIT 的错误处理与用户提示
- **raw 模式**（API）：返回任意 JSON，Claude / Gemini 协议调试兜底

典型用途：复现"AI 说了不该说的话"、扮演故障 AI 测容错、验证多轮对话行为。

也可以用请求头方式：`x-adb-target: manual`。

### 3. 虚拟 E2E 场景端点

BIT 新建 OpenAI 协议 provider，Base URL 填 `http://127.0.0.1:8987/mock`，
按场景在路径里选择（BIT 自动拼接 `/chat/completions`，天然兼容）：

| 端点 | 场景 |
|---|---|
| `POST /mock/chat` | 正常 JSON 对话（回显最后一条 user 消息） |
| `POST /mock/toolcall?name=shell` | 返回 tool_calls（`?name=` 指定工具名） |
| `POST /mock/stream?events=50&interval=10` | SSE 流式（事件数与间隔可调） |
| `POST /mock/slow?ms=500` | 慢流（每 chunk 间隔 500ms，测超时/取消） |
| `POST /mock/die?after=3` | 发 3 个事件后异常断开（测中断恢复） |
| `GET /mock/big?kb=1024` | 1MB 大响应 |
| `POST /mock/echo` | 原样回显请求体与关键请求头（透传校验） |
| `POST /mock/fail` | 500 错误 |

所有 mock 交互自动入库（`mock` 标签），在「请求」页可查。

### 待应答队列 API

```bash
# 查看挂起中的请求（ai = 人工扮演 AI，mcp = 人工应答工具）
curl http://127.0.0.1:8987/api/pending

# 应答（ai：mode=auto 文本自动包装 / mode=raw 原样 / mode=error 错误）
curl -X POST http://127.0.0.1:8987/api/pending/<id>/respond \
  -H "content-type: application/json" \
  -d '{"mode":"auto","text":"你扮演的 AI 回复","stream":true,"chunk_ms":20}'

# 应答 MCP 工具调用
curl -X POST http://127.0.0.1:8987/api/pending/<id>/respond \
  -H "content-type: application/json" \
  -d '{"text":"工具执行结果","is_error":false}'
```

挂起默认 5 分钟超时（`ADB_VIRTUAL_TIMEOUT` 环境变量可调），超时/客户端断开都会完整入库，不悬挂。

## 接入（三选一）

**方式一：请求头（推荐）**——值可以是完整 URL，也可以是设置页里配置的预设名

```js
// 以 OpenAI SDK 为例
const client = new OpenAI({
  baseURL: "http://127.0.0.1:8987/v1",
  defaultHeaders: { "x-adb-target": "https://api.openai.com" },  // 或预设名 "openai"
});
```

```bash
curl http://127.0.0.1:8987/v1/chat/completions \
  -H "x-adb-target: https://api.openai.com" \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

**方式二：路径前缀**（无端口默认 https；显式端口非 443 走 http）

```
POST http://127.0.0.1:8987/forward/api.openai.com/v1/chat/completions
POST http://127.0.0.1:8987/forward/127.0.0.1:11434/v1/chat/completions
```

**方式三：默认目标**——面板「设置」里填默认目标，不带 `x-adb-target` 的请求全部转发过去。

## AI 主动发消息（注入系统指令）

调试 Agent（如 BIT）的主动行为：开启后，ADB 会在转发请求的 `messages` 末尾追加一条
system 指令（默认「你现在可以主动发送一条信息」，文本可随意编辑），让模型在会话中
主动发消息、处理系统事件，从而观察 Agent 侧如何响应。

- 面板「设置」→「AI 主动发消息」：开关 + 指令文本
- API：`POST /api/config`，body `{"inject_system": true, "inject_text": "你现在可以主动发送一条信息"}`
- 单次请求覆盖：请求头 `x-adb-inject: <自定义文本>`；`x-adb-inject: off` 强制关闭（该头不会透传上游）
- 仅对含 `messages` 数组的 JSON 请求生效；被注入的请求打 `injected` 标签，入库的是实际发往上游的请求体

## 自动分类

面板顶部是分类标签，点击过滤。规则：

- `tool:xxx` — 请求/响应中出现的每个工具名（tools / tool_calls / function_call）
- `tools-defined` — 请求里声明了工具列表
- `md:code / md:heading / md:list / md:table / md:quote / md:link` — 消息内容里的 markdown 特征
- `role:user / role:assistant / role:system` — 消息角色
- `error` — 上游 4xx/5xx 或转发失败
- `virtual` / `mock` / `mcp` — 虚拟调试产生的记录（人工扮演、场景端点、虚拟 MCP）

每条记录还提取：model、session_id、api_key_hint（脱敏）、usage（token 用量，SSE 从流内提取）、
SSE 事件数与流时长、请求/响应头与完整请求/响应体。

## API

| 端点 | 说明 |
|---|---|
| `GET /api/records?limit&offset&session&tag&status&q` | 记录列表（不含大字段） |
| `GET /api/record/:id` | 单条完整记录（含请求/响应体） |
| `GET /api/stats` | 总量/错误/耗时/token 聚合 + 按模型/目标/日期/工具分组 |
| `GET /api/sessions` | 会话分组统计（笔数、token、错误、SSE 数） |
| `GET /api/pending` | 待应答队列（人工扮演 AI / 人工应答 MCP 工具） |
| `POST /api/pending/:id/respond` | 应答挂起中的请求 |
| `POST /mcp` | 虚拟 MCP 服务器（Streamable HTTP / JSON-RPC 2.0） |
| `POST /mock/*` | 虚拟 E2E 场景端点 |
| `GET /api/export` | 全量导出 NDJSON |
| `GET /api/config` · `POST /api/config` | 读取/设置默认目标、预设列表、注入指令、虚拟 MCP 工具 |
| `POST /api/records/clear` | 清空记录 |
| `GET /api/health` | 健康检查（含版本号与实例 token） |

## 测试

内置确定性假上游（JSON/SSE/慢流/中断/大响应等场景）+ 93 项 E2E 断言：

```bash
npm run e2e
```

覆盖：三种目标解析、请求头透传与 accept-encoding 强制 identity、SSE 字节级一致性、
多字节跨块完整性、事件精确计数、客户端中断/上游中断、20MB 响应与 5MB 请求全量入库、
会话分组、统计与导出、SQLite 重启持久化、300 并发混合压力（并发 50）、10 路 2000 事件并发长流、
系统指令注入；虚拟调试全链路（虚拟 MCP 握手/工具/人工应答、人工扮演 AI 整包/流式/错误/raw/断开、
8 个 mock 场景与入库）。

仅用 Node.js 内置模块，无需安装任何依赖。

## 数据与隐私

ADB 是纯本机工具，设计目标是"你的数据不出你的机器"：

- **存储**：所有记录写入本地 SQLite（默认 `data/adb.db`，WAL 模式）。只有你主动 `GET /api/export` 或拷贝 db 文件，数据才会离开机器。
- **密钥保护**：请求头里的 `authorization` 等凭据会随请求原样转发给上游（否则无法工作），但入库时**只保留脱敏提示** `api_key_hint`（如 `sk-abc…` 前 6 位 + 长度），完整密钥不落盘。ADB 面板与 API 都拿不到完整密钥。
- **不共享**：无遥测、无崩溃上报、无账号体系；ADB 不会向你未配置的上游之外的任何地址发数据（唯一外联是你自己填的转发目标与 `dns` 解析）。
- **安全边界**：ADB 默认监听 `127.0.0.1`，仅本机可访问；不要把 8987 端口暴露到公网（面板可清空/导出全部记录，且转发无认证）。如需远程使用，请前置带认证的反向代理。

## 二次开发

零依赖意味着克隆即可改。目录结构：

```
server.js            入口：路由分发（面板/API/虚拟端点/转发）
lib/forward.js       转发核心：流式转发 + spool 落盘 + 全量记录 + 虚拟 AI（manual）
lib/classify.js      自动分类：工具名/markdown 特征/角色/错误 提取
lib/db.js            SQLite：schema、记录读写、配置（预设/注入/虚拟 MCP 工具）
lib/virtual.js       人工应答基础设施：挂起队列（超时兜底/断开回调）
lib/vmcp.js          虚拟 MCP 服务器（JSON-RPC 2.0）
lib/mockai.js        虚拟 E2E 场景端点（/mock/*）
lib/ui.js            面板（单文件 HTML/JS/CSS，黑白药丸风格）
e2e/run.js           E2E：93 项断言（含假上游 e2e/fake-upstream.js）
```

常见改动入口：

- **加一个 mock 场景**：在 `lib/mockai.js` 加一个 `scene === 'xxx'` 分支（响应后调 `finish()` 入库），再在 E2E 的 S24 组补断言。
- **加一种应答模式**：在 `lib/forward.js` 的 `virtualAi/write` 里扩展 `answer.mode` 分支（auto/raw/error 之外），面板在 `lib/ui.js` 的 `renderPending` 加对应表单。
- **加面板页**：`lib/ui.js` 里 tabs 数组加 id、加 `<div id="xxx" class="tab">`、写 `loadXxx()` 并挂到 tab 切换。
- **改记录字段**：先改 `lib/db.js` 的建表与 `insertRequest`，再同步 `forward.js` / `server.js`（recordVirtualRpc）与 `mockai.js` 三处组装点。

约定：安全相关行为（api_key_hint 脱敏、aborted 标记、超时兜底）改动必须带 E2E 断言；E2E 跑三连轮再提交。

## License

Apache-2.0
