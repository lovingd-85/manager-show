'use strict';

// Express 应用工厂：安全层（登录、会话、CSRF、限流、安全头）+ API 路由 + 静态页面。
// createApp({ dbPath, seed, adminPasswordHash, adminPassword, sessionTtlHours,
//             loginMaxAttempts, loginWindowMinutes, cookieSecure, trustProxy })
// 未显式传入的安全配置会从环境变量读取，见 README「安全与部署」。
const path = require('node:path');
const express = require('express');

const { openDb, isEmpty } = require('./db');
const seedData = require('./seed');
const { todayLocal, addDays, isValidDate, nowIso } = require('./dates');
const v = require('./validate');
const auth = require('./auth');
const { createRateLimiter } = require('./rate-limit');
const { createHermesChat, createChatLimiter } = require('./hermes-chat');
const {
  ACTIVE_STATUSES,
  withTransaction,
  parseEntityKey,
  parseRemindAt,
  resolveEntity,
  activeKeysFor,
  cancelActiveForEntity,
  activateDue,
  cancelInvalid,
} = require('./reminders');

const APP_STATUSES = ['待投递', '已投递', '笔试', '面试', '流程完成', 'Offer', '已拒绝', '已结束'];
const FINAL_STATUSES = ['流程完成', 'Offer', '已拒绝', '已结束'];
const PRIORITIES = ['高', '中', '低'];
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function serializeTask(row) {
  if (!row) return row;
  return { ...row, done: !!row.done, done_at: row.done_at || null };
}

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createApp(options = {}) {
  const {
    dbPath,
    seed = true,
    adminPasswordHash,
    adminPassword,
    sessionTtlHours,
    loginMaxAttempts,
    loginWindowMinutes,
    cookieSecure,
    trustProxy,
    allowSeedReset = false,
    // 提醒相关时间计算使用可注入时钟（测试无需真等时间）；默认真实时间
    now = nowIso,
    // Hermes 同源聊天代理：上游地址与凭据（服务端持有；缺省 key 则路由一律 503，不编造连通性）
    hermesBaseUrl,
    hermesApiKey,
    chatMaxPerMinute,
    chatMaxConcurrent,
  } = options;

  const db = openDb(dbPath);
  if (seed && isEmpty(db)) seedData.seed(db);

  // 同步脚本会为任务表补充 source/external_key 列；无该列时保持兼容（后续迁移统一补齐）
  const taskColumns = new Set(db.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((r) => r.name));
  const tasksHaveSource = taskColumns.has('source');

  // ---------- 安全配置 ----------
  // 密码优先级：显式参数（哈希 > 明文）> 环境变量 > 数据库 > 首次启动生成随机密码
  let hashConf = adminPasswordHash;
  let plainConf = adminPassword;
  if (!hashConf && !plainConf) {
    hashConf = process.env.ADMIN_PASSWORD_HASH;
    plainConf = process.env.ADMIN_PASSWORD;
  }
  const credential = auth.resolveCredential(db, { adminPasswordHash: hashConf, adminPassword: plainConf });

  const sessionTtlMs = (sessionTtlHours ?? envNumber('SESSION_TTL_HOURS', 168)) * 3600_000;
  const sessions = auth.createSessionStore(db, { ttlMs: sessionTtlMs });
  const limiter = createRateLimiter({
    max: loginMaxAttempts ?? envNumber('LOGIN_MAX_ATTEMPTS', 5),
    windowMs: (loginWindowMinutes ?? envNumber('LOGIN_WINDOW_MINUTES', 15)) * 60_000,
  });
  const secureCookie = cookieSecure ?? !['0', 'false'].includes(String(process.env.COOKIE_SECURE || '').toLowerCase());

  const chat = createHermesChat({
    baseUrl: hermesBaseUrl ?? process.env.HERMES_API_BASE_URL,
    apiKey: hermesApiKey ?? process.env.HERMES_API_KEY,
  });
  const chatLimiter = createChatLimiter({
    maxPerMinute: chatMaxPerMinute ?? 10,
    maxConcurrent: chatMaxConcurrent ?? 1,
  });

  const app = express();
  app.disable('x-powered-by');
  const tp = trustProxy ?? process.env.TRUST_PROXY;
  if (tp && !['0', 'false'].includes(String(tp))) {
    app.set('trust proxy', tp === 'true' ? true : tp);
  }
  app.use(express.json({ limit: '256kb' }));

  const bad = (res, error) => res.status(400).json({ error });
  const notFound = (res, what = '记录') => res.status(404).json({ error: `${what}不存在` });

  // ---------- 安全响应头 ----------
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  // ---------- CSRF：写请求校验 Origin / Sec-Fetch-Site（叠加 SameSite=Strict Cookie） ----------
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.get('sec-fetch-site') === 'cross-site') {
      return res.status(403).json({ error: '疑似跨站请求，已拒绝' });
    }
    const origin = req.get('origin');
    if (origin !== undefined) {
      let originHost = null;
      try { originHost = new URL(origin).host; } catch { originHost = null; }
      if (!originHost || originHost !== req.get('host')) {
        return res.status(403).json({ error: 'Origin 校验失败，已拒绝' });
      }
    }
    next();
  });

  const getSession = (req) => {
    sessions.prune();
    return sessions.get(auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE]);
  };

  // ---------- 健康检查（公开，供反向代理探活） ----------
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // ---------- 认证 ----------
  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip;
    if (limiter.isBlocked(ip)) {
      return res.status(429)
        .set('Retry-After', String(limiter.retryAfterSec(ip)))
        .json({ error: '尝试次数过多，请稍后再试' });
    }
    const password = typeof (req.body || {}).password === 'string' ? req.body.password : '';
    if (!credential.verify(password)) {
      limiter.recordFailure(ip);
      return res.status(401).json({ error: '密码错误' });
    }
    limiter.clear(ip);
    const { token, maxAgeSec } = sessions.create();
    res.set('Set-Cookie', auth.sessionCookie(token, { maxAgeSec, secure: secureCookie }));
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (getSession(req)) return res.json({ authenticated: true });
    res.status(401).json({ error: '未登录' });
  });

  app.post('/api/auth/logout', (req, res) => {
    const s = getSession(req);
    if (s) sessions.destroy(s.token);
    res.set('Set-Cookie', auth.sessionCookie('', { maxAgeSec: 0, secure: secureCookie, clear: true }));
    res.status(204).end();
  });

  // ---------- 其余 API 一律要求登录 ----------
  app.use('/api', (req, res, next) => {
    const s = getSession(req);
    if (!s) return res.status(401).json({ error: '未登录' });
    req.session = s;
    next();
  });

  // ---------- 今日驾驶舱 ----------
  app.get('/api/dashboard', (req, res) => {
    const date = req.query.date ? String(req.query.date) : todayLocal();
    if (!isValidDate(date)) return bad(res, 'date 格式应为 YYYY-MM-DD');

    const focus = db.prepare(
      'SELECT * FROM tasks WHERE focus_date = ? AND done = 0 ORDER BY id ASC'
    ).all(date).map(serializeTask);

    const overdueTasks = db.prepare(
      "SELECT * FROM tasks WHERE done = 0 AND due_date != '' AND due_date < ? ORDER BY due_date ASC, id ASC"
    ).all(date).map(serializeTask);

    const todayTasks = db.prepare(
      'SELECT * FROM tasks WHERE done = 0 AND due_date = ? ORDER BY id ASC'
    ).all(date).map(serializeTask);

    // 全部未完成待办：统计数字与明细同一集合（逾期 → 今天 → 未来 → 无日期）
    const openTasks = db.prepare(
      "SELECT * FROM tasks WHERE done = 0 ORDER BY (due_date = '') ASC, due_date ASC, id ASC"
    ).all().map(serializeTask);

    // 笔试/面试明细：与统计共用同一集合，按下一步日期排序，无日期在最后
    const interviewApplications = db.prepare(
      "SELECT * FROM applications WHERE status IN ('笔试', '面试') ORDER BY (next_step_date = '') ASC, next_step_date ASC, id ASC"
    ).all();

    const placeholders = FINAL_STATUSES.map(() => '?').join(',');
    const riskApplications = db.prepare(
      `SELECT * FROM applications WHERE next_step_date != '' AND next_step_date < ?
       AND status NOT IN (${placeholders}) ORDER BY next_step_date ASC, id ASC`
    ).all(date, ...FINAL_STATUSES);

    const upcomingEvents = db.prepare(
      'SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date ASC, start_time ASC, id ASC'
    ).all(date, addDays(date, 7));

    const stats = {
      applications: db.prepare('SELECT COUNT(*) AS n FROM applications').get().n,
      interviewing: interviewApplications.length,
      offers: db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'Offer'").get().n,
      tasksOpen: openTasks.length,
      achievements: db.prepare('SELECT COUNT(*) AS n FROM achievements').get().n,
    };

    res.json({ date, focus, overdueTasks, todayTasks, openTasks, interviewApplications, riskApplications, upcomingEvents, stats });
  });

  // ---------- 校招投递 CRM ----------
  function validateApplication(body, { partial = false } = {}) {
    if (!partial) {
      const base = v.collect({
        company: v.reqStr(body, 'company', '公司'),
        position: v.reqStr(body, 'position', '岗位'),
        city: v.optStr(body, 'city', '城市', 100),
        url: v.optStr(body, 'url', '链接', 500),
        status: v.optEnum(body, 'status', '状态', APP_STATUSES, '已投递'),
        priority: v.optEnum(body, 'priority', '优先级', PRIORITIES, '中'),
        applied_at: v.optDate(body, 'applied_at', '投递日期'),
        next_step: v.optStr(body, 'next_step', '下一步', 300),
        next_step_date: v.optDate(body, 'next_step_date', '下一步日期'),
        notes: v.optStr(body, 'notes', '备注'),
      });
      return base;
    }
    // 部分更新：只校验出现的字段
    const checks = {};
    if (body.company !== undefined) checks.company = v.reqStr(body, 'company', '公司');
    if (body.position !== undefined) checks.position = v.reqStr(body, 'position', '岗位');
    if (body.city !== undefined) checks.city = v.optStr(body, 'city', '城市', 100);
    if (body.url !== undefined) checks.url = v.optStr(body, 'url', '链接', 500);
    if (body.status !== undefined) checks.status = v.optEnum(body, 'status', '状态', APP_STATUSES, '已投递');
    if (body.priority !== undefined) checks.priority = v.optEnum(body, 'priority', '优先级', PRIORITIES, '中');
    if (body.applied_at !== undefined) checks.applied_at = v.optDate(body, 'applied_at', '投递日期');
    if (body.next_step !== undefined) checks.next_step = v.optStr(body, 'next_step', '下一步', 300);
    if (body.next_step_date !== undefined) checks.next_step_date = v.optDate(body, 'next_step_date', '下一步日期');
    if (body.notes !== undefined) checks.notes = v.optStr(body, 'notes', '备注');
    return v.collect(checks);
  }

  app.get('/api/applications', (req, res) => {
    const { status, q } = req.query;
    const conds = [];
    const params = [];
    if (status !== undefined && status !== '') {
      if (!APP_STATUSES.includes(status)) return bad(res, `状态只能是：${APP_STATUSES.join(' / ')}`);
      conds.push('status = ?');
      params.push(status);
    }
    if (q !== undefined && String(q).trim() !== '') {
      conds.push('(company LIKE ? OR position LIKE ? OR city LIKE ?)');
      const like = `%${String(q).trim()}%`;
      params.push(like, like, like);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM applications ${where} ORDER BY updated_at DESC, id DESC`
    ).all(...params);
    res.json(rows);
  });

  app.post('/api/applications', (req, res) => {
    const parsed = validateApplication(req.body || {});
    if (!parsed.ok) return bad(res, parsed.error);
    const a = parsed.value;
    const now = nowIso();
    const info = db.prepare(`INSERT INTO applications
      (company, position, city, url, status, priority, applied_at, next_step, next_step_date, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a.company, a.position, a.city, a.url, a.status, a.priority, a.applied_at, a.next_step, a.next_step_date, a.notes, now, now);
    res.status(201).json(db.prepare('SELECT * FROM applications WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/applications/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '投递记录');
    res.json(row);
  });

  app.patch('/api/applications/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '投递记录');
    const parsed = validateApplication(req.body || {}, { partial: true });
    if (!parsed.ok) return bad(res, parsed.error);
    const merged = { ...row, ...parsed.value, updated_at: nowIso() };
    db.prepare(`UPDATE applications SET company=?, position=?, city=?, url=?, status=?, priority=?,
      applied_at=?, next_step=?, next_step_date=?, notes=?, updated_at=? WHERE id=?`)
      .run(merged.company, merged.position, merged.city, merged.url, merged.status, merged.priority,
        merged.applied_at, merged.next_step, merged.next_step_date, merged.notes, merged.updated_at, row.id);
    res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(row.id));
  });

  app.delete('/api/applications/:id', (req, res) => {
    const info = db.prepare('DELETE FROM applications WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return notFound(res, '投递记录');
    res.status(204).end();
  });

  // ---------- 任务 ----------
  function validateTask(body, { partial = false } = {}) {
    if (!partial) {
      return v.collect({
        title: v.reqStr(body, 'title', '任务标题'),
        category: v.optStr(body, 'category', '分类', 50, '其他') ,
        due_date: v.optDate(body, 'due_date', '截止日期'),
        focus_date: v.optDate(body, 'focus_date', '重点日期'),
        notes: v.optStr(body, 'notes', '备注'),
        done: v.ok(!!body.done),
      });
    }
    const checks = {};
    if (body.title !== undefined) checks.title = v.reqStr(body, 'title', '任务标题');
    if (body.category !== undefined) checks.category = v.optStr(body, 'category', '分类', 50);
    if (body.due_date !== undefined) checks.due_date = v.optDate(body, 'due_date', '截止日期');
    if (body.focus_date !== undefined) checks.focus_date = v.optDate(body, 'focus_date', '重点日期');
    if (body.notes !== undefined) checks.notes = v.optStr(body, 'notes', '备注');
    if (body.done !== undefined) checks.done = v.ok(!!body.done);
    return v.collect(checks);
  }

  app.get('/api/tasks', (req, res) => {
    const rows = db.prepare(
      'SELECT * FROM tasks ORDER BY done ASC, due_date ASC, id ASC'
    ).all().map(serializeTask);
    res.json(rows);
  });

  app.post('/api/tasks', (req, res) => {
    const parsed = validateTask(req.body || {});
    if (!parsed.ok) return bad(res, parsed.error);
    const t = parsed.value;
    const now = nowIso();
    const insert = tasksHaveSource
      ? db.prepare(`INSERT INTO tasks (title, category, due_date, focus_date, done, notes, created_at, done_at, source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`)
      : db.prepare(`INSERT INTO tasks (title, category, due_date, focus_date, done, notes, created_at, done_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = insert.run(t.title, t.category, t.due_date, t.focus_date, t.done ? 1 : 0, t.notes, now, t.done ? now : null);
    res.status(201).json(serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid)));
  });

  app.get('/api/tasks/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '任务');
    res.json(serializeTask(row));
  });

  app.patch('/api/tasks/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '任务');
    // 同步记录只读：未实现来源回写前拒绝修改，不装作保存成功
    if (row.source && row.source !== 'manual') {
      return res.status(409).json({ error: '同步记录只读，请复制为个人待办' });
    }
    const parsed = validateTask(req.body || {}, { partial: true });
    if (!parsed.ok) return bad(res, parsed.error);
    const merged = { ...row, ...parsed.value };
    const doneAt = merged.done ? (row.done ? row.done_at : nowIso()) : null;
    withTransaction(db, () => {
      db.prepare('UPDATE tasks SET title=?, category=?, due_date=?, focus_date=?, done=?, notes=?, done_at=? WHERE id=?')
        .run(merged.title, merged.category, merged.due_date, merged.focus_date, merged.done ? 1 : 0, merged.notes, doneAt, row.id);
      // 完成任务的同一事务内取消活跃提醒，避免半更新（失败则整体回滚）
      if (merged.done) cancelActiveForEntity(db, 'task', activeKeysFor('task', row));
    });
    res.json(serializeTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id)));
  });

  app.delete('/api/tasks/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '任务');
    // 同步记录只读：未实现来源回写前拒绝删除
    if (row.source && row.source !== 'manual') {
      return res.status(409).json({ error: '同步记录只读，请复制为个人待办' });
    }
    withTransaction(db, () => {
      db.prepare('DELETE FROM tasks WHERE id = ?').run(row.id);
      cancelActiveForEntity(db, 'task', activeKeysFor('task', row));
    });
    res.status(204).end();
  });

  // ---------- 日程 ----------
  function validateEvent(body, { partial = false } = {}) {
    if (!partial) {
      return v.collect({
        title: v.reqStr(body, 'title', '日程标题'),
        date: v.reqDate(body, 'date', '日期'),
        start_time: v.optTime(body, 'start_time', '开始时间'),
        end_time: v.optTime(body, 'end_time', '结束时间'),
        location: v.optStr(body, 'location', '地点', 200),
        notes: v.optStr(body, 'notes', '备注'),
      });
    }
    const checks = {};
    if (body.title !== undefined) checks.title = v.reqStr(body, 'title', '日程标题');
    if (body.date !== undefined) checks.date = v.reqDate(body, 'date', '日期');
    if (body.start_time !== undefined) checks.start_time = v.optTime(body, 'start_time', '开始时间');
    if (body.end_time !== undefined) checks.end_time = v.optTime(body, 'end_time', '结束时间');
    if (body.location !== undefined) checks.location = v.optStr(body, 'location', '地点', 200);
    if (body.notes !== undefined) checks.notes = v.optStr(body, 'notes', '备注');
    return v.collect(checks);
  }

  app.get('/api/events', (req, res) => {
    const { from, to } = req.query;
    const conds = [];
    const params = [];
    if (from !== undefined && from !== '') {
      if (!isValidDate(String(from))) return bad(res, 'from 格式应为 YYYY-MM-DD');
      conds.push('date >= ?');
      params.push(from);
    }
    if (to !== undefined && to !== '') {
      if (!isValidDate(String(to))) return bad(res, 'to 格式应为 YYYY-MM-DD');
      conds.push('date <= ?');
      params.push(to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT * FROM events ${where} ORDER BY date ASC, start_time ASC, id ASC`
    ).all(...params);
    res.json(rows);
  });

  app.post('/api/events', (req, res) => {
    const parsed = validateEvent(req.body || {});
    if (!parsed.ok) return bad(res, parsed.error);
    const e = parsed.value;
    const info = db.prepare('INSERT INTO events (title, date, start_time, end_time, location, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.title, e.date, e.start_time, e.end_time, e.location, e.notes);
    res.status(201).json(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/events/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '日程');
    res.json(row);
  });

  app.patch('/api/events/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '日程');
    const parsed = validateEvent(req.body || {}, { partial: true });
    if (!parsed.ok) return bad(res, parsed.error);
    const merged = { ...row, ...parsed.value };
    db.prepare('UPDATE events SET title=?, date=?, start_time=?, end_time=?, location=?, notes=? WHERE id=?')
      .run(merged.title, merged.date, merged.start_time, merged.end_time, merged.location, merged.notes, row.id);
    res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(row.id));
  });

  app.delete('/api/events/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '日程');
    withTransaction(db, () => {
      db.prepare('DELETE FROM events WHERE id = ?').run(row.id);
      cancelActiveForEntity(db, 'event', activeKeysFor('event', row));
    });
    res.status(204).end();
  });

  // ---------- 实习成果 ----------
  function validateAchievement(body, { partial = false } = {}) {
    if (!partial) {
      return v.collect({
        title: v.reqStr(body, 'title', '成果标题'),
        date: v.reqDate(body, 'date', '日期'),
        category: v.optStr(body, 'category', '分类', 50, '项目'),
        impact: v.optStr(body, 'impact', '量化影响', 300),
        description: v.optStr(body, 'description', '描述'),
      });
    }
    const checks = {};
    if (body.title !== undefined) checks.title = v.reqStr(body, 'title', '成果标题');
    if (body.date !== undefined) checks.date = v.reqDate(body, 'date', '日期');
    if (body.category !== undefined) checks.category = v.optStr(body, 'category', '分类', 50);
    if (body.impact !== undefined) checks.impact = v.optStr(body, 'impact', '量化影响', 300);
    if (body.description !== undefined) checks.description = v.optStr(body, 'description', '描述');
    return v.collect(checks);
  }

  app.get('/api/achievements', (req, res) => {
    const rows = db.prepare('SELECT * FROM achievements ORDER BY date DESC, id DESC').all();
    res.json(rows);
  });

  app.post('/api/achievements', (req, res) => {
    const parsed = validateAchievement(req.body || {});
    if (!parsed.ok) return bad(res, parsed.error);
    const a = parsed.value;
    const info = db.prepare('INSERT INTO achievements (date, title, category, impact, description, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a.date, a.title, a.category, a.impact, a.description, nowIso());
    res.status(201).json(db.prepare('SELECT * FROM achievements WHERE id = ?').get(info.lastInsertRowid));
  });

  app.get('/api/achievements/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM achievements WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '成果');
    res.json(row);
  });

  app.patch('/api/achievements/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM achievements WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '成果');
    const parsed = validateAchievement(req.body || {}, { partial: true });
    if (!parsed.ok) return bad(res, parsed.error);
    const merged = { ...row, ...parsed.value };
    db.prepare('UPDATE achievements SET date=?, title=?, category=?, impact=?, description=? WHERE id=?')
      .run(merged.date, merged.title, merged.category, merged.impact, merged.description, row.id);
    res.json(db.prepare('SELECT * FROM achievements WHERE id = ?').get(row.id));
  });

  app.delete('/api/achievements/:id', (req, res) => {
    const info = db.prepare('DELETE FROM achievements WHERE id = ?').run(req.params.id);
    if (info.changes === 0) return notFound(res, '成果');
    res.status(204).end();
  });

  // ---------- 站内提醒 ----------
  // v1 边界：仅站内提醒中心（关闭网页不主动推送）；时间语义为明确时区的 ISO。
  // entity_key 见 src/reminders.js：manual:<id> 或 <source>:<external_key>。
  function serializeReminder(row) {
    const parsed = parseEntityKey(row.entity_key);
    let entityTitle = '';
    let entityId = null;
    const entity = resolveEntity(db, row.entity_type, row.entity_key);
    if (entity) {
      entityTitle = entity.title;
      // 仅手工记录的自增 id 可稳定跳转；同步 id 会被重建，不提供
      if (parsed && parsed.kind === 'manual') entityId = entity.id;
    }
    return {
      ...row,
      triggered_at: row.triggered_at || null,
      read_at: row.read_at || null,
      entity_title: entityTitle,
      entity_id: entityId,
    };
  }

  app.post('/api/reminders', (req, res) => {
    const body = req.body || {};
    if (body.entity_type !== 'task' && body.entity_type !== 'event') {
      return bad(res, 'entity_type 只能是 task 或 event');
    }
    const parsedKey = parseEntityKey(body.entity_key);
    if (!parsedKey) return bad(res, 'entity_key 格式非法');
    const entity = resolveEntity(db, body.entity_type, body.entity_key);
    if (entity === undefined) {
      return bad(res, '该记录来源无法稳定引用，请复制为个人待办后设置提醒');
    }
    if (!entity) return notFound(res, '事项');
    if (body.entity_type === 'task' && entity.done) {
      return bad(res, '事项已完成，无法设置提醒');
    }
    const remindAt = parseRemindAt(body.remind_at);
    if (!remindAt) return bad(res, 'remind_at 必须是带时区的 ISO 时间（如 2030-01-01T09:00:00Z）');
    if (!(Date.parse(remindAt) > Date.parse(now()))) return bad(res, '提醒时间必须晚于当前时刻');
    try {
      const info = db.prepare(`INSERT INTO reminders (entity_type, entity_key, remind_at, status, created_at)
        VALUES (?, ?, ?, 'scheduled', ?)`).run(body.entity_type, body.entity_key, remindAt, now());
      const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(info.lastInsertRowid);
      res.status(201).json(serializeReminder(row));
    } catch (err) {
      // 同一实体同一时刻只有一个活跃提醒（唯一索引），重复设置给出明确语义
      if (String(err.message || err).includes('UNIQUE')) {
        return res.status(409).json({ error: '该事项已有活跃提醒' });
      }
      throw err;
    }
  });

  app.get('/api/reminders', (req, res) => {
    const t = now();
    withTransaction(db, () => {
      activateDue(db, t);
      cancelInvalid(db);
    });
    const rows = db.prepare(
      `SELECT * FROM reminders WHERE status IN ('scheduled', 'unread')
       ORDER BY (status = 'unread') DESC, remind_at ASC, id ASC`
    ).all();
    res.json(rows.map(serializeReminder));
  });

  app.patch('/api/reminders/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM reminders WHERE id = ?').get(req.params.id);
    if (!row) return notFound(res, '提醒');
    const body = req.body || {};
    // 更新时不允许篡改关联实体
    if (body.entity_type !== undefined || body.entity_key !== undefined) {
      return bad(res, '不允许修改提醒关联的事项');
    }
    const active = ACTIVE_STATUSES.includes(row.status);
    let remindAt = row.remind_at;
    if (body.remind_at !== undefined) {
      if (!active) return bad(res, '该提醒已读或已取消，不能修改时间');
      const parsed = parseRemindAt(body.remind_at);
      if (!parsed) return bad(res, 'remind_at 必须是带时区的 ISO 时间（如 2030-01-01T09:00:00Z）');
      if (!(Date.parse(parsed) > Date.parse(now()))) return bad(res, '提醒时间必须晚于当前时刻');
      remindAt = parsed;
    }
    let status = row.status;
    let readAt = row.read_at;
    if (body.status !== undefined) {
      if (body.status === 'read') {
        if (!active) return bad(res, '该提醒已读或已取消');
        status = 'read';
        readAt = now();
      } else if (body.status === 'cancelled') {
        if (row.status === 'cancelled') return bad(res, '该提醒已取消');
        status = 'cancelled';
      } else {
        return bad(res, 'status 只能是 read 或 cancelled');
      }
    }
    if (remindAt === row.remind_at && status === row.status && readAt === row.read_at) {
      return bad(res, '没有可更新的字段');
    }
    db.prepare('UPDATE reminders SET remind_at=?, status=?, read_at=? WHERE id=?')
      .run(remindAt, status, readAt, row.id);
    res.json(serializeReminder(db.prepare('SELECT * FROM reminders WHERE id = ?').get(row.id)));
  });

  // ---------- Hermes 聊天（同源受保护代理；不直连模型、不假回复、不注入 DB 内容） ----------
  // 上游错误统一 502 并透传错误信息；凭据问题不外泄细节
  const chatUpstreamError = (res, err) => {
    res.status(502).json({ error: `聊天服务调用失败：${err && err.message ? err.message : '上游不可用'}` });
  };

  // 前端据此决定是否显示聊天入口：未配置上游时不显示，避免留下点了没反应的按钮
  app.get('/api/chat/status', (req, res) => {
    res.json({ configured: chat.configured() });
  });

  // 创建独立 Manager Show 会话：先在上游建成（避免本地留僵尸映射），再落库本地 id
  app.post('/api/chat/conversation', async (req, res, next) => {
    if (!chat.configured()) return res.status(503).json({ error: '聊天服务未配置（上游未启用），请稍后再试' });
    const raw = typeof (req.body || {}).title === 'string' ? req.body.title.trim().slice(0, 100) : '';
    const title = raw || 'Manager Show 会话';
    try {
      const upstreamId = await chat.createConversation({ title });
      const createdAt = now();
      const info = db.prepare(
        'INSERT INTO hermes_conversations (upstream_session_id, title, created_at) VALUES (?, ?, ?)'
      ).run(upstreamId, title, createdAt);
      res.status(201).json({ id: info.lastInsertRowid, title, created_at: createdAt });
    } catch (err) {
      if (err && err.status) return chatUpstreamError(res, err);
      next(err);
    }
  });

  app.get('/api/chat/conversations', (req, res) => {
    const rows = db.prepare(
      'SELECT id, title, created_at FROM hermes_conversations ORDER BY id DESC'
    ).all();
    res.json(rows);
  });

  const findConversation = (req, res) => {
    const conv = db.prepare('SELECT * FROM hermes_conversations WHERE id = ?').get(req.params.id);
    if (!conv) { notFound(res, '会话'); return null; }
    return conv;
  };

  // 发送消息：幂等 requestId（已完成的重放返回同一次结果，不重复触发上游，也不占限流配额）
  app.post('/api/chat/conversation/:id/messages', async (req, res, next) => {
    if (!chat.configured()) return res.status(503).json({ error: '聊天服务未配置（上游未启用），请稍后再试' });
    const conv = findConversation(req, res);
    if (!conv) return;
    const body = req.body || {};
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) return bad(res, 'requestId 必填（幂等键）');
    if (requestId.length > 100) return bad(res, 'requestId 过长（最多 100 字符）');
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return bad(res, 'message 不能为空');
    if (message.length > 4000) return bad(res, '消息过长（最多 4000 字）');

    const cached = db.prepare('SELECT * FROM hermes_requests WHERE request_id = ?').get(requestId);
    if (cached) return res.json({ id: cached.request_id, reply: cached.reply, replayed: true });

    const ticket = chatLimiter.tryAcquire();
    if (!ticket.ok) {
      return res.status(429)
        .set('Retry-After', ticket.reason === 'rate' ? '60' : '2')
        .json({ error: ticket.reason === 'rate' ? '聊天过于频繁，请稍后再试' : '聊天处理中，请稍后再试' });
    }
    try {
      const { reply, usage } = await chat.sendMessage(conv.upstream_session_id, message);
      db.prepare(
        'INSERT INTO hermes_requests (request_id, conversation_id, message, reply, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(requestId, conv.id, message, reply, now());
      res.json({ id: requestId, reply, replayed: false, usage });
    } catch (err) {
      if (err && err.status) return chatUpstreamError(res, err);
      next(err);
    } finally {
      ticket.release();
    }
  });

  // 读回会话消息（上游存储为准；本地只缓存幂等回复）
  app.get('/api/chat/conversation/:id/messages', async (req, res, next) => {
    if (!chat.configured()) return res.status(503).json({ error: '聊天服务未配置（上游未启用），请稍后再试' });
    const conv = findConversation(req, res);
    if (!conv) return;
    try {
      res.json(await chat.listMessages(conv.upstream_session_id));
    } catch (err) {
      if (err && err.status) return chatUpstreamError(res, err);
      next(err);
    }
  });

  // ---------- 示例数据重置（破坏性接口，默认不注册：生产无入口也不可调用） ----------
  // 仅隔离测试/演示实例显式 allowSeedReset: true 时注册；认证与 CSRF 中间件不变。
  if (allowSeedReset) {
    app.post('/api/seed/reset', (req, res) => {
      const counts = seedData.reset(db);
      res.json({ ok: true, counts });
    });
  }

  // ---------- 页面 ----------
  // 登录页公开；首页与 index.html 仅登录后可见；静态资源不含业务数据，保持公开
  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.get(['/', '/index.html'], (req, res, next) => {
    if (!getSession(req)) return res.redirect('/login');
    next();
  });
  app.use(express.static(PUBLIC_DIR));

  // API 404（JSON）
  app.use('/api', (req, res) => notFound(res, '接口'));

  // JSON 解析错误 → 400
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return bad(res, '请求体不是合法的 JSON');
    next(err);
  });

  return app;
}

module.exports = { createApp, APP_STATUSES, FINAL_STATUSES, PRIORITIES };
