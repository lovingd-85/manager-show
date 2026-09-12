'use strict';

// 任务与日程的行为测试。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
