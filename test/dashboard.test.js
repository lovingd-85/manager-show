'use strict';

// 今日驾驶舱聚合与静态页面的行为测试。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, localToday, addDays } = require('../support/server-harness');

let api, page, close;
before(async () => { ({ api, page, close } = await startServer()); });
after(() => close());

test('仪表盘：结构与统计数字', async () => {
  const today = localToday();
  const res = await api('GET', `/api/dashboard?date=${today}`);
  assert.equal(res.status, 200);
  const d = res.json;
  assert.equal(d.date, today);
  for (const key of ['focus', 'overdueTasks', 'todayTasks', 'riskApplications', 'upcomingEvents', 'stats']) {
    assert.ok(key in d, `缺少字段 ${key}`);
  }
  assert.ok(d.stats.applications >= 5);
  assert.ok(d.stats.tasksOpen >= 1);
  assert.ok(typeof d.stats.offers === 'number');
});

test('仪表盘：逾期任务与风险投递（种子数据）', async () => {
  const today = localToday();
  const d = (await api('GET', `/api/dashboard?date=${today}`)).json;

  assert.ok(d.overdueTasks.length >= 1, '种子中应有逾期任务');
  assert.ok(d.overdueTasks.every((t) => t.due_date && t.due_date < today && !t.done));

  assert.ok(d.riskApplications.length >= 1, '种子中应有风险投递（下一步日期已过）');
  assert.ok(d.riskApplications.every((a) =>
    a.next_step_date && a.next_step_date < today && !['Offer', '已拒绝', '已结束'].includes(a.status)));

  assert.ok(d.upcomingEvents.every((e) => e.date >= today && e.date <= addDays(today, 7)));
  assert.ok(d.focus.length >= 1, '种子中应有今日重点');
  assert.ok(d.focus.every((t) => t.focus_date === today));
});

test('仪表盘：显式指定日期（确定性）', async () => {
  const today = localToday();
  const future = addDays(today, 3);
  const d = (await api('GET', `/api/dashboard?date=${future}`)).json;
  assert.equal(d.date, future);
  assert.ok(d.overdueTasks.every((t) => t.due_date < future));
  const bad = await api('GET', '/api/dashboard?date=2026/09/09');
  assert.equal(bad.status, 400);
});

test('健康检查与静态首页', async () => {
  const health = await api('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);

  const res = await page('/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Manager Show|今日/);

  const css = await page('/styles.css');
  assert.equal(css.status, 200);
  const js = await page('/app.js');
  assert.equal(js.status, 200);

  const notFound = await api('GET', '/api/不存在');
  assert.equal(notFound.status, 404);
  assert.ok(notFound.json.error, '未知 API 应返回 JSON 错误');
});
