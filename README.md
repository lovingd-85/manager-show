# Manager Show · 个人运营驾驶舱

单用户个人管理 Web 应用（简体中文界面），覆盖四个模块：

- **今日首页**：今日 3 个重点、逾期任务 / 投递风险、未来 7 天日程、关键统计
- **校招投递 CRM**：状态看板（待投递 → 已投递 → 笔试 → 面试 → Offer / 已拒绝 / 已结束）、关键词与状态筛选、新增 / 编辑 / 删除、下一步行动与日期、逾期风险高亮
- **任务日程**：任务分组（逾期 / 今天 / 即将 / 已完成）、今日重点标记、日程的增删改查
- **实习成果记录**：时间线展示，含分类、量化影响、描述

## 技术栈

- **后端**：Node.js 22 + Express 4（前后端一体，同端口提供 API 与静态页面）
- **数据库**：SQLite（Node 22 内置 `node:sqlite`，零原生编译依赖），数据文件默认在 `data/manager.db`
- **前端**：原生 HTML/CSS/JS 单页应用（hash 路由），无任何外部 CDN / 字体 / 图片，完全离线可用
- **安全**：单用户登录（scrypt 密码哈希 + SQLite 会话）、HttpOnly/Secure/SameSite 会话 Cookie、CSRF 校验、登录限流、安全响应头
- **测试**：Node 内置 `node:test` + `fetch`，对真实 HTTP 服务做行为测试

## 启动

要求 Node.js ≥ 22.5。

```bash
npm install     # 仅需安装 express 一个依赖
npm start       # 启动服务
```

启动后访问：<http://127.0.0.1:3000>，未登录会被引导至 `/login` 登录页。

**首次启动必须配置管理员密码**（绝不硬编码，三种方式任选，见下节）：

```bash
# 方式一（推荐）：环境变量配置密码哈希
echo "你的密码" | node scripts/hash-password.js   # 生成哈希
ADMIN_PASSWORD_HASH='scrypt$…' npm start

# 方式二：环境变量明文密码（仅建议本地/内网临时使用）
ADMIN_PASSWORD='你的密码' npm start

# 方式三：什么都不配置 —— 首次启动自动生成随机密码并打印在启动日志中，
#         哈希写入数据库；之后可用 scripts/set-password.js 轮换。
```

## 安全与部署

### 管理员密码

密码配置优先级：**启动参数/环境变量 `ADMIN_PASSWORD_HASH`（哈希）> `ADMIN_PASSWORD`（明文）> 数据库 `settings.admin_password_hash` > 首次启动自动生成随机密码**。数据库中只保存哈希（scrypt 格式 `scrypt$N$r$p$salt$hash`），密码明文绝不落盘、绝不硬编码。

- 生成哈希：`node scripts/hash-password.js`（从 stdin 读取，输出 `ADMIN_PASSWORD_HASH=…`）
- 轮换数据库密码（无需重启）：`echo "新密码" | node scripts/set-password.js`（可用 `MANAGER_DB` 指定数据库；若设置了 `ADMIN_PASSWORD_HASH`/`ADMIN_PASSWORD` 环境变量，仍以环境变量为准）
- 注意：`ADMIN_PASSWORD` 明文方式会让密码出现在进程环境与启动命令中，正式部署请使用哈希方式

### 环境变量一览

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | 监听端口 / 地址 |
| `MANAGER_DB` | `data/manager.db` | SQLite 数据库文件路径 |
| `ADMIN_PASSWORD_HASH` | 无 | 管理员密码的 scrypt 哈希（推荐） |
| `ADMIN_PASSWORD` | 无 | 管理员密码明文（仅建议本地使用） |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（小时），到期自动失效 |
| `LOGIN_MAX_ATTEMPTS` | `5` | 同一 IP 登录失败次数上限 |
| `LOGIN_WINDOW_MINUTES` | `15` | 登录限流时间窗口（分钟），超限返回 429 |
| `TRUST_PROXY` | 未启用 | 反向代理信任配置：`loopback`（同机 nginx/caddy）或 `1`（信任全部代理）。见下节 |
| `COOKIE_SECURE` | `true` | 会话 Cookie 的 `Secure` 属性；仅在无法使用 HTTPS 的纯内网调试时设为 `0` |

### 反向代理要求（对外部署必读）

本服务自身监听 HTTP，**必须由反向代理（nginx / Caddy 等）终止 HTTPS**，并满足：

1. **HTTPS 终止**：会话 Cookie 带 `Secure` 属性，浏览器只在 HTTPS 下接受；请为站点配置 TLS 证书（`COOKIE_SECURE` 保持默认 `true`）。
2. **转发 `X-Forwarded-Proto`**：代理必须设置该请求头，服务端据此识别 HTTPS 连接并下发 HSTS 响应头。
3. **设置 `TRUST_PROXY`**：部署在反向代理之后时设置 `TRUST_PROXY=loopback`（代理与 Node 同机）或 `TRUST_PROXY=1`（信任代理链），否则登录限流只会看到代理 IP、`req.secure` 判断失效。
4. **不要缓存 API 响应**：服务端已为所有 `/api/*` 响应下发 `Cache-Control: no-store`；代理层请勿对 `/api/*` 添加额外缓存。
5. **保持 Host/Origin 一致**：CSRF 校验比对 `Origin` 与 `Host`，代理配置的域名应与用户访问域名一致。

### 内置安全机制

- **会话 Cookie**：`ms_session`，`HttpOnly` + `Secure` + `SameSite=Strict` + `Path=/`；会话 token 为 32 字节随机数，数据库只存其 sha256，过期自动清理
- **接口与页面保护**：除 `GET /api/health`、登录/退出接口与登录页外，所有 API 与首页均需登录（API 返回 401 JSON，页面 302 跳转 `/login`）
- **CSRF 防护**：所有写请求（POST/PATCH/DELETE）校验 `Origin` 与 `Sec-Fetch-Site`，跨站请求返回 403；与 `SameSite=Strict` Cookie 叠加双保险
- **登录限流**：按 IP 统计失败次数，超限返回 429（带 `Retry-After`），成功后清零
- **安全响应头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy`、`Content-Security-Policy`（`default-src 'self'`，无内联脚本）、API `Cache-Control: no-store`、HTTPS 下自动下发 HSTS；不暴露 `X-Powered-By`
- **示例数据重置保护**：`POST /api/seed/reset`（及侧边栏按钮）会清空全部数据，现已要求登录并受 CSRF 校验保护，请谨慎使用

## 测试

```bash
npm test        # 25 个行为测试：API CRUD、校验、筛选、驾驶舱聚合、静态页面，
                # 以及安全层（登录、会话 Cookie、接口/页面保护、CSRF、限流、安全头、退出、会话过期）
```

首次启动时若数据库为空，会自动写入一组**可编辑的示例数据**（日期相对当天生成，保证演示效果）。登录后点击侧边栏底部「重置示例数据」或 `POST /api/seed/reset` 可随时恢复。

## API 一览

除注明“公开”外，所有接口均需登录（会话 Cookie），未登录返回 `401 { "error": "未登录" }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（公开） |
| POST | `/api/auth/login` | 登录：`{ "password": "…" }`，成功设置会话 Cookie；失败 401 / 限流 429（公开） |
| GET | `/api/auth/me` | 会话状态：`{ "authenticated": true }` 或 401（公开） |
| POST | `/api/auth/logout` | 退出并清除会话 Cookie（公开） |
| GET | `/api/dashboard?date=YYYY-MM-DD` | 今日驾驶舱聚合（重点/逾期/风险/日程/统计） |
| GET/POST | `/api/applications` | 投递列表（`?status=&q=` 筛选）/ 新增 |
| GET/PATCH/DELETE | `/api/applications/:id` | 单条投递 |
| GET/POST | `/api/tasks` | 任务列表 / 新增（`focus_date` 标记今日重点） |
| GET/PATCH/DELETE | `/api/tasks/:id` | 单条任务（`done` 切换完成状态） |
| GET/POST | `/api/events` | 日程列表（`?from=&to=` 区间）/ 新增 |
| GET/PATCH/DELETE | `/api/events/:id` | 单条日程 |
| GET/POST | `/api/achievements` | 成果列表 / 新增 |
| GET/PATCH/DELETE | `/api/achievements/:id` | 单条成果 |
| POST | `/api/seed/reset` | 清空并恢复示例数据（登录 + CSRF 校验保护） |

所有写接口均做服务端校验：必填字段、`YYYY-MM-DD` 日期、`HH:MM` 时间、状态/优先级枚举；错误返回 `{ "error": "…" }` 与合适的 4xx 状态码。

## 目录结构

```
server.js            服务入口
src/app.js           Express 应用工厂（安全层 + 全部 API 路由）
src/auth.js          密码哈希/校验、会话存储、Cookie 工具、凭据解析与安全初始化
src/rate-limit.js    登录失败限流（进程内固定窗口）
src/db.js            SQLite 打开与迁移（含 sessions / settings 表）
src/seed.js          示例数据（相对日期）与重置
src/validate.js      输入校验工具
src/dates.js         本地日期工具
public/              前端 SPA（index.html / app.js / styles.css）与登录页（login.html / login.js）
scripts/hash-password.js   生成 ADMIN_PASSWORD_HASH
scripts/set-password.js    轮换数据库中的管理员密码哈希
test/                行为测试（node:test）
support/             测试辅助（真实 HTTP 服务启动器，自动登录）
data/                运行期生成的 SQLite 数据库（勿提交）
```
