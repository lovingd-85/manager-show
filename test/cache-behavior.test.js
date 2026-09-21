'use strict';

// 写操作后的缓存失效行为：DELETE 返回 204 也必须精确失效，旧 GET 响应返回后不能复活已删除数据。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../support/browser-harness');

test('删除任务：DELETE 204 后列表立即移除该任务（无需重载）', async () => {
  const b = await launchBrowser();
  try {
    const t = (await b.api('POST', '/api/tasks', { title: '缓存失效测试', category: '生活' })).json;
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector(`.task-row:has-text("缓存失效测试")`);

    b.page.on('dialog', (d) => d.accept());
    await b.page.click(`[data-task-edit="${t.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.click('#mf-delete');
    // 不重载页面：行必须消失（依赖 204 后 invalidateFor）
    await b.page.waitForSelector(`.task-row:has-text("缓存失效测试")`, { state: 'detached', timeout: 5000 });
    assert.equal((await b.api('GET', `/api/tasks/${t.id}`)).status, 404);
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});

test('删除后：迟到的旧 GET 响应不能把已删除任务写回缓存并复活', async () => {
  const b = await launchBrowser();
  try {
    const t = (await b.api('POST', '/api/tasks', { title: '延迟复活测试', category: '生活' })).json;
    await b.page.goto(b.baseUrl + '/#/tasks');
    await b.page.waitForSelector(`.task-row:has-text("延迟复活测试")`);

    // 快照「删除前」的任务列表，之后的首次 GET 延迟 1.5s 后返回这份陈旧数据
    const snapshot = (await b.api('GET', '/api/tasks')).json;
    let delayed = false;
    await b.page.route('**/api/tasks', async (route) => {
      if (route.request().method() === 'GET' && !delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
      } else {
        await route.continue();
      }
    });

    // 让缓存过期，触发「先显示旧缓存 + 后台慢刷新」路径
    await b.page.evaluate(async () => {
      const hit = apiCache.get('/api/tasks');
      if (hit) hit.ts = 0;
      await rerender(renderTasks);
    });

    // 慢 GET 仍在途时删除任务：204 → invalidateFor 应同时清掉缓存与 in-flight 条目
    b.page.on('dialog', (d) => d.accept());
    await b.page.click(`[data-task-edit="${t.id}"]`);
    await b.page.waitForSelector('#modal-mask:not([hidden])');
    await b.page.click('#mf-delete');
    await b.page.waitForSelector(`.task-row:has-text("延迟复活测试")`, { state: 'detached', timeout: 5000 });

    // 等迟到的陈旧响应返回：行不得复活，缓存内容不得包含已删除任务
    await b.page.waitForTimeout(2000);
    assert.equal(await b.page.locator('.task-row:has-text("延迟复活测试")').count(), 0, '陈旧响应不得复活已删除任务');
    const cached = await b.page.evaluate(() => {
      const hit = apiCache.get('/api/tasks');
      return hit ? hit.data.map((x) => x.title) : null;
    });
    assert.ok(Array.isArray(cached), '删除后应重新拉取并缓存新列表');
    assert.ok(!cached.includes('延迟复活测试'), '缓存中不得残留已删除任务');
    b.assertNoPageErrors();
  } finally {
    await b.close();
  }
});
