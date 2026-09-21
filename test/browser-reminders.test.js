'use strict';

// 6C：站内提醒中心（真实 Playwright + 临时 DB + 注入时钟，不真等时间）。
// 覆盖：表单提醒字段、铃铛入口与固定说明、到期轮询激活、重载补看、已读/取消、
// 完成联动取消、提醒失败不推翻已保存事项、upsert、轮询不打断编辑、通知授权拒绝不破坏中心。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../support/browser-harness');

const BASE_CLOCK = '2026-09-22T00:00:00.000Z';
let clock = BASE_CLOCK;
test.beforeEach(() => { clock = BASE_CLOCK; });

function open() {
  return launchBrowser({ appOptions: { now: () => clock } });
}

// 前台轮询触发点：页面可见性变化立即轮询（30s 定时太长，测试通过合成事件触发）
async function poll(page) {
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(200);
}

async function createTaskWithReminder(api, { title = '提醒事项', remindAt = '2026-09-23T01:00:00.000Z' } = {}) {
  const task = (await api('POST', '/api/tasks', { title, category: '生活' })).json;
  await api('POST', '/api/reminders', { entity_type: 'task', entity_key: `manual:${task.id}`, remind_at: remindAt });
  return task;
}

test('表单设置提醒：铃铛面板显示标题/时间/来源与固定站内说明，可跳转事项', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#btn-quick-task');
    await page.click('#btn-quick-task');
    await page.fill('#mf-title', '提醒我交周报');
    await page.fill('#mf-remind_at', '2026-09-23T09:00');
    await page.click('#modal-form button[type=submit]');
    await page.waitForSelector('#modal-mask[hidden]', { state: 'attached' });
    const tasks = await (await api('GET', '/api/tasks')).json;
    assert.equal(tasks.length, 1, '任务应已创建');

    await page.click('#btn-reminders');
    await page.waitForSelector('#reminders-panel.open');
    const panel = await page.textContent('#reminders-panel');
    assert.match(panel, /站内提醒；关闭网页时不会主动推送/, '必须常驻说明站内提醒边界');
    assert.match(panel, /提醒我交周报/);
    assert.match(panel, /9月23日/, '提醒时间按中国时区显示');
    assert.match(panel, /待办/, '显示事项来源');

    // 查看事项 → 深链打开任务编辑弹窗
    await page.click('[data-rem-view]');
    await page.waitForSelector('#modal-mask:not([hidden])', { timeout: 4000 });
    assert.equal(await page.inputValue('#mf-title'), '提醒我交周报');
    await page.keyboard.press('Escape');

    b.assertNoPageErrors('提醒中心');
  } finally {
    await b.close();
  }
});

test('到期激活：轮询后未读角标出现；通知决策仅触发一次且被拒绝时不破坏中心', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await createTaskWithReminder(api, { remindAt: '2026-09-23T01:00:00.000Z' });

    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#reminders-count', { state: 'attached' });
    assert.equal(await page.isHidden('#reminders-count'), true, '未到期不计未读');

    clock = '2026-09-23T02:00:00.000Z';
    await poll(page);
    await page.waitForSelector('#reminders-count:not([hidden])');
    assert.equal((await page.textContent('#reminders-count')).trim(), '1');
    // 通知决策（真实代码路径至权限门）：新未读只产生一次候选；headless Chromium 一律
    // 拒绝通知权限 → 不发送系统通知、也不报错（授权分支在真实浏览器点击启用后生效）
    assert.equal(await page.evaluate(() => window.__msNotifyCandidates || 0), 1);
    assert.equal(await page.evaluate(() => window.__msNotified || 0), 0, '未授权不发系统通知');
    await poll(page);
    assert.equal(await page.evaluate(() => window.__msNotifyCandidates || 0), 1, '重复轮询不重复通知');

    b.assertNoPageErrors('到期激活');
  } finally {
    await b.close();
  }
});

test('重载补看：刷新后未读仍在；已读后消失；取消待触发提醒后消失', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await createTaskWithReminder(api, { title: '补看未读', remindAt: '2026-09-23T01:00:00.000Z' });
    clock = '2026-09-23T02:00:00.000Z';   // 创建成功后再推进时钟 → 首屏即到期

    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#reminders-count:not([hidden])');
    await page.reload();
    await page.waitForSelector('#reminders-count:not([hidden])');
    assert.equal((await page.textContent('#reminders-count')).trim(), '1', '重载后未读计数不丢');

    // 已读 → 从列表消失、角标隐藏
    await page.click('#btn-reminders');
    await page.waitForSelector('#reminders-panel.open');
    await page.click('[data-rem-read]');
    await page.waitForFunction(() => document.querySelector('#reminders-list').textContent.includes('暂无提醒'));
    assert.equal(await page.isHidden('#reminders-count'), true);
    await page.click('#btn-reminders');   // 关闭面板

    // 取消待触发提醒 → 消失
    await createTaskWithReminder(api, { title: '待取消', remindAt: '2026-09-24T01:00:00.000Z' });
    await poll(page);
    await page.click('#btn-reminders');
    await page.waitForSelector('[data-rem-cancel]');
    await page.click('[data-rem-cancel]');
    await page.waitForFunction(() => document.querySelector('#reminders-list').textContent.includes('暂无提醒'));
    assert.equal((await api('GET', '/api/reminders')).json.length, 0, '服务端不再有活跃提醒');

    b.assertNoPageErrors('已读与取消');
  } finally {
    await b.close();
  }
});

test('完成任务：活跃提醒联动取消，轮询后从面板消失', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await createTaskWithReminder(api, { title: '完成后取消' });

    await page.goto(baseUrl + '/#/tasks');
    await page.waitForSelector('[data-task-toggle]');
    await page.click('[data-task-toggle]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('已完成'));
    assert.equal((await api('GET', '/api/reminders')).json.length, 0, '完成事务内已取消');

    await poll(page);
    await page.click('#btn-reminders');
    await page.waitForSelector('#reminders-panel.open');
    assert.match(await page.textContent('#reminders-list'), /暂无提醒/);

    b.assertNoPageErrors('完成联动');
  } finally {
    await b.close();
  }
});

test('提醒设置失败：事项已保存且如实提示，不假成功、不重复创建', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#btn-quick-task');
    await page.click('#btn-quick-task');
    await page.fill('#mf-title', '过去时间提醒');
    await page.fill('#mf-remind_at', '2026-01-01T09:00');   // 过去时间 → 服务端拒绝
    await page.click('#modal-form button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('事项已保存，提醒设置失败，请重试'));
    await page.waitForSelector('#modal-mask[hidden]', { state: 'attached' });
    const tasks = await (await api('GET', '/api/tasks')).json;
    assert.equal(tasks.length, 1, '任务保留，不因提醒失败回滚');
    assert.equal((await api('GET', '/api/reminders')).json.length, 0, '不创建无效提醒');

    b.assertNoPageErrors('提醒失败路径');
  } finally {
    await b.close();
  }
});

test('同一事项两次保存提醒 = 更新活跃提醒（upsert），不产生两条', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#btn-quick-task');
    await page.click('#btn-quick-task');
    await page.fill('#mf-title', '先定九点');
    await page.fill('#mf-remind_at', '2026-09-23T09:00');
    await page.click('#modal-form button[type=submit]');
    await page.waitForSelector('#modal-mask[hidden]', { state: 'attached' });

    await page.goto(baseUrl + '/#/tasks');
    await page.waitForSelector('[data-task-edit]');
    await page.click('[data-task-edit]');
    await page.waitForSelector('#modal-mask:not([hidden])', { timeout: 4000 });
    await page.fill('#mf-remind_at', '2026-09-24T10:00');
    await page.click('#modal-form button[type=submit]');
    await page.waitForSelector('#modal-mask[hidden]', { state: 'attached' });

    const list = await (await api('GET', '/api/reminders')).json;
    assert.equal(list.length, 1, '同一事项只有一条活跃提醒');
    assert.equal(list[0].remind_at, '2026-09-24T02:00:00.000Z', '提醒时间更新为最新值（上海 10:00 → UTC）');

    b.assertNoPageErrors('upsert');
  } finally {
    await b.close();
  }
});

test('轮询不重置用户正在编辑的表单', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await createTaskWithReminder(api, {});
    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#btn-quick-task');
    await page.click('#btn-quick-task');
    await page.fill('#mf-title', '编辑中不要打断');

    await poll(page);
    assert.equal(await page.isHidden('#modal-mask'), false, '弹窗保持打开');
    assert.equal(await page.inputValue('#mf-title'), '编辑中不要打断', '输入内容保留');
    await page.click('#modal-form button[type=submit]');
    await page.waitForSelector('#modal-mask[hidden]', { state: 'attached' });
    assert.equal((await api('GET', '/api/tasks')).json.length, 2, '表单正常提交，未被轮询破坏');

    b.assertNoPageErrors('轮询与编辑');
  } finally {
    await b.close();
  }
});

test('日程提醒：日程表单可设提醒，面板显示日程来源', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await page.goto(baseUrl + '/#/tasks');
    await page.waitForSelector('#form-add-event');
    await page.fill('#form-add-event [name=title]', '明天面试');
    await page.fill('#form-add-event [name=remind_at]', '2026-09-23T08:00');
    await page.click('#form-add-event button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('日程已添加'));

    await page.click('#btn-reminders');
    await page.waitForSelector('#reminders-panel.open');
    const panel = await page.textContent('#reminders-panel');
    assert.match(panel, /明天面试/);
    assert.match(panel, /日程/);

    b.assertNoPageErrors('日程提醒');
  } finally {
    await b.close();
  }
});

test('通知授权拒绝：不破坏提醒中心，按钮如实说明', async () => {
  const b = await open();
  try {
    const { page, api, baseUrl } = b;
    await createTaskWithReminder(api, {});
    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#btn-reminders');

    // 默认未授权（无 grantPermissions）→ 点击启用通知后如实提示，不弹权限之外的动作
    await page.click('#btn-reminders');
    await page.waitForSelector('#reminders-panel.open');
    await page.click('#btn-reminders-notify');
    await page.waitForFunction(() => /未授权|未启用|不支持/.test(document.querySelector('#btn-reminders-notify').textContent));
    // 中心仍可用：列表正常渲染
    const panel = await page.textContent('#reminders-panel');
    assert.match(panel, /提醒事项/);
    assert.equal(await page.evaluate(() => window.__msNotified || 0), 0, '未授权不发系统通知');

    b.assertNoPageErrors('通知拒绝路径');
  } finally {
    await b.close();
  }
});
