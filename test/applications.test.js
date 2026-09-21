'use strict';

// 校招投递 CRM 的行为测试：CRUD、筛选、校验、404。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../support/server-harness');

let api, close;
// 重置示例数据接口默认关闭：本文件的重置测试需要显式开启（隔离测试实例）
before(async () => { ({ api, close } = await startServer({ appOptions: { allowSeedReset: true } })); });
after(() => close());

test('种子数据：列表非空且包含示例公司', async () => {
  const res = await api('GET', '/api/applications');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json));
  assert.ok(res.json.length >= 5, '应有至少 5 条示例投递');
  const companies = res.json.map((a) => a.company);
  assert.ok(companies.includes('阿里巴巴'));
});

test('创建投递：必填校验与默认值', async () => {
  const bad = await api('POST', '/api/applications', { company: '测试公司' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error);

  const badStatus = await api('POST', '/api/applications', {
    company: '测试公司', position: '前端', status: '不存在的状态',
  });
  assert.equal(badStatus.status, 400);

  const badDate = await api('POST', '/api/applications', {
    company: '测试公司', position: '前端', applied_at: '2026/01/01',
  });
  assert.equal(badDate.status, 400);

  const ok = await api('POST', '/api/applications', {
    company: '测试公司', position: '前端开发', city: '上海',
  });
  assert.equal(ok.status, 201);
  assert.ok(ok.json.id > 0);
  assert.equal(ok.json.status, '已投递', '默认状态应为已投递');
  assert.equal(ok.json.priority, '中', '默认优先级应为中');
});

test('读取、更新、删除单条投递；不存在返回 404', async () => {
  const created = (await api('POST', '/api/applications', {
    company: '临时公司', position: '后端开发', notes: '备注',
  })).json;

  const got = await api('GET', `/api/applications/${created.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.json.company, '临时公司');

  const patched = await api('PATCH', `/api/applications/${created.id}`, {
    status: '面试', next_step: '二面', next_step_date: '2026-09-20',
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.status, '面试');
  assert.equal(patched.json.next_step, '二面');
  assert.equal(patched.json.company, '临时公司', '未更新字段应保持不变');
  assert.ok(patched.json.updated_at >= created.updated_at);

  const invalidPatch = await api('PATCH', `/api/applications/${created.id}`, { status: '乱写' });
  assert.equal(invalidPatch.status, 400);

  const missing = await api('GET', '/api/applications/999999');
  assert.equal(missing.status, 404);
  assert.equal((await api('PATCH', '/api/applications/999999', { city: 'x' })).status, 404);
  assert.equal((await api('DELETE', '/api/applications/999999')).status, 404);

  assert.equal((await api('DELETE', `/api/applications/${created.id}`)).status, 204);
  assert.equal((await api('GET', `/api/applications/${created.id}`)).status, 404);
});

test('筛选：按状态与关键词过滤', async () => {
  const all = (await api('GET', '/api/applications')).json;
  const byStatus = (await api('GET', '/api/applications?status=' + encodeURIComponent('面试'))).json;
  assert.ok(byStatus.length > 0, '种子中应有面试中的投递');
  assert.ok(byStatus.every((a) => a.status === '面试'));
  assert.ok(byStatus.length < all.length);

  const byKeyword = (await api('GET', '/api/applications?q=' + encodeURIComponent('阿里'))).json;
  assert.ok(byKeyword.length >= 1);
  assert.ok(byKeyword.every((a) => (a.company + a.position).includes('阿里')));

  const none = (await api('GET', '/api/applications?q=' + encodeURIComponent('不存在公司xyz'))).json;
  assert.equal(none.length, 0);

  const invalidStatus = await api('GET', '/api/applications?status=' + encodeURIComponent('不存在'));
  assert.equal(invalidStatus.status, 400);
});

test('重置示例数据：清空并重新写入种子', async () => {
  const beforeReset = (await api('GET', '/api/applications')).json;
  const res = await api('POST', '/api/seed/reset');
  assert.equal(res.status, 200);
  assert.ok(res.json.counts.applications >= 5);
  const afterReset = (await api('GET', '/api/applications')).json;
  assert.equal(afterReset.length, res.json.counts.applications);
  assert.ok(afterReset.every((a) => !beforeReset.some((b) => b.id === a.id && b.company === '临时公司')));
});
