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

## 未完成门槛

- 4A–7D 未开始（通用待办表单、时间与同步边界、控件审计、提醒、Hermes 聊天）
- （待 7A 勘查后填写 Hermes 接入门槛）
- 生产部署/网关启用由父助手独立审查后操作，实施者不执行。
- npm audit：2 个 moderate（qs 相关，express 4 钉死 ~6.15.1 无法升级，express 5 为禁用大版本升级；仅回环、鉴权后 API 受影响，风险低）→ 记录在案，不盲改。
