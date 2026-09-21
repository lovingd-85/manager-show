'use strict';

// 提醒持久化与 API：独立表、幂等迁移、活跃提醒唯一约束（6A 数据层）；
// 受保护端点、注入时钟、到期激活/无效清理/只读更新/完成与删除联动取消（6B）。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { startServer } = require('../support/server-harness');

// 6B：可注入时钟 —— 测试不真等一分钟
let clock = '2026-09-22T00:00:00.000Z';
let api, close;
before(async () => {
  ({ api, close } = await startServer({ appOptions: { now: () => clock } }));
});
after(() => close());

async function createOpenTask(title) {
  return (await api('POST', '/api/tasks', { title, category: '生活' })).json;
}
async function createReminder(entityType, id, remindAt = '2026-09-23T09:00:00.000Z') {
  return api('POST', '/api/reminders', { entity_type: entityType, entity_key: `manual:${id}`, remind_at: remindAt });
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-rem-'));
  return path.join(dir, 'test.db');
}

test('提醒表：空库自动建表、列与索引齐全', () => {
  const db = openDb(tmpDb());
  const cols = db.prepare("SELECT name FROM pragma_table_info('reminders')").all().map((r) => r.name);
  for (const c of ['id', 'entity_type', 'entity_key', 'remind_at', 'status', 'created_at', 'triggered_at', 'read_at']) {
    assert.ok(cols.includes(c), `reminders 缺少列 ${c}`);
  }
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'")
    .all().map((r) => r.name);
  assert.ok(idx.includes('reminders_due'), '缺少 reminders_due 索引');
  assert.ok(idx.includes('reminders_active_entity'), '缺少 reminders_active_entity 唯一索引');
  db.close();
});

test('提醒迁移：既有旧 schema 不丢行，重复迁移幂等', () => {
  const dbPath = tmpDb();
  // 旧 schema（无 reminders 表）先写入既有行
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '其他',
    due_date TEXT NOT NULL DEFAULT '',
    focus_date TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    done_at TEXT
  )`);
  old.prepare('INSERT INTO tasks (title, category, due_date, focus_date, done, notes, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
    .run('既有任务', '生活', '', '', 0, '', '2026-09-20T00:00:00.000Z');
  old.close();

  // 重复 openDb（迁移执行两次）不报错、既有行保留
  const db1 = openDb(dbPath);
  const db2 = openDb(dbPath);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, '迁移不得丢既有行');
  assert.equal(db2.prepare('SELECT title FROM tasks').get().title, '既有任务');
  db1.close();
  db2.close();
});

test('提醒唯一约束：同一实体同时只有一个活跃提醒', () => {
  const db = openDb(tmpDb());
  const insert = db.prepare('INSERT INTO reminders (entity_type, entity_key, remind_at, status, created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('task', 'manual:1', '2030-01-01T00:00:00.000Z', 'scheduled', '2026-09-22T00:00:00.000Z');
  // 同一实体再插入活跃提醒 → 唯一约束拒绝
  assert.throws(
    () => insert.run('task', 'manual:1', '2030-01-02T00:00:00.000Z', 'scheduled', '2026-09-22T00:00:00.000Z'),
    /UNIQUE/i,
  );
  // 取消后可重新设置（read 状态同样不占活跃位）
  db.prepare("UPDATE reminders SET status = 'cancelled' WHERE entity_key = 'manual:1'").run();
  insert.run('task', 'manual:1', '2030-01-02T00:00:00.000Z', 'scheduled', '2026-09-22T00:00:00.000Z');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_key = 'manual:1'").get().n, 2);
  db.close();
});

// ---------- 6B：受保护提醒 API（注入时钟，测试不真等时间） ----------

test('提醒创建：201 返回完整记录，含实体标题与可跳转 id', async () => {
  const task = await createOpenTask('准备明天面试');
  const res = await createReminder('task', task.id);
  assert.equal(res.status, 201, res.text);
  const r = res.json;
  assert.equal(r.entity_type, 'task');
  assert.equal(r.entity_key, `manual:${task.id}`);
  assert.equal(r.entity_id, task.id, '客户端据此跳转详情');
  assert.equal(r.remind_at, '2026-09-23T09:00:00.000Z');
  assert.equal(r.status, 'scheduled');
  assert.equal(r.entity_title, '准备明天面试');
  assert.ok(r.created_at);
  assert.equal(r.triggered_at, null);
  assert.equal(r.read_at, null);
});

test('提醒创建校验：时间必须带时区且在未来，实体必须存在且未完成', async () => {
  const task = await createOpenTask('校验任务');
  // 无时区 → 400
  assert.equal((await createReminder('task', task.id, '2026-09-23T09:00:00')).status, 400);
  // 非法日期字符串 → 400
  assert.equal((await createReminder('task', task.id, '2026-13-99T25:00:00.000Z')).status, 400);
  // 过去时间 → 400
  assert.equal((await createReminder('task', task.id, '2026-09-21T09:00:00.000Z')).status, 400);
  // 恰好等于当前时刻 → 400（必须严格未来）
  assert.equal((await createReminder('task', task.id, clock)).status, 400);
  // 非法 entity_type → 400
  assert.equal((await api('POST', '/api/reminders',
    { entity_type: 'xyz', entity_key: 'manual:1', remind_at: '2026-09-23T09:00:00.000Z' })).status, 400);
  // 非法 entity_key → 400
  assert.equal((await api('POST', '/api/reminders',
    { entity_type: 'task', entity_key: '1', remind_at: '2026-09-23T09:00:00.000Z' })).status, 400);
  // 不存在实体 → 404
  assert.equal((await api('POST', '/api/reminders',
    { entity_type: 'task', entity_key: 'manual:99999', remind_at: '2026-09-23T09:00:00.000Z' })).status, 404);
  // 已完成任务 → 400
  await api('PATCH', `/api/tasks/${task.id}`, { done: true });
  assert.equal((await createReminder('task', task.id)).status, 400);
});

test('提醒创建：同步键在无 source 列的实例上不可引用，提示复制为个人待办', async () => {
  const res = await api('POST', '/api/reminders',
    { entity_type: 'task', entity_key: 'hermes:ext-1', remind_at: '2026-09-23T09:00:00.000Z' });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /复制为个人待办/);
});

test('提醒创建：同一实体重复活跃提醒 → 409；取消后可重新设置', async () => {
  const task = await createOpenTask('重复提醒');
  assert.equal((await createReminder('task', task.id)).status, 201);
  assert.equal((await createReminder('task', task.id, '2026-09-24T09:00:00.000Z')).status, 409);
  // 取消后重新设置成功（按实体键定位自己的提醒，文件级共享 server）
  const list = await api('GET', '/api/reminders');
  const mine = list.json.filter((r) => r.entity_key === `manual:${task.id}`);
  assert.equal(mine.length, 1);
  assert.equal((await api('PATCH', `/api/reminders/${mine[0].id}`, { status: 'cancelled' })).status, 200);
  assert.equal((await createReminder('task', task.id, '2026-09-24T09:00:00.000Z')).status, 201);
});

test('提醒读取：到期激活为未读，重复读取不重复触发，列表含实体信息', async () => {
  const task = await createOpenTask('到期提醒');
  await createReminder('task', task.id, '2026-09-22T00:30:00.000Z');
  const own = (r) => r.entity_key === `manual:${task.id}`;
  // 未到期：scheduled，不激活
  let res = await api('GET', '/api/reminders');
  assert.equal(res.status, 200);
  assert.equal(res.json.filter(own).length, 1);
  assert.equal(res.json.find(own).status, 'scheduled');
  assert.equal(res.json.find(own).triggered_at, null);
  // 时钟推进 → 第一次 GET 激活为 unread
  clock = '2026-09-22T01:00:00.000Z';
  res = await api('GET', '/api/reminders');
  assert.equal(res.json.find(own).status, 'unread');
  assert.ok(res.json.find(own).triggered_at);
  // 重复 GET 不重复触发：仍是一条 unread，不产生第二条
  res = await api('GET', '/api/reminders');
  assert.equal(res.json.filter(own).length, 1);
  assert.equal(res.json.find(own).status, 'unread');
  assert.equal(res.json.find(own).entity_title, '到期提醒');
});

test('提醒读取：实体完成或删除后活跃提醒取消（同事务，撤销完成不复活）', async () => {
  // 完成联动：PATCH done 时取消
  const t1 = await createOpenTask('完成后取消');
  await createReminder('task', t1.id, '2026-09-23T09:00:00.000Z');
  await api('PATCH', `/api/tasks/${t1.id}`, { done: true });
  let res = await api('GET', '/api/reminders');
  assert.equal(res.json.filter((r) => r.entity_key === `manual:${t1.id}`).length, 0,
    '完成任务后不得再出现在活跃列表');
  // 撤销完成不复活
  await api('PATCH', `/api/tasks/${t1.id}`, { done: false });
  res = await api('GET', '/api/reminders');
  assert.equal(res.json.filter((r) => r.entity_key === `manual:${t1.id}`).length, 0);

  // 删除联动
  const t2 = await createOpenTask('删除后取消');
  await createReminder('task', t2.id);
  await api('DELETE', `/api/tasks/${t2.id}`);
  res = await api('GET', '/api/reminders');
  assert.equal(res.json.filter((r) => r.entity_key === `manual:${t2.id}`).length, 0);

  // 日程也可设提醒；删除日程联动取消
  const ev = (await api('POST', '/api/events',
    { title: '面试提醒', date: '2026-09-23', start_time: '09:00' })).json;
  await createReminder('event', ev.id);
  res = await api('GET', '/api/reminders');
  assert.ok(res.json.some((r) => r.entity_type === 'event' && r.entity_title === '面试提醒'));
  await api('DELETE', `/api/events/${ev.id}`);
  res = await api('GET', '/api/reminders');
  assert.equal(res.json.filter((r) => r.entity_key === `manual:${ev.id}`).length, 0);
});

test('提醒更新：只允许改未来时间或标记 read/cancelled，不得篡改关联实体', async () => {
  const task = await createOpenTask('更新提醒');
  const created = (await createReminder('task', task.id)).json;
  // 未知 id → 404
  assert.equal((await api('PATCH', '/api/reminders/99999', { status: 'read' })).status, 404);
  // 改未来时间 → 200
  let res = await api('PATCH', `/api/reminders/${created.id}`, { remind_at: '2026-09-24T10:00:00.000Z' });
  assert.equal(res.status, 200);
  assert.equal(res.json.remind_at, '2026-09-24T10:00:00.000Z');
  // 改过去时间 → 400
  assert.equal((await api('PATCH', `/api/reminders/${created.id}`,
    { remind_at: '2026-01-01T00:00:00.000Z' })).status, 400);
  // 篡改关联实体 → 400
  assert.equal((await api('PATCH', `/api/reminders/${created.id}`,
    { entity_key: 'manual:99999' })).status, 400);
  // 非法 status → 400
  assert.equal((await api('PATCH', `/api/reminders/${created.id}`, { status: 'fired' })).status, 400);
  // 空更新 → 400
  assert.equal((await api('PATCH', `/api/reminders/${created.id}`, {})).status, 400);
  // 标记已读 → read_at 记录
  res = await api('PATCH', `/api/reminders/${created.id}`, { status: 'read' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'read');
  assert.ok(res.json.read_at);
  // 终态提醒不可改时间 → 400
  assert.equal((await api('PATCH', `/api/reminders/${created.id}`,
    { remind_at: '2026-09-25T10:00:00.000Z' })).status, 400);
  // 已读可转为取消
  res = await api('PATCH', `/api/reminders/${created.id}`, { status: 'cancelled' });
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'cancelled');
  // 已取消的提醒不可再改 → 400
  assert.equal((await api('PATCH', `/api/reminders/${created.id}`, { status: 'read' })).status, 400);
});
