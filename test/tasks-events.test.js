'use strict';

// 任务与日程的行为测试。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { todayLocal, parseDateTimeLocalCN, isValidDate } = require('../src/dates');
const { startServer, localToday, addDays } = require('../support/server-harness');

let api, close;
before(async () => { ({ api, close } = await startServer()); });
after(() => close());

test('任务：创建校验与完成切换', async () => {
  const bad = await api('POST', '/api/tasks', { title: '' });
  assert.equal(bad.status, 400);

  const created = (await api('POST', '/api/tasks', {
    title: '测试任务', due_date: localToday(), category: '求职',
  })).json;
  assert.equal(created.done, false);
  assert.equal(created.done_at, null);

  const done = (await api('PATCH', `/api/tasks/${created.id}`, { done: true })).json;
  assert.equal(done.done, true);
  assert.ok(done.done_at, '完成时应记录完成时间');

  const undone = (await api('PATCH', `/api/tasks/${created.id}`, { done: false })).json;
  assert.equal(undone.done, false);
  assert.equal(undone.done_at, null, '取消完成应清空完成时间');

  const badDate = await api('POST', '/api/tasks', { title: 'x', due_date: '9月1日' });
  assert.equal(badDate.status, 400);
});

test('任务：生活任务无需 application id，自定义分类原样透传（回归）', async () => {
  // 无日期、无 application_id 的生活任务可创建
  const life = (await api('POST', '/api/tasks', { title: '买菜', category: '生活' })).json;
  assert.equal(life.category, '生活');
  assert.equal(life.due_date, '');
  assert.equal(life.done, false);

  // 自定义分类（不在前端预设列表）经 PATCH 往返原样保留，不被服务端改写
  const custom = (await api('POST', '/api/tasks', { title: '临时分类', category: '临时' })).json;
  const patched = (await api('PATCH', `/api/tasks/${custom.id}`, { title: '临时分类改' })).json;
  assert.equal(patched.category, '临时');
  const fetched = (await api('GET', `/api/tasks/${custom.id}`)).json;
  assert.equal(fetched.category, '临时');
});

test('日期：todayLocal 与 parseDateTimeLocalCN 均按 Asia/Shanghai，不随主机时区变化', () => {
  // 2026-09-21T16:30:00Z = 上海 2026-09-22 00:30（UTC/美东仍是 09-21）
  assert.equal(todayLocal(new Date('2026-09-21T16:30:00Z')), '2026-09-22');
  // 2026-09-21T15:59:59Z = 上海 2026-09-21 23:59
  assert.equal(todayLocal(new Date('2026-09-21T15:59:59Z')), '2026-09-21');
  // 上海正午 = UTC 04:00
  assert.equal(todayLocal(new Date('2026-09-22T04:00:00Z')), '2026-09-22');

  // datetime-local 输入按 +08:00 明确解释并转 UTC
  assert.equal(parseDateTimeLocalCN('2026-09-22T09:30'), '2026-09-22T01:30:00.000Z');
  assert.equal(parseDateTimeLocalCN('2026-09-22T09:30:00'), '2026-09-22T01:30:00.000Z');
  assert.equal(parseDateTimeLocalCN('2026-09-22T00:00'), '2026-09-21T16:00:00.000Z');
  // 非法输入拒绝，绝不靠 JS Date 静默滚动（02-30 会滚成 03-02）
  assert.equal(parseDateTimeLocalCN('2026-02-30T10:00'), null);
  assert.equal(parseDateTimeLocalCN('2026-13-01T10:00'), null);
  assert.equal(parseDateTimeLocalCN('2026-09-22T25:00'), null);
  assert.equal(parseDateTimeLocalCN('2026-09-22 09:30'), null);
  assert.equal(parseDateTimeLocalCN(''), null);
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-02-28'), true);
});

test('任务：手工创建 source=manual；同步记录只读（有 source 列时）', async () => {
  // 模拟同步脚本已运行：建库 → 加 source/external_key 列 → 再启动服务
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-src-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const warmup = await startServer({ appOptions: { dbPath } });
  await warmup.close();
  const db = new DatabaseSync(dbPath);
  db.exec(`ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
  db.exec(`ALTER TABLE tasks ADD COLUMN external_key TEXT NOT NULL DEFAULT ''`);
  db.prepare(`INSERT INTO tasks (title, category, due_date, focus_date, done, notes, created_at, done_at, source, external_key)
    VALUES ('同步任务', '生活', '', '', 0, '', '2026-09-20T00:00:00.000Z', NULL, 'tracker', 't1')`).run();
  db.close();

  const srv = await startServer({ appOptions: { dbPath } });
  try {
    // 手工创建带 source=manual
    const created = (await srv.api('POST', '/api/tasks', { title: '手工任务', category: '生活' })).json;
    assert.equal(created.source, 'manual');

    // 同步记录可读、可见 source
    const all = (await srv.api('GET', '/api/tasks')).json;
    const synced = all.find((t) => t.title === '同步任务');
    assert.ok(synced, '同步任务应可见');
    assert.equal(synced.source, 'tracker');
    assert.equal(synced.external_key, 't1');

    // 同步记录只读：PATCH/DELETE 拒绝，不装作保存成功
    const patched = await srv.api('PATCH', `/api/tasks/${synced.id}`, { title: '改同步任务' });
    assert.equal(patched.status, 409);
    const deleted = await srv.api('DELETE', `/api/tasks/${synced.id}`);
    assert.equal(deleted.status, 409);
    const after = (await srv.api('GET', `/api/tasks/${synced.id}`)).json;
    assert.equal(after.title, '同步任务', '同步记录不得被改写');

    // 手工任务仍可正常编辑
    const manualPatched = await srv.api('PATCH', `/api/tasks/${created.id}`, { title: '手工任务改' });
    assert.equal(manualPatched.status, 200);
  } finally {
    await srv.close();
  }
});

test('任务：今日重点标记（focus_date）', async () => {
  const t = (await api('POST', '/api/tasks', { title: '重点测试', focus_date: localToday() })).json;
  assert.equal(t.focus_date, localToday());

  const dash = (await api('GET', `/api/dashboard?date=${localToday()}`)).json;
  assert.ok(dash.focus.some((x) => x.id === t.id), '仪表盘今日重点应包含该任务');
});

test('日程：创建校验与区间查询', async () => {
  const bad = await api('POST', '/api/events', { title: '没有日期' });
  assert.equal(bad.status, 400);
  const badTime = await api('POST', '/api/events', { title: 'x', date: localToday(), start_time: '25:00' });
  assert.equal(badTime.status, 400);

  const from = localToday();
  const to = addDays(from, 7);
  const created = (await api('POST', '/api/events', {
    title: '测试会议', date: addDays(from, 2), start_time: '10:00', end_time: '11:00', location: '线上',
  })).json;
  assert.equal(created.title, '测试会议');

  const inRange = (await api('GET', `/api/events?from=${from}&to=${to}`)).json;
  assert.ok(inRange.some((e) => e.id === created.id));
  assert.ok(inRange.every((e) => e.date >= from && e.date <= to), '结果应都在区间内');
  for (let i = 1; i < inRange.length; i++) {
    const a = inRange[i - 1], b = inRange[i];
    assert.ok(a.date < b.date || (a.date === b.date && (a.start_time || '') <= (b.start_time || '')),
      '日程应按日期与时间升序');
  }

  const badRange = await api('GET', '/api/events?from=abc');
  assert.equal(badRange.status, 400);

  assert.equal((await api('DELETE', `/api/events/${created.id}`)).status, 204);
  assert.equal((await api('GET', `/api/events/999999`)).status, 404);
});
