# Hermes 聊天集成勘查报告（7A）

> 日期：2026-09-22 · 方法：只读勘查（代码、配置、进程与容器状态）。**未修改任何 Hermes 配置/源码，未启动/重启任何服务，未调用任何端点。**
> 门槛结论：**7B/7C 可实施**（同源代理 + 常驻抽屉）；真实上游验收（用真实 key 跑通一轮会话）属于 7D，由父助手独立确认后执行。

## 1. 运行事实

| 事实 | 值 | 证据 |
|---|---|---|
| Agent API Server 进程 | Docker 容器 `hermes`（镜像 hermes-agent:latest，`gateway run`） | `docker ps` |
| 监听端口 | 容器 8642 → 宿主 `0.0.0.0:8642` 与 `[::]:8642` | `ss -tlnp`、`docker-proxy` 进程 |
| 平台状态 | `api_server` 平台 `state: connected` | 容器内 `/opt/data/gateway_state.json` |
| 宿主侧 gateway | `hermes-gateway.service`（`~/.hermes`，profile `xh`）仅服务 photon（微信）平台，与容器实例相互独立 | 宿主 `/home/ubuntu/.hermes/gateway_state.json` |
| 代码版本 | 0.21.3（sha `dacae4c`） | gateway_state.json `code_version` |

Manager Show 生产部署（`/home/ubuntu/Manager_Show`）与宿主 gateway 无关联；实施者全程未触碰生产目录。

## 2. 鉴权模型

- API server 要求 `Authorization: Bearer <API_SERVER_KEY>`；key 配置于容器 `/opt/data/.env`（`API_SERVER_KEY`）。
- 凭据不落盘到 Manager Show 代码/文档/测试：7B 同源代理由 Manager Show **服务端**持有 key（环境变量注入），浏览器不接触。
- 会话另有可选 `X-Hermes-Session-Key` 头；创建会话不返回 key，chat 可省略。
- 未启用任何「高权限公开聊天」面：未发现 whitelist 关闭或匿名入口。

## 3. 端点契约（gateway/platforms/api_server.py `_http_route_table`）

健康与元数据（7B 探活用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health`、`/health/detailed`、`/v1/health` | 健康检查 |
| GET | `/v1/models` | 广告模型名（默认 profile 下为 `hermes-agent`） |
| GET | `/v1/capabilities` | 能力清单 |

会话与消息（7B 对话流用）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/sessions` | 创建空会话。body：`id`/`session_id`（可选，缺省生成 `api_<ts>_<hex>`）、`title`、`system_prompt`、`source`（默认 `api_server`）、`model`/`provider`/`model_options`/`require_model_lock`。201 → `{"object":"hermes.session","session":{id,source,title,model,...}}`；响应头 `X-Hermes-Session-Id` |
| GET | `/api/sessions`、`/api/sessions/{id}` | 会话列表/详情 |
| PATCH/DELETE | `/api/sessions/{id}` | 改标题等 / 删除 |
| GET | `/api/sessions/{id}/messages` | 会话消息（role/content/timestamp…） |
| POST | `/api/sessions/{id}/chat` | **一次同步 agent turn（非流式）**。body：`message` 或 `input`（文本）；响应 `{"object":"hermes.session.chat.completion","session_id","message":{"role":"assistant","content"},"usage","runtime"}` |
| POST | `/api/sessions/{id}/chat/stream` | SSE 流式（7B 不用，取非流式） |

其它（7B 明确不用）：`/v1/chat/completions`、`/v1/responses`、`/api/jobs*`、`/v1/runs*`、browser-control、artifacts、skills、toolsets、`/api/cron/fire`。

## 4. 与计划对齐的要点

- **model 名**：`API_SERVER_MODEL_NAME` 默认 = profile 名；默认 profile 下为 `hermes-agent`（与计划 7B 的 `model:'hermes-agent'` 一致）。
- **stream=false**：`/chat` 端点天然同步返回完整回复，无需流式参数；仅 `/chat/stream` 为 SSE。
- **会话**：7B 创建独立 Manager Show session（`source` 或 `title` 标识），不复用 Hermes 其它会话。
- **工具面**：`/chat` 走 `_run_agent` 完整 agent turn（Hermes 默认 toolset；无按会话工具白名单字段）。7B 代理只转发用户文本、不注入工具调用；风险由 Hermes 侧 `tool_loop_guardrails`、`max_concurrent_runs`（默认 10）与 Manager Show 侧限流共同兜底。
- **会话存储**：Hermes 会话/消息有 `session_history_delivery="1"`（audited native-session opt-in，代码注释 #98619）——chat 轮次落 Hermes 会话史。

## 5. 未确认事项（如实记录）

1. **api_server 平台显式启用配置源未定位**：容器 `/opt/data/config.yaml` 与 `config.yaml.bak` 均无 `platforms.api_server` 段，容器环境与 `.env` 无 `API_SERVER_ENABLED`（仅 `API_SERVER_KEY`），但 gateway_state 证实平台 connected。可能由新版 gateway 在检测到 `API_SERVER_KEY` 时自动启用，或镜像构建时固化。不影响 7B 设计；7D 验收前由父助手确认。
2. **Bearer 有效性**：只读勘察未携带真实 key 调用端点（避免任何写入/副作用）；key 是否可完成一次真实 chat turn 属 7D。
3. **端口暴露面**：8642 绑定 0.0.0.0（非仅 loopback）——对外暴露与否取决于宿主防火墙；同源代理模式下 Manager Show 服务端走 loopback 调用，浏览器不直连 8642。

## 6. 7B 设计要点（预告，实施时落地）

- Manager Show 同源路由：`POST /api/chat/conversation`（创建 Hermes 会话，返回本地 id 映射）、`POST /api/chat/messages`（转发 `/chat`，`stream=false`，`model:'hermes-agent'`）；`GET /api/chat/messages`（读回 Hermes `/messages`）。
- 服务端持有 `HERMES_API_KEY`（环境变量，缺省则 503「未配置上游」，不编造连通性）；Bearer 不出服务端。
- 限流：1 并发 / 10 次每分钟；幂等 `requestId`（重复提交返回同一次结果，不重复触发上游）。
- 不自动注入 DB 内容（不把任务/投递数据自动塞进上下文）；不暴露 jobs/browser-control/artifacts 等危险端点。
- 上游 4xx/5xx 原样转达为明确错误信息，不假回复。

## 7. 门槛清单

- [x] 7A 只读勘察（本文件）
- [x] 7B 同源代理（`src/hermes-chat.js` + `/api/chat/*`，可隔离测试；提交 `d859399`）
- [x] 7C 常驻抽屉 UI（`public/chat.js`，#view 之外，Esc/Enter/IME；提交见实施报告）
- [x] 7D 真实上游验收：**已完成**。接的是本地默认实例（不是容器里那个旧实例），工具面已先收紧到 `web/vision/todo`，接口只绑回环；真实会话轮次跑通，且行为验证确认读文件/执行命令均被拒。详见第 8 节。

## 8. 7D 真实接入结果（2026-09-22 验收）

**接哪个实例**：本地默认 profile（`~/.hermes`，0.21.3，systemd 用户服务 `hermes-gateway.service`，平台 `weixin` + `photon`）。容器 `hermes`（0.20.6，旧实例，平台 `api_server` + `weixin`）**不是**本次接的对象；它曾把 13 个工具集全暴露给任何能连上其 API 的进程，已于本次先收紧后按其主人要求**回滚为原状**（与备份逐字一致）。

**上游侧配置**
- `~/.hermes/.env`：`API_SERVER_ENABLED=true`、`API_SERVER_KEY`（`openssl rand -hex 32`，适配器拒绝弱密钥）、`API_SERVER_HOST=127.0.0.1`、`API_SERVER_PORT=8643`（8642 被容器端口发布占用）。
- `~/.hermes/config.yaml`：`platform_toolsets.api_server: [web, vision, todo]` —— **先限权再启用**，绝不带全量工具启动。
- 网关重启由用户执行（agent 终端被守护拦截，且从网关进程内部重启会杀掉自己）。

**核验证据**
- 监听：`ss -ltn` → 仅 `127.0.0.1:8643`（不对外）。
- `GET /v1/toolsets`（认证）→ 3 个工具集：`web(web_search, web_extract)`、`vision(vision_analyze)`、`todo(todo_list)`；未认证 → 401（`/v1/health` 按设计免认证，仅返回 status/platform/version）。
- `gateway_state.json` → `api_server`、`weixin`、`photon` 三者 `connected`；其它平台工具面 17 个，未受影响。
- 行为验证（真实会话）：读 `/etc/hostname` → 「当前会话未提供本地文件读取工具」；执行 `id` → 「当前会话未提供终端执行工具」；都未编造结果。**注意**：同一限制下问它"你能做什么"它会泛泛回答"能处理文件与任务"——那是模型的通用自我介绍，不是能力证据，只能以工具列表和行为测试为准。

**Manager Show 侧**：`/etc/manager-show/manager-show.env`（600）新增 `HERMES_API_BASE_URL=http://127.0.0.1:8643`、`HERMES_API_KEY`（与上游同值，哈希核对一致）；重启 `manager-show` 后生效。

**端到端验收**（临时实例：生产代码 + 生产库副本 → 真实本地 API，用后删除）：未登录 `/api/chat/status` → 401；配置上游后聊天入口可见；新建会话 → 输入框出现；发送消息 → **真实上游返回回复**（非错误态）。唯一 4xx 是登录页预期的 `GET /api/auth/me` 401，属设计行为。
