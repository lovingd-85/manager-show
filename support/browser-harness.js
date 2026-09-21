'use strict';

// 真实浏览器测试辅助：Playwright Chromium + 独立临时数据库。
// launchBrowser({ seed, appOptions, loginPassword }) 返回 { page, api, baseUrl, close, assertNoPageErrors }：
//  - 每次调用使用自己的临时 DB 与 HTTP server（默认 seed:false，测试自行造数）
//  - 登录 Cookie 通过 context.request 走真实 HTTP 登录流程写入浏览器上下文（绝不使用生产 Cookie）
//  - close 按 context → browser → server 顺序清理
//  - pageerror / console.error 被收集，assertNoPageErrors 断言页面无未捕获错误
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { startServer } = require('./server-harness');

async function launchBrowser({ seed = false, appOptions = {}, loginPassword } = {}) {
  const s = await startServer({ seed, appOptions: { cookieSecure: false, ...appOptions } });
  // 每个测试独立浏览器实例：context → browser → server 顺序可完整清理，无跨测试状态
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  try {
    const password = loginPassword ?? 'test-secret';
    const loginRes = await context.request.post(s.baseUrl + '/api/auth/login', {
      data: { password },
    });
    if (!loginRes.ok()) {
      await context.close();
      await browser.close();
      await s.close();
      throw new Error(`浏览器自动登录失败（${loginRes.status()}）`);
    }

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
    });

    async function close() {
      await context.close();
      await browser.close();
      await s.close();
    }

    function assertNoPageErrors(label = '页面') {
      assert.deepEqual(pageErrors, [], `${label}不应有未捕获错误或 console.error`);
    }

    return { page, api: s.api, baseUrl: s.baseUrl, close, assertNoPageErrors };
  } catch (err) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await s.close().catch(() => {});
    throw err;
  }
}

module.exports = { launchBrowser };
