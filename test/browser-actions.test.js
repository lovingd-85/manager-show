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
