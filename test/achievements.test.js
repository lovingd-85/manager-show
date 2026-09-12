'use strict';

// 实习成果记录的行为测试。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../support/server-harness');

let api, close;
before(async () => { ({ api, close } = await startServer()); });
after(() => close());

test('成果：创建校验与列表排序', async () => {
  const bad = await api('POST', '/api/achievements', { title: '没有日期' });
  assert.equal(bad.status, 400);

  const a = (await api('POST', '/api/achievements', {
    title: '成果A', date: '2026-08-01', category: '项目', impact: '提升 30%',
  })).json;
  const b = (await api('POST', '/api/achievements', {
    title: '成果B', date: '2026-09-01', category: '学习',
  })).json;

  const list = (await api('GET', '/api/achievements')).json;
  assert.ok(list.length >= 2);
  const idxA = list.findIndex((x) => x.id === a.id);
  const idxB = list.findIndex((x) => x.id === b.id);
  assert.ok(idxB < idxA, '成果应按日期倒序排列');
  assert.equal(list[idxA].impact, '提升 30%');
});

test('成果：更新与删除，404 处理', async () => {
  const created = (await api('POST', '/api/achievements', { title: '临时成果', date: '2026-09-05' })).json;
  const patched = (await api('PATCH', `/api/achievements/${created.id}`, { title: '改名成果', description: '补充说明' })).json;
  assert.equal(patched.title, '改名成果');
  assert.equal(patched.description, '补充说明');

  assert.equal((await api('GET', '/api/achievements/999999')).status, 404);
  assert.equal((await api('DELETE', `/api/achievements/${created.id}`)).status, 204);
  assert.equal((await api('GET', `/api/achievements/${created.id}`)).status, 404);
});
