'use strict';

// 真实浏览器行为测试：Playwright Chromium 驱动页面，验证可见控件真实可用。
// 每个测试独立临时数据库；页面事件监听 pageerror/console.error，结束必须无错误。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../support/browser-harness');

test('浏览器回归环境：登录后打开页面无错误，基础骨架渲染', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/today');
    await b.page.waitForSelector('#topbar-title');
    assert.equal(await b.page.textContent('#topbar-title'), '今日首页');
    // 背景 Canvas 存在且已渲染（单实例常驻）
    await b.page.waitForSelector('#nebula-canvas');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('校招投递页：点击「新增投递」打开弹窗（事件挂载不丢失）', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/campus');
    await b.page.waitForSelector('#btn-add-app');
    await b.page.click('#btn-add-app');
    await b.page.waitForSelector('#modal-mask:not([hidden])', { timeout: 4000 });
    assert.equal(await b.page.textContent('#modal-title'), '新增投递');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

/* ---------- 任务：快捷新增 → 真实 POST → 行可见 ---------- */

test('任务页：快捷表单新增任务 → 真实 POST → 行可见', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector('#form-add-task');
    await b.page.fill('#form-add-task [name="title"]', '买菜');
    await b.page.selectOption('#form-add-task [name="category"]', '生活');
    await b.page.click('#form-add-task button[type="submit"]');
    await b.page.waitForSelector('.task-row:has-text("买菜")');
    // 服务端确认真实写入
    const tasks = (await b.api('GET', '/api/tasks')).json;
    const row = tasks.find((t) => t.title === '买菜');
    assert.ok(row, '任务应已写入数据库');
    assert.equal(row.category, '生活');
    assert.equal(row.done, false);
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('任务页：勾选完成 → PATCH done → 待办计数减少且服务端持久化', async () => {
  const b = await launchBrowser();
  try {
    const t = (await b.api('POST', '/api/tasks', { title: '勾选测试', category: '生活' })).json;
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector(`[data-task-toggle="${t.id}"]`);
    const countText = await b.page.textContent('.two-col .section-title .count');
    const before = Number(countText.match(/\d+/)[0]);
    await b.page.click(`[data-task-toggle="${t.id}"]`);
    // 勾选后视图重渲染：该行移入已完成组且计数减一
    await b.page.waitForFunction(
      (before) => {
        const el = document.querySelector('.two-col .section-title .count');
        return el && Number(el.textContent.match(/\d+/)[0]) === before - 1;
      },
      before,
    );
    const done = (await b.api('GET', `/api/tasks/${t.id}`)).json;
    assert.equal(done.done, true, '服务端应记录完成状态');
    assert.ok(done.done_at, '服务端应记录完成时间');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('任务页：编辑任务（弹窗 PATCH）与删除（弹窗确认）', async () => {
  const b = await launchBrowser();
  try {
    const t = (await b.api('POST', '/api/tasks', { title: '编辑前', category: '学习' })).json;
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector(`[data-task-edit="${t.id}"]`);

    // 编辑：改标题与分类
    await b.page.click(`[data-task-edit="${t.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.fill('#mf-title', '编辑后');
    await b.page.selectOption('#mf-category', '实习');
    await b.page.click('#modal-form button[type="submit"]');
    await b.page.waitForSelector('.task-row:has-text("编辑后")');
    const patched = (await b.api('GET', `/api/tasks/${t.id}`)).json;
    assert.equal(patched.title, '编辑后');
    assert.equal(patched.category, '实习');

    // 删除：确认弹窗 → 真实 DELETE → 服务端记录消失；重载后行不再出现
    // （无重载的缓存失效由 test/cache-behavior.test.js 专门覆盖）
    b.page.on('dialog', (d) => d.accept());
    await b.page.click(`[data-task-edit="${t.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.click('#mf-delete');
    await b.page.waitForFunction(() => document.querySelector('#modal-mask').hidden);
    assert.equal((await b.api('GET', `/api/tasks/${t.id}`)).status, 404);
    await b.page.reload();
    await b.page.waitForSelector('.two-col');
    assert.equal(await b.page.locator('.task-row:has-text("编辑后")').count(), 0, '重载后已删除任务不应出现');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('任务页：编辑弹窗可取消且不发请求', async () => {
  const b = await launchBrowser();
  try {
    const t = (await b.api('POST', '/api/tasks', { title: '取消测试', category: '生活' })).json;
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector(`[data-task-edit="${t.id}"]`);
    let patchCount = 0;
    b.page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/api/tasks')) patchCount++; });
    await b.page.click(`[data-task-edit="${t.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.fill('#mf-title', '不应保存');
    await b.page.click('#mf-cancel');
    await b.page.waitForFunction(() => document.querySelector('#modal-mask').hidden);
    await b.page.waitForTimeout(300);
    assert.equal(patchCount, 0, '取消不应发出 PATCH 请求');
    const row = (await b.api('GET', `/api/tasks/${t.id}`)).json;
    assert.equal(row.title, '取消测试');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

/* ---------- 日程：新增 → 编辑 → 删除 ---------- */

test('任务页：日程快捷新增 → 编辑 → 删除（服务端持久化）', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector('#form-add-event');
    // 新增（日期取当前可见窗口内：近一周起 30 天）
    const { localToday, addDays } = require('../support/server-harness');
    const date = addDays(localToday(), 3);
    await b.page.fill('#form-add-event [name="title"]', '测试会议');
    await b.page.fill('#form-add-event [name="date"]', date);
    await b.page.fill('#form-add-event [name="start_time"]', '10:30');
    await b.page.click('#form-add-event button[type="submit"]');
    await b.page.waitForSelector('.event-item:has-text("测试会议")');
    const created = (await b.api('GET', '/api/events')).json.find((e) => e.title === '测试会议');
    assert.ok(created, '日程应已写入数据库');
    assert.equal(created.start_time, '10:30');

    // 编辑：改标题与地点
    await b.page.click(`[data-event-edit="${created.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.fill('#mf-title', '测试会议改期');
    await b.page.fill('#mf-location', '会议室A');
    await b.page.click('#modal-form button[type="submit"]');
    await b.page.waitForSelector('.event-item:has-text("测试会议改期")');
    const patched = (await b.api('GET', `/api/events/${created.id}`)).json;
    assert.equal(patched.title, '测试会议改期');
    assert.equal(patched.location, '会议室A');

    // 删除
    b.page.on('dialog', (d) => d.accept());
    await b.page.click(`[data-event-edit="${created.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.click('#mf-delete');
    await b.page.waitForFunction(() => document.querySelector('#modal-mask').hidden);
    assert.equal((await b.api('GET', `/api/events/${created.id}`)).status, 404);
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

/* ---------- 成果：新增 → 编辑 ---------- */

test('成果页：新增成果 → 时间线可见 → 编辑后更新', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/achievements');
    await b.page.waitForSelector('#btn-add-ach');
    await b.page.click('#btn-add-ach');
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.fill('#mf-title', '上线看板');
    await b.page.fill('#mf-date', '2026-09-10');
    await b.page.click('#modal-form button[type="submit"]');
    await b.page.waitForSelector('.tl-item:has-text("上线看板")');
    const created = (await b.api('GET', '/api/achievements')).json.find((a) => a.title === '上线看板');
    assert.ok(created, '成果应已写入数据库');

    await b.page.click(`[data-ach-edit="${created.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.fill('#mf-impact', '耗时降低 40%');
    await b.page.click('#modal-form button[type="submit"]');
    await b.page.waitForSelector('.tl-item:has-text("耗时降低 40%")');
    const patched = (await b.api('GET', `/api/achievements/${created.id}`)).json;
    assert.equal(patched.impact, '耗时降低 40%');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

/* ---------- 投递：搜索与状态筛选 ---------- */

test('投递页：搜索与状态筛选真实过滤列表', async () => {
  const b = await launchBrowser();
  try {
    await b.api('POST', '/api/applications', { company: '搜索目标公司', position: '前端', status: '面试' });
    await b.api('POST', '/api/applications', { company: '无关公司', position: '后端', status: '已投递' });
    await b.page.goto(b.baseUrl + '/#/campus');
    await b.page.waitForSelector('.lane');

    // 搜索：只显示匹配公司
    await b.page.fill('#campus-q', '搜索目标');
    await b.page.waitForFunction(() => {
      const lane = document.querySelector('.lane[data-status="面试"] .lane-cards');
      return lane && lane.textContent.includes('搜索目标公司')
        && !document.querySelector('.board').textContent.includes('无关公司');
    });

    // 状态筛选：点「Offer」chip → 其他泳道为空（当前无 Offer 记录）
    await b.page.fill('#campus-q', '');
    await b.page.waitForFunction(() => !document.querySelector('#campus-q').value);
    await b.page.click('.chip[data-status="Offer"]');
    await b.page.waitForFunction(() => {
      const offer = document.querySelector('.lane[data-status="Offer"] .lane-cards');
      const interview = document.querySelector('.lane[data-status="面试"] .lane-cards');
      return offer && interview && offer.textContent.includes('暂无记录')
        && !interview.textContent.includes('搜索目标公司');
    });

    // 清空筛选：恢复全部
    await b.page.click('.chip[data-status=""]');
    await b.page.waitForFunction(() => {
      const interview = document.querySelector('.lane[data-status="面试"] .lane-cards');
      return interview && interview.textContent.includes('搜索目标公司');
    });
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

/* ---------- 网络失败：保留输入、展示错误、不假成功 ---------- */

test('网络失败：新增任务 500 → 保留输入并展示错误，不出现假行', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector('#form-add-task');
    await b.page.route('**/api/tasks', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '服务器内部错误' }) });
      } else {
        await route.continue();
      }
    });
    await b.page.fill('#form-add-task [name="title"]', '会失败的任务');
    await b.page.click('#form-add-task button[type="submit"]');
    await b.page.waitForSelector('#toast:not([hidden])');
    assert.match(await b.page.textContent('#toast'), /服务器内部错误/);
    assert.ok(await b.page.inputValue('#form-add-task [name="title"]') === '会失败的任务', '输入应保留');
    assert.equal(await b.page.locator('.task-row:has-text("会失败的任务")').count(), 0, '不应出现假行');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('重复提交防护：一次表单提交只触发一次 POST（无重复监听）', async () => {
  const b = await launchBrowser();
  try {
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector('#form-add-task');
    let postCount = 0;
    b.page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/tasks')) postCount++; });
    await b.page.fill('#form-add-task [name="title"]', '单次提交');
    await b.page.click('#form-add-task button[type="submit"]');
    await b.page.waitForSelector('.task-row:has-text("单次提交")');
    await b.page.waitForTimeout(500);
    assert.equal(postCount, 1, '一次提交只能产生一个 POST 请求');
    const tasks = (await b.api('GET', '/api/tasks')).json;
    assert.equal(tasks.filter((t) => t.title === '单次提交').length, 1);
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});
