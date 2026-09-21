# 控件审计：一行一控件，保留的都必须有真实效果

> 原则：保留控件必须有具体行为与对应测试；纯装饰改用 `span`；未实现能力说明原因，不提供「敬请期待」按钮。
> 错误态统一约定：网络失败 → toast 显示服务端错误并保留输入（弹窗不关闭）；未登录 → 跳转登录页；数据被并发修改 → 明确提示原因。
> 状态：2026-09-22，覆盖至计划 5A。提醒（6C）与聊天（7C）交付后需回填本表对应行。

| # | 页面 | 控件（可访问名称/selector） | 保留/删除 | 触发请求 | 可见结果 | 错误态 | 对应测试 |
|---|------|------------------------------|-----------|----------|----------|--------|----------|
| 1 | 全局侧边栏 | 主导航链接 `.nav a`（今日首页/校招投递/待办与日程/成果记录） | 保留 | hash 路由 → 各视图 GET | 视图切换、高亮当前项 | 视图请求失败 → toast「更新失败，可重试」 | browser-actions 冒烟；route-filters |
| 2 | 全局底部导航 | 移动端导航 `.bottom-nav a` | 保留 | 同 #1（同一路由表） | 同 #1 | 同 #1 | public-ui 结构契约；browser-actions 手机菜单 |
| 3 | 全局顶栏 | 手机菜单 ☰ `#btn-menu` | 保留 | 无（纯 DOM） | 展开/收起侧边栏；选导航后自动收起 | — | browser-actions「手机菜单」 |
| 4 | 全局顶栏 | 问候语 `#topbar-date` | 保留（装饰，span 语义） | 无 | 上海时间问候与日期 | — | —（展示层） |
| 5 | 全局侧边栏 | 退出登录 `#btn-logout` | 保留 | POST /api/auth/logout | 清除会话并跳转 /login | 网络错误也跳转（会话本地失效） | browser-actions「重置示例数据入口已移除；退出登录仍可用」 |
| 6 | 全局侧边栏 | 重置示例数据 `#btn-reset-seed` | **已删除** | —（接口默认不注册，显式开启仅限隔离测试/演示） | — | 登录后 POST /api/seed/reset → 404 | security「重置示例数据默认关闭」 |
| 7 | 今日首页 | 快捷新增待办 `#btn-quick-task` | 保留 | 打开共享表单 → POST /api/tasks | 新任务出现在摘要与任务页 | 500 → toast + 弹窗保留输入 | browser-actions 4A 共用表单测试 |
| 8 | 今日首页 | 快捷新增投递 `#btn-quick-app` | 保留 | 打开投递表单 → POST /api/applications | 投递页可见新记录 | 500 → toast + 弹窗保留输入 | browser-actions 校招新增测试 |
| 9 | 今日首页 | 统计卡 ×5 `a.card.stat`（投递总数/笔试面试中/Offer/待办任务/成果记录） | 保留（真实 `<a href>`） | 导航到对应明细页（含筛选参数） | 数字可解释：明细与统计同源 | — | browser-actions「笔试/面试统计点击后看到真实记录」；dashboard-details |
| 10 | 今日首页 | 全部待办标题链接 + 查看全部 N 项 | 保留 | `#/tasks?state=open` | 未来与无日期任务可见 | — | browser-actions「全部待办链接可点击」；dashboard-details |
| 11 | 今日首页 | 待办行勾选 `[data-task-toggle]` | 保留 | PATCH /api/tasks/:id | 完成/撤销，计数即时更新 | 失败 → toast + 勾选回退 | browser-actions 任务勾选测试 |
| 12 | 今日首页 | 待办行编辑 `[data-task-edit]` | 保留 | 弹窗 → PATCH | 保存后即时重渲染 | 弹窗内 toast，不关闭 | browser-actions 任务编辑测试 |
| 13 | 今日首页/任务页 | 同步任务「复制为个人待办」`[data-task-copy]` | 保留 | 预填弹窗 → POST /api/tasks | 独立 source=manual 副本 | 同 #7 | browser-actions「同步任务」4B |
| 14 | 今日首页 | 无重点时的「新增待办」`#btn-add-focus-task` | 保留 | 打开共享表单 | 同 #7 | 同 #7 | browser-actions「无今日重点时提供可用的新增待办按钮」 |
| 15 | 今日首页 | 笔试/面试明细条目 `a.interview-item` | 保留（真实链接） | 深链 `#/campus?id=N` → 编辑弹窗 | 打开对应投递记录 | 记录不存在 → 「事项已更新或删除」 | browser-actions 3C 明细测试 |
| 16 | 校招投递 | 搜索框 `#campus-q` | 保留 | GET /api/applications?q=（防抖） | 列表过滤 | 同 #1 | browser-actions 搜索测试 |
| 17 | 校招投递 | 状态/阶段筛选 chips（全部/笔试面试/8 状态） | 保留 | URL 参数驱动 → GET | 过滤视图可分享、前进后退可用 | 同 #1 | route-filters 6 用例 |
| 18 | 校招投递 | 清除筛选 `#clear-filter` | 保留 | 移除 URL 参数 | 回到全部 | — | route-filters「status=Offer 空结果」 |
| 19 | 校招投递 | 新增投递 `#btn-add-app` | 保留 | 弹窗 → POST | 新卡片可见 | 500 → toast + 弹窗保留输入 | browser-actions 校招新增测试 |
| 20 | 校招投递 | 投递卡片 `.app-card[data-app-id]` | 保留 | 点击 → 编辑弹窗（PATCH/DELETE） | 保存/删除即时生效 | 弹窗内 toast | browser-actions 投递编辑/删除测试 |
| 21 | 待办与日程 | 新增待办 `#btn-add-task` | 保留 | 打开共享表单（与首页同一表单） | 同 #7 | 同 #7 | browser-actions 4A 测试 |
| 22 | 待办与日程 | 状态筛选 chips（未完成/全部/已完成） | 保留 | URL 参数 → 视图分组 | 筛选可分享、刷新保持 | 同 #1 | route-filters「state=done」 |
| 23 | 待办与日程 | 分类筛选 chips（全部/生活/工作/学习/求职/实习/其他） | 保留 | URL 参数 | 分类过滤；未知分类忽略 | 同 #1 | route-filters「category 筛选」 |
| 24 | 待办与日程 | 任务行勾选/编辑/复制 | 保留 | 见 #11/#12/#13 | 同 | 同 | 同 |
| 25 | 待办与日程 | 新增日程表单 `#form-add-event` | 保留 | POST /api/events | 日程列表即时更新 | toast，输入保留 | browser-actions 日程新增测试 |
| 26 | 待办与日程 | 日程编辑 `[data-event-edit]` | 保留 | 弹窗 → PATCH/DELETE | 保存/删除即时生效 | 弹窗内 toast | browser-actions 日程 CRUD 测试 |
| 27 | 成果记录 | 记录成果 `#btn-add-ach` | 保留 | 弹窗 → POST /api/achievements | 时间线可见新条目 | 弹窗内 toast | browser-actions 成果 CRUD 测试 |
| 28 | 成果记录 | 成果编辑 `[data-ach-edit]` | 保留 | 弹窗 → PATCH/DELETE | 保存/删除即时生效 | 弹窗内 toast | browser-actions 成果 CRUD 测试 |
| 29 | 弹窗 | 关闭 ✕ `#modal-close` / 取消 `#mf-cancel` / Esc / 点遮罩 | 保留 | 无（纯关闭） | 弹窗关闭 | — | browser-actions 取消测试；public-ui Escape 契约 |
| 30 | 弹窗 | 删除 `#mf-delete`（仅编辑态出现） | 保留 | DELETE + 确认 | 记录删除、缓存精确失效 | 失败 → toast，弹窗不关闭 | browser-actions 删除测试；cache-behavior |
| 31 | 全局 | 站内提醒中心入口（铃铛） | 计划中（6C 交付） | — | 站内提醒；关闭网页时不会主动推送 | — | 待 6C 回填 |
| 32 | 全局 | 与 Hermes 对话（右下入口 + 常驻抽屉） | 计划中（7C 交付） | — | 同源代理连接 Hermes Agent，不直连模型 | — | 待 7C 回填 |

## 变更记录

- 2026-09-22（5A）：删除 `#btn-reset-seed` 及其绑定与 `POST /api/seed/reset` 默认注册；`createApp({ allowSeedReset: true })` 仅隔离测试/演示显式开启（test/applications.test.js 已显式开启）；生产无入口、默认 404。
