'use strict';

// 7C：聊天抽屉（真实 Playwright + mock Hermes 上游 + 临时 DB）。
// 覆盖：常驻入口位于 #view 之外、空态与创建会话、Enter/Shift+Enter/IME 发送语义、
// Esc 关闭、失败重试（同 requestId 幂等）、重载后会话与历史保持、未配置上游如实提示。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { launchBrowser } = require('../support/browser-harness');
const { startMockHermes, UPSTREAM_KEY } = require('../support/mock-hermes');

function openWithUpstream(mock) {
  return launchBrowser({ appOptions: { hermesBaseUrl: mock.baseUrl, hermesApiKey: UPSTREAM_KEY } });
}

// 打开抽屉并进入对话视图（创建或进入已有会话）
async function enterChat(page, { title = '聊天测试' } = {}) {
  await page.click('#btn-chat');
  await page.waitForSelector('#chat-drawer:not([hidden])');
  if (title) {
    await page.fill('#chat-new-title', title);
    await page.click('#chat-new-btn');
  }
  await page.waitForSelector('#chat-input');
}

test('入口常驻 #view 之外：路由切换后仍存在可点击', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await page.waitForSelector('#btn-chat');
    assert.equal(await page.evaluate(() =>
      !document.querySelector('#view').contains(document.querySelector('#btn-chat'))), true,
      '聊天入口必须在 #view 之外（视图重渲染不丢）');
    assert.equal(await page.evaluate(() =>
      !document.querySelector('#view').contains(document.querySelector('#chat-drawer'))), true,
      '抽屉容器必须在 #view 之外');

    await page.goto(baseUrl + '/#/campus');
    await page.waitForSelector('#campus-q');
    await page.click('#btn-chat');
    await page.waitForSelector('#chat-drawer:not([hidden])', { timeout: 4000 });
    b.assertNoPageErrors('入口常驻');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('创建会话：空态说明 → 新建 → 上游收到独立 Manager Show 会话', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await page.click('#btn-chat');
    await page.waitForSelector('#chat-drawer:not([hidden])');
    assert.match(await page.textContent('#chat-drawer'), /Hermes Agent/, '空态说明连接对象');

    await page.fill('#chat-new-title', '周报会话');
    await page.click('#chat-new-btn');
    await page.waitForSelector('#chat-input');
    assert.match(await page.textContent('#chat-title'), /周报会话/);
    assert.equal(mock.calls.sessions.length, 1);
    assert.equal(mock.calls.sessions[0].source, 'manager-show');
    assert.match(mock.calls.sessions[0].id, /^manager_show_/);
    b.assertNoPageErrors('创建会话');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('发送消息：Enter 发送，用户消息即时出现，回复渲染', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await enterChat(page);

    await page.fill('#chat-input', '总结今天的待办');
    await page.press('#chat-input', 'Enter');
    await page.waitForSelector('.chat-msg.user');
    await page.waitForFunction(() => {
      const el = document.querySelector('#chat-msgs');
      return el && el.textContent.includes('回声：总结今天的待办');
    });
    assert.match(await page.textContent('#chat-msgs'), /总结今天的待办/);
    assert.equal(await page.inputValue('#chat-input'), '', '发送后输入框清空');
    assert.equal(mock.calls.chats.length, 1);
    assert.equal(mock.calls.chats[0].body.model, 'hermes-agent');
    assert.equal(mock.calls.chats[0].body.message, '总结今天的待办');
    b.assertNoPageErrors('发送消息');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('Shift+Enter 换行不发送；输入法组合中 Enter 不发送', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await enterChat(page);

    await page.fill('#chat-input', '第一行');
    await page.press('#chat-input', 'Shift+Enter');
    await page.type('#chat-input', '第二行');
    await page.waitForTimeout(150);
    assert.equal(mock.calls.chats.length, 0, '换行不触发发送');
    assert.equal(await page.inputValue('#chat-input'), '第一行\n第二行');

    // IME 组合期间 Enter 只结束组合，不发送
    await page.evaluate(() => {
      const ta = document.querySelector('#chat-input');
      ta.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.press('#chat-input', 'Enter');
    await page.waitForTimeout(150);
    assert.equal(mock.calls.chats.length, 0, '组合中 Enter 不发送');
    await page.evaluate(() => {
      const ta = document.querySelector('#chat-input');
      ta.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });

    await page.press('#chat-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#chat-msgs').textContent.includes('回声：'));
    assert.equal(mock.calls.chats.length, 1, '组合结束后 Enter 正常发送');
    b.assertNoPageErrors('输入语义');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('Esc 关闭抽屉；重新打开会话保持', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await enterChat(page);

    await page.keyboard.press('Escape');
    await page.waitForSelector('#chat-drawer[hidden]', { state: 'attached' });

    await page.click('#btn-chat');
    await page.waitForSelector('#chat-drawer:not([hidden])');
    assert.match(await page.textContent('#chat-drawer'), /聊天测试/, '重新打开后会话列表保持');
    b.assertNoPageErrors('Esc 关闭');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('发送中显示思考中；上游失败显示错误与重试，重试成功后恢复', async () => {
  let shouldFail = true;
  // 慢负载（全量并发）下 Playwright 捕获「思考中」需要更宽的时序窗口
  const mock = await startMockHermes({ onChat: () => (shouldFail ? { delay: 2500, fail: 500, error: '上游模型繁忙' } : { delay: 100 }) });
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await enterChat(page);

    await page.fill('#chat-input', '会被拒绝');
    await page.press('#chat-input', 'Enter');
    await page.waitForSelector('.chat-msg.pending', { timeout: 8000 });
    assert.match(await page.textContent('#chat-msgs'), /思考中|回复中/);

    await page.waitForSelector('[data-retry]', { timeout: 8000 });
    assert.match(await page.textContent('#chat-msgs'), /上游模型繁忙/);
    assert.equal(await page.inputValue('#chat-input'), '', '失败后输入框清空（消息已上屏）');

    // 上游恢复后重试：同 requestId 幂等，不重复触发
    shouldFail = false;
    await page.click('[data-retry]');
    await page.waitForFunction(() => document.querySelector('#chat-msgs').textContent.includes('回声：会被拒绝'));
    assert.equal(mock.calls.chats.length, 2, '失败一次 + 重试一次（同一 requestId）');
    assert.ok(mock.calls.chats.every((c) => !('requestId' in c.body)),
      'requestId 是本地幂等键，不应外传上游');
    b.assertNoPageErrors('失败与重试');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('重载后会话与历史保持：列表仍可进入，历史从上游读回', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    await enterChat(page, { title: '长期会话' });
    await page.fill('#chat-input', '第一条');
    await page.press('#chat-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#chat-msgs').textContent.includes('回声：第一条'));

    await page.reload();
    await page.waitForSelector('#btn-chat');
    await page.click('#btn-chat');
    await page.waitForSelector('#chat-drawer:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#chat-drawer').textContent.includes('长期会话'),
      undefined, { timeout: 6000 });   // 会话列表为异步加载，先等内容落地再断言
    assert.match(await page.textContent('#chat-drawer'), /长期会话/, '本地会话列表持久化');
    await page.click('.chat-conv');
    await page.waitForSelector('#chat-input');
    await page.waitForFunction(() => document.querySelector('#chat-msgs').textContent.includes('回声：第一条'),
      undefined, { timeout: 4000 });
    b.assertNoPageErrors('重载保持');
  } finally {
    await mock.close();
    await b.close();
  }
});

test('未配置上游：聊天入口隐藏（不留死按钮），接口仍如实拒绝且不建会话', async () => {
  const b = await launchBrowser();   // 无 hermesApiKey
  try {
    const { page, api, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    const status = await page.waitForResponse((r) => r.url().includes('/api/chat/status'), { timeout: 10000 });
    assert.deepEqual(await status.json(), { configured: false }, '状态接口应如实返回未配置');
    await page.waitForFunction(() => document.querySelector('#btn-chat').hidden === true, undefined, { timeout: 4000 });
    assert.equal(await page.isVisible('#btn-chat'), false, '未配置上游时不应显示聊天入口');

    // 接口层仍必须如实拒绝（不能因为按钮藏起来就假装可用）
    const res = await api('POST', '/api/chat/conversation', { title: '不会成功' });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /未配置/);
    assert.equal((await api('GET', '/api/chat/conversations')).json.length, 0, '未配置时不产生本地会话');
    b.assertNoPageErrors('未配置上游');
  } finally {
    await b.close();
  }
});

test('已配置上游：聊天入口可见可点击', async () => {
  const mock = await startMockHermes();
  const b = await openWithUpstream(mock);
  try {
    const { page, baseUrl } = b;
    await page.goto(baseUrl + '/#/today');
    const status = await page.waitForResponse((r) => r.url().includes('/api/chat/status'), { timeout: 10000 });
    assert.deepEqual(await status.json(), { configured: true }, '状态接口应如实返回已配置');
    await page.waitForFunction(() => document.querySelector('#btn-chat').hidden === false, undefined, { timeout: 4000 });
    assert.equal(await page.isVisible('#btn-chat'), true, '配置上游后应显示聊天入口');
    b.assertNoPageErrors('已配置上游');
  } finally {
    await mock.close();
    await b.close();
  }
});
