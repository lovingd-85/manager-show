'use strict';

// 首页可解释明细集合：全部待办含未来与无日期任务；笔试/面试总数与明细同一集合。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../support/server-harness');

test('全部待办包含未来和无日期，笔面试总数对应明细', async () => {
  const s = await startServer({ seed: false });
  try {
    await s.api('POST', '/api/tasks', { title: '取快递', category: '生活' });
    await s.api('POST', '/api/tasks', { title: '读书', due_date: '2030-01-01' });
    await s.api('POST', '/api/applications', {
      company: '测试公司', position: '测试岗位', status: '面试',
    });
    const { json: d } = await s.api('GET', '/api/dashboard?date=2026-09-22');
    assert.equal(d.openTasks.length, 2);
    assert.equal(d.stats.tasksOpen, d.openTasks.length);
    assert.equal(d.interviewApplications.length, 1);
    assert.equal(d.stats.interviewing, d.interviewApplications.length);
    assert.equal(d.interviewApplications[0].company, '测试公司');
  } finally { await s.close(); }
});

test('全部待办排序：逾期 → 今天 → 未来 → 无日期（同组按日期/id）', async () => {
  const s = await startServer({ seed: false });
  try {
    await s.api('POST', '/api/tasks', { title: '无日期', category: '生活' });
    await s.api('POST', '/api/tasks', { title: '未来', category: '生活', due_date: '2030-01-01' });
    await s.api('POST', '/api/tasks', { title: '今天', category: '生活', due_date: '2026-09-22' });
    await s.api('POST', '/api/tasks', { title: '逾期', category: '生活', due_date: '2026-09-01' });
    const { json: d } = await s.api('GET', '/api/dashboard?date=2026-09-22');
    assert.deepEqual(d.openTasks.map((t) => t.title), ['逾期', '今天', '未来', '无日期']);
  } finally { await s.close(); }
});

test('完成后今日重点消失（focus 只含未完成）', async () => {
  const s = await startServer({ seed: false });
  try {
    const t = (await s.api('POST', '/api/tasks', { title: '重点任务', focus_date: '2026-09-22' })).json;
    let d = (await s.api('GET', '/api/dashboard?date=2026-09-22')).json;
    assert.ok(d.focus.some((x) => x.id === t.id), '今日重点应包含未完成任务');
    await s.api('PATCH', `/api/tasks/${t.id}`, { done: true });
    d = (await s.api('GET', '/api/dashboard?date=2026-09-22')).json;
    assert.ok(!d.focus.some((x) => x.id === t.id), '已完成任务不应出现在今日重点');
  } finally { await s.close(); }
});

test('笔试/面试明细与最近日程互不代替：按下一步日期排序，无日期在最后', async () => {
  const s = await startServer({ seed: false });
  try {
    await s.api('POST', '/api/applications', {
      company: '无日期公司', position: '岗位A', status: '笔试', next_step: '等待安排',
    });
    await s.api('POST', '/api/applications', {
      company: '有日期公司', position: '岗位B', status: '面试', next_step: '二面', next_step_date: '2026-09-25',
    });
    // 近期日程中的同名条目不应影响笔面试明细集合
    await s.api('POST', '/api/events', { title: '有日期公司：岗位B', date: '2026-09-25', start_time: '10:00' });
    const { json: d } = await s.api('GET', '/api/dashboard?date=2026-09-22');
    assert.deepEqual(d.interviewApplications.map((a) => a.company), ['有日期公司', '无日期公司']);
    assert.equal(d.stats.interviewing, d.interviewApplications.length);
    assert.equal(d.interviewApplications[0].next_step_date, '2026-09-25');
  } finally { await s.close(); }
});
