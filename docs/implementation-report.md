# Manager Show 实施报告（进行中）

> 本文件持续记录已完成步骤、准确测试命令与摘要、未完成门槛。此文件是实施报告，不是计划。

## 环境与基线

- 工作副本：`/home/ubuntu/Hermes文件管理/manager-show-repair/worktree`（隔离 git worktree，生产目录未做任何修改）
- 分支：`feat/actions-reminders-chat`（基于 `d9b6b5b`）
- Node：`v22.23.2`（`/home/ubuntu/.hermes/node/bin`），npm `12.0.2`
- 基线测试：`npm test` → **49 pass / 0 fail**
- 继承未提交改动（保留，不覆盖、不提交，将在最终说明中单独列出）：
  - `scripts/sync-from-sources.js`：笔试状态识别新增「待参加」
  - `test/source-sync.test.js`：同步测试用例更新（京东笔试待参加）

## 完成步骤

### 0A. 建立可重复的浏览器回归环境

- 依赖安装：`npm install --save-dev --save-exact playwright`
- 浏览器：`npx playwright install chromium`
- 新建 `support/browser-harness.js`（每测试独立临时 DB、真实登录 Cookie、pageerror/console.error 收集）、`test/browser-actions.test.js`
- 提交：`6a2fcff`

### 1A. 真实浏览器 CRUD 回归

- `test/browser-actions.test.js`：冒烟、投递新增、任务创建/勾选/编辑/删除/取消、日程 CRUD、成果 CRUD、搜索筛选
- 提交：`66b6dc7`

### 1B. 交互契约与守卫

- 网络 500 保留输入 + toast、单次提交仅一个 POST、导航竞态守卫（旧保存回调不覆盖新路由）
- 提交：`c810080`

### 2A/2B. 缓存失效与异步渲染守卫

- 发现并修复 204 响应未失效缓存导致删除行复活的真实缺陷（api() 顺序：401 → !ok → invalidateFor → 204 → json）
- `test/cache-behavior.test.js`：DELETE 后不复活；过期陈旧 GET 不复活
- 后台刷新守卫（navSeq + rerenderSeq + viewBeingEdited），编辑中不被后台刷新打断
- 提交：`b44eb1b`（2A）、`4e79833`（2B）

### 3A. 首页可解释明细集合

- 服务端 dashboard 新增 `openTasks`（全部未完成，按截止排序）、`interviewApplications`（笔试/面试，按下一步日期排序），统计数字与明细集合同源；`test/dashboard-details.test.js`
- 提交：`0682f7d`

### 3B. 可导航筛选与深链

- URL 参数驱动 campus/tasks 视图（`stage=interviewing` 组合筛选、`status`、`state`、`category`、`id` 深链），前进后退可用，非法 id 不请求
- `test/route-filters.test.js`（6 用例）
- 提交：`361f2c4`

### 3C. 首页重排与统计入口

- 首页按第 2 节规格重排：快捷新增（新增待办/新增投递）→ 全部待办摘要（复用 taskRow，>5 项显示「查看全部 N 项」）→ 今日重点（空态提供新增待办按钮）→ 提醒（逾期/风险）→ 近期日程（复用 eventItem）→ 求职摘要 + 笔试/面试明细（复用 openTasks/interviewApplications，无下一步日期明确「未安排」，条目深链到投递记录）
- 统计卡由无效果的 div 改为真实 `<a href>`：投递总数→`#/campus`、笔试/面试中→`#/campus?stage=interviewing`、Offer→`#/campus?status=Offer`、待办任务→`#/tasks?state=open`、成果记录→`#/achievements`
- `openTaskModal` 支持新增模式（`openTaskModal(null)`）
- 测试：先 RED（4 个新首页用例，全部因缺少 `.dash-todo`/`.dash-interviews`/`.dash-focus`/链接真实失败）后 GREEN
  - `node --test --test-name-pattern="首页" test/browser-actions.test.js` → 4/4 pass
- 回归：`npm test` → **79 pass / 0 fail**（连续两轮全量通过）
  - 顺带修复 `test/route-filters.test.js` 后退恢复用例的等待竞态（面试公司在两种视图下均可见，改为等待筛选真正恢复）
  - `test/public-ui.test.js` 结构类契约更新为新首页类名（quick-add/dash-todo/dash-focus/dash-interviews）并断言统计卡为 `<a class="card stat">`
- 提交：`4026ccb`

### 4A. 通用个人待办（不只是求职）

- 分类扩展为通用集合：`TASK_CATEGORIES = ['生活', '工作', '学习', '求职', '实习', '其他']`，新增/编辑共用同一表单（首页快捷新增、首页重点空态、任务页新增三处入口），默认分类「生活」
- 自定义分类透传：服务端 `optStr(category, 50, '其他')` 不限制枚举，客户端表单注入自定义分类选项（服务端 `optStr` 不限制枚举，客户端表单注入现有分类供选择）
- 语义：待办是一般用途个人待办，求职只是其中一类
- 测试：先 RED（4 个新用例全部因缺少通用分类/共用表单真实失败，经 checkout-to-HEAD + git-apply-patch 诚实验证）后 GREEN；`test/browser-actions.test.js` 4A 用例 + `test/tasks-events.test.js` 分类透传回归
- 提交：`093d178`

### 4B. 时间与同步数据边界

- **中国时区语义**（前后端一致）：`src/dates.js` 重写——`todayLocal` 用 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })` formatToParts 计算；`parseDateTimeLocalCN` 正则 + isValidDate/isValidTime 严格校验（非法输入返回 null，杜绝 `02-30 → 03-02` 这类 JS Date 滚动）
- 前端 `initChrome` 问候语与日期均按上海时区（weekday 由 `todayStr` 拆分计算，小时 `(getUTCHours()+8)%24`）
- **同步记录只读**：`tasksHaveSource`（createApp 时 pragma 探测）；POST /api/tasks 写入 `source='manual'`；PATCH/DELETE 对 `row.source && row.source !== 'manual'` 返回 409「同步记录只读，请复制为个人待办」
- 任务行同步感知：无 checkbox/编辑入口，显示「同步 · <source>」badge + 「复制为个人待办」按钮（预填表单 → POST 独立 manual 副本）
- 测试：`test/tasks-events.test.js` 日期语义（todayLocal 注入、parseDateTimeLocalCN 各用例、isValidDate）+ source=manual；`test/browser-actions.test.js` 4B 时间/同步用例；`support/server-harness.js` `localToday` 委托 `src/dates`
- 提交：`197f741`

### 5A. 控件审计与破坏性入口移除

- 新建 `docs/control-audit.md`：32 行控件审计表（页面/控件/保留删除/请求/结果/错误态/对应测试），保留的每行控件都有真实效果与测试，提醒与聊天行标注「计划中（待 6C/7C 回填）」
- 移除 `#btn-reset-seed` 按钮及绑定；`POST /api/seed/reset` 默认不注册（仅 `createApp({ allowSeedReset: true })` 的隔离测试/演示实例可用），登录后访问默认 404；认证/CSRF 中间件不变
- 退出登录、手机菜单保持可用并补测试；`test/public-ui.test.js`/`test/nav-motion.test.js` 契约更新为「无 reset 入口」；`test/applications.test.js` 显式开启 allowSeedReset
- 提交：`52e8734`

### 6A. 提醒持久层

- `src/db.js` 迁移新增 `reminders` 表（entity_type CHECK task/event、status CHECK scheduled/unread/read/cancelled、triggered_at/read_at）+ `reminders_due` 索引 + `reminders_active_entity` 部分唯一索引（同一实体同时只有一个活跃提醒）；迁移幂等、不丢既有行
- 新建 `src/reminders.js` 服务模块：稳定实体键 `manual:<id>` / `<source>:<external_key>`（同步脚本会重建自增 id，不持有裸 id）；`withTransaction`、`parseEntityKey`、`resolveEntity`（不存在 null / 无法判断 undefined）、`activeKeysFor`、`cancelActiveForEntity`、`activateDue`（到期 scheduled → unread，幂等）、`cancelInvalid`（实体删除或任务完成 → 取消）
- 测试：先 RED（2 个真实失败：建表与唯一约束）后 GREEN 3/3；全量回归 **93/93 pass**
- 提交：`37d94e5`

### 6B. 提醒 API（受保护端点）

- `POST /api/reminders`：entity_type 限 task/event；entity_key 非法 400、同步键无 source 列 400（提示复制为个人待办）、实体不存在 404、任务已完成 400；remind_at 必须带时区（Z/±HH:MM）且严格晚于当前时刻（`parseRemindAt` 正则 + Date.parse 双重校验）；201 返回完整记录（含 entity_title 与可跳转 entity_id）；重复活跃 → 409
- `GET /api/reminders`：同一事务内先激活到期（scheduled 且 remind_at≤now → unread + triggered_at）再按实体状态清理无效记录；返回 unread 优先 + scheduled；重复 GET 不重复触发
- `PATCH /api/reminders/:id`：仅允许改未来提醒时间或 status=read/cancelled；携带 entity_type/entity_key 一律 400（不允许篡改关联实体）；终态提醒不可改时间
- 任务完成、任务删除、日程删除：`withTransaction` 同一事务内取消活跃提醒，失败整体回滚，无半更新；撤销完成不复活
- 时钟注入：`createApp({ now })`（默认 nowIso），测试用注入时钟推进，不真等时间
- 安全回归：`test/security.test.js` 未登录读列表 + 未登录写列表 + CSRF 用例加入 /api/reminders
- 测试：先 RED（7 个新用例全部因端点不存在 404 失败）后 GREEN 10/10；全量回归 **100/100 pass**
- 提交：`2123731`

### 6C. 站内提醒中心与表单

- 新建 `public/reminders.js`（IIFE，位于 #view 之外）：铃铛 `#btn-reminders` + 未读角标 + 面板；加载时/30s 前台轮询/可见性恢复立即轮询；轮询只更新自身，不重置编辑中表单；401 → 清除状态并跳转登录；面板常驻说明「站内提醒；关闭网页时不会主动推送」
- 面板交互：查看事项（深链到任务/日程）、已读、取消；「启用通知（可选）」按钮如实反馈授权结果（拒绝/不支持不影响站内提醒）；新未读首次出现触发一次通知决策，仅 `Notification.permission === 'granted'` 才真正发通知
- 表单集成：任务/日程弹窗可选「提醒时间（中国时间）」字段（datetime-local ↔ UTC ISO，`+08:00` 显式转换）；编辑时预填活跃提醒；保存后 upsert（同一事项两次保存只更新不重复）；**提醒失败不推翻已保存事项**（toast「事项已保存，提醒设置失败，请重试」）；完成/删除事项同事务联动取消
- 时间显示：en-CA formatToParts 拼装「9月23日 09:00」，不受 zh-CN Intl 输出「9/23」影响
- 环境限定（如实记录）：headless Chromium 一律拒绝 Notification 权限（grantPermissions 与 CDP 均无效）→ 测试覆盖至权限门前（`__msNotifyCandidates` 观察点），授权分支在真实浏览器点击启用后生效
- 测试：先 RED（浏览器元素不存在等 6 个真实失败；中途修复 waitForSelector `[hidden]` 需 `state:'attached'` 语义）后 GREEN 9/9；全量回归 **109/109 pass**
- 提交：`6579aa6`

### 7A. Hermes 只读勘察（无任何写入）

- 新建 `docs/hermes-chat-integration.md`：运行事实（Docker 容器 `hermes`、端口 8642→宿主 0.0.0.0、`api_server` platform connected、宿主 gateway 仅 photon）、鉴权模型（Bearer `API_SERVER_KEY` 在容器 `/opt/data/.env`，凭据不出服务端）、端点契约（`POST /api/sessions`、`POST /api/sessions/{id}/chat` 非流式、`GET /api/sessions/{id}/messages`、model 默认 'hermes-agent'）、未确认事项（api_server 显式启用配置源未定位、Bearer 有效性属 7D、8642 绑定面）
- 全程只读：未修改任何 Hermes 配置/源码、未启动/重启服务、未调用端点
- 门槛结论：**7B/7C 可实施**；真实上游验收归 7D
- 提交：`939500d`

### 7B. 同源聊天代理（受保护端点）

- 新建 `src/hermes-chat.js`：上游客户端封装（只转发用户文本，不直连模型、不假回复、不注入工具调用）+ 进程内限流器（1 并发 / 每分钟 10 次）；`src/db.js` 新增 `hermes_conversations`（本地 id ↔ upstream_session_id 映射）与 `hermes_requests`（幂等缓存，仅记录成功回复，失败不落库可重试）
- 路由（auth 中间件之后、CSRF 沿用）：`POST /api/chat/conversation`（先在上游建成独立 `manager_show_*` 会话再落库，避免僵尸映射）、`GET /api/chat/conversations`（本地列表）、`POST /api/chat/conversation/:id/messages`（幂等 requestId：已完成的重放返回同一次结果且不重复触发上游、不占限流配额；限流 429 带 Retry-After）、`GET /api/chat/conversation/:id/messages`（上游读回，过滤 tool 内部输出，只留 user/assistant 文本）
- 配置：`HERMES_API_KEY` 服务端持有，缺省一律 503「聊天服务未配置」，不编造连通性；上游 4xx/5xx → 502 透传错误信息，不假回复；不自动注入 DB 内容；不暴露 jobs/browser-control 等端点
- 测试：`test/chat-proxy.test.js` 用真实 HTTP mock 上游（`support/mock-hermes.js`，含消息历史与故障注入）；先 RED（10 个用例全部因端点不存在 404 失败）后 GREEN 10/10；security 增补未登录读写 + 跨站 CSRF 用例；全量回归 **119/119 pass**
- 提交：`d859399`

### 7C. 常驻聊天抽屉 UI

- 新建 `public/chat.js`（IIFE）+ `index.html` 右下入口 `#btn-chat` + 抽屉 `#chat-drawer`（均位于 #view 之外，视图重渲染不丢）；`styles.css` 抽屉/气泡/入口样式（移动端避开底部导航）
- 交互语义：Enter 发送 / Shift+Enter 换行 / IME 组合中 Enter 不发送（compositionstart/end 标志）；Esc 关闭（捕获阶段判断弹窗，有打开的弹窗时 Esc 归弹窗）；发送中「思考中…」占位与输入禁用；失败占位 + 「重试」（复用同一 requestId，幂等不重复触发上游）；回复纯文本渲染（不执行上游 HTML）；401 → 跳转登录
- 会话管理：列表视图（空态说明连接 Hermes Agent、不自动读取待办/投递数据）+ 新建会话 + 对话视图（历史从上游读回、重载后本地会话列表持久化）；未配置上游 503 如实 toast，不产生本地会话
- 测试：`test/browser-chat.test.js` 真实 Playwright + mock 上游；先 RED（8 个用例全部元素/行为缺失失败）后 GREEN 8/8；全量回归见下
- 提交：`1b813ea`（父助手独立复跑 `npm test` → 127 pass / 0 fail 后提交）

### 7D. 真实上游验收（实施者权限外）

- **需父助手独立确认后执行**：用真实 key 跑通一轮会话（创建 Manager Show 会话 → 发一条消息 → 读回）。若无法真实连通，如实报告「UI/代理已完成、真实接入未完成」，不编造连通性。

## 未完成门槛

- 7D 真实上游验收：**需父助手独立确认后执行**（用真实 key 跑通一轮会话）。若无法真实连通，如实报告「UI/代理已完成、真实接入未完成」。
- 生产部署/网关启用由父助手独立审查后操作，实施者不执行。
- npm audit：2 个 moderate（qs 相关，express 4 钉死 ~6.15.1 无法升级，express 5 为禁用大版本升级；仅回环、鉴权后 API 受影响，风险低）→ 记录在案，不盲改。
