'use strict';

// 可分享筛选路由：URL 参数驱动 campus/tasks 视图，刷新与前进后退保持筛选，深链定位单条记录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../support/browser-harness');

test('任务页 state=done：URL 驱动筛选，刷新后保持，未完成项不出现', async () => {
  const b = await launchBrowser();
  try {
    await b.api('POST', '/api/tasks', { title: '未完成项', category: '生活' });
    const done = (await b.api('POST', '/api/tasks', { title: '已完成项', category: '生活' })).json;
    await b.api('PATCH', `/api/tasks/${done.id}`, { done: true });
    await b.page.goto(b.baseUrl + '/#/tasks?state=done');
    await b.page.waitForSelector('.task-row:has-text("已完成项")');
    assert.equal(await b.page.locator('.task-row:has-text("未完成项")').count(), 0, 'state=done 不应显示未完成');
    await b.page.reload();
    await b.page.waitForSelector('.task-row:has-text("已完成项")');
    assert.equal(await b.page.locator('.task-row:has-text("未完成项")').count(), 0, '刷新后筛选保持');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('任务页 category 筛选：只显示对应分类；未知分类忽略', async () => {
  const b = await launchBrowser();
  try {
    await b.api('POST', '/api/tasks', { title: '学英语', category: '学习' });
    await b.api('POST', '/api/tasks', { title: '买菜', category: '生活' });
    await b.page.goto(b.baseUrl + '/#/tasks?category=' + encodeURIComponent('学习'));
    await b.page.waitForSelector('.task-row:has-text("学英语")');
    assert.equal(await b.page.locator('.task-row:has-text("买菜")').count(), 0, '分类筛选应只显示学习');
    // 未知分类：忽略参数，显示全部
    await b.page.goto(b.baseUrl + '/#/tasks?category=bogus');
    await b.page.waitForSelector('.task-row:has-text("学英语")');
    await b.page.waitForSelector('.task-row:has-text("买菜")');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('任务页 id 深链：存在则进入记录；不存在显示「事项已更新或删除」', async () => {
  const b = await launchBrowser();
  try {
    const t = (await b.api('POST', '/api/tasks', { title: '深链任务', category: '生活' })).json;
    await b.page.goto(b.baseUrl + `/#/tasks?id=${t.id}`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    assert.equal(await b.page.textContent('#modal-title'), `编辑任务`);
    assert.ok((await b.page.inputValue('#mf-title')) === '深链任务');
    await b.page.click('#mf-cancel');
    await b.page.waitForFunction(() => document.querySelector('#modal-mask').hidden);

    // 不存在的 id：说明原因而非空白
    await b.page.goto(b.baseUrl + '/#/tasks?id=999999');
    await b.page.waitForSelector('.empty');
    assert.match(await b.page.textContent('#view'), /事项已更新或删除/);
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('投递页 stage=interviewing：笔试/面试组合本地筛选，前进后退可用', async () => {
  const b = await launchBrowser();
  try {
    await b.api('POST', '/api/applications', { company: '面试公司', position: 'p', status: '面试' });
    await b.api('POST', '/api/applications', { company: '笔试公司', position: 'p', status: '笔试' });
    await b.api('POST', '/api/applications', { company: '投递公司', position: 'p', status: '已投递' });
    await b.page.goto(b.baseUrl + '/#/campus?stage=interviewing');
    await b.page.waitForSelector('.app-card:has-text("面试公司")');
    assert.equal(await b.page.locator('.app-card:has-text("笔试公司")').count(), 1, '笔试应包含在组合筛选内');
    assert.equal(await b.page.locator('.app-card:has-text("投递公司")').count(), 0, '已投递不应出现');
    await b.page.reload();
    await b.page.waitForSelector('.app-card:has-text("面试公司")');
    assert.equal(await b.page.locator('.app-card:has-text("投递公司")').count(), 0, '刷新后组合筛选保持');

    // 清除筛选 → 前进后退恢复
    await b.page.click('.chip[data-status=""]');
    await b.page.waitForSelector('.app-card:has-text("投递公司")');
    await b.page.goBack();
    await b.page.waitForSelector('.app-card:has-text("面试公司")');
    assert.equal(await b.page.locator('.app-card:has-text("投递公司")').count(), 0, '后退应恢复组合筛选');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('投递页 status=Offer 空结果：显示原因与清除筛选，不保留无解释数字', async () => {
  const b = await launchBrowser();
  try {
    await b.api('POST', '/api/applications', { company: '投递公司', position: 'p', status: '已投递' });
    await b.page.goto(b.baseUrl + '/#/campus?status=Offer');
    await b.page.waitForSelector('.filter-empty');
    const text = await b.page.textContent('#view');
    assert.match(text, /Offer/);
    assert.match(text, /没有符合/);
    // 清除筛选操作回到全部
    await b.page.click('#clear-filter');
    await b.page.waitForSelector('.app-card:has-text("投递公司")');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('投递页 id 深链与非法 id：存在则进入记录；非法 id 不请求并显示全部', async () => {
  const b = await launchBrowser();
  try {
    const a = (await b.api('POST', '/api/applications', { company: '深链公司', position: '深链岗位', status: '面试' })).json;
    await b.page.goto(b.baseUrl + `/#/campus?id=${a.id}`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    assert.equal(await b.page.textContent('#modal-title'), `编辑投递 · 深链公司`);
    await b.page.click('#mf-cancel');
    await b.page.waitForFunction(() => document.querySelector('#modal-mask').hidden);

    // 非法 id：忽略参数，不发起单条请求，显示全部
    let singleRequests = 0;
    b.page.on('request', (r) => { if (/\/api\/applications\/abc/.test(r.url())) singleRequests++; });
    await b.page.goto(b.baseUrl + '/#/campus?id=abc');
    await b.page.waitForSelector('.app-card:has-text("深链公司")');
    assert.equal(singleRequests, 0, '非法 id 不应请求');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});
