# ADB — Agent Debug Bridge

智能体调试桥梁：一个**零依赖**的 Node.js 转发代理，把 Agent（或任意 SDK）的 API 请求
转发到你随便指定的上游，同时**全量、不中断**地记录每一笔请求/响应到 SQLite，
并提供会话分组、统计分析与黑白圆角简约风格的 Web 面板。

- 流式转发：SSE 逐事件透传，客户端收到的字节与上游产生的字节**逐字节一致**（多字节字符跨 TCP 分块安全）
- 全量记录：请求/响应体不截断（大体积经临时文件 spool 落盘），SSE 存完整 transcript 与精确事件数
- 随便填上游：请求头（URL 或预设名）、路径前缀、默认目标三种方式，面板设置页随时改
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

每条记录还提取：model、session_id、api_key_hint（脱敏）、usage（token 用量，SSE 从流内提取）、
SSE 事件数与流时长、请求/响应头与完整请求/响应体。

## API

| 端点 | 说明 |
|---|---|
| `GET /api/records?limit&offset&session&tag&status&q` | 记录列表（不含大字段） |
| `GET /api/record/:id` | 单条完整记录（含请求/响应体） |
| `GET /api/stats` | 总量/错误/耗时/token 聚合 + 按模型/目标/日期/工具分组 |
| `GET /api/sessions` | 会话分组统计（笔数、token、错误、SSE 数） |
| `GET /api/export` | 全量导出 NDJSON |
| `GET /api/config` · `POST /api/config` | 读取/设置默认目标与预设列表 |
| `POST /api/records/clear` | 清空记录 |
| `GET /api/health` | 健康检查（含版本号与实例 token） |

## 测试

内置确定性假上游（JSON/SSE/慢流/中断/大响应等场景）+ 51 项 E2E 断言：

```bash
npm run e2e
```

覆盖：三种目标解析、请求头透传与 accept-encoding 强制 identity、SSE 字节级一致性、
多字节跨块完整性、事件精确计数、客户端中断/上游中断、20MB 响应与 5MB 请求全量入库、
会话分组、统计与导出、SQLite 重启持久化、300 并发混合压力（并发 50）、10 路 2000 事件并发长流。

仅用 Node.js 内置模块，无需安装任何依赖。

## License

Apache-2.0
