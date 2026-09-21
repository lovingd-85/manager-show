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

## 未完成门槛

- 6C 站内提醒中心与表单（铃铛入口、未读角标、30s 前台轮询、任务/日程弹窗提醒字段、永久「站内提醒；关闭网页时不会主动推送」说明）未开始
- 7A–7D Hermes 聊天（只读勘察 → 同源代理 → 常驻抽屉 → 真实上游验收）未开始
- （待 7A 勘查后填写 Hermes 接入门槛；门槛不满足时明确 BLOCKED，不编造连通性）
- 生产部署/网关启用由父助手独立审查后操作，实施者不执行。
- npm audit：2 个 moderate（qs 相关，express 4 钉死 ~6.15.1 无法升级，express 5 为禁用大版本升级；仅回环、鉴权后 API 受影响，风险低）→ 记录在案，不盲改。
