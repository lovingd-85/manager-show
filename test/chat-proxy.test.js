'use strict';

// 7B：同源聊天代理（可隔离测试：真实 HTTP 的 mock Hermes 上游替身，验证代理行为与契约，
// 不依赖真实上游；生产代码只转发用户文本，不直连模型、不生成假回复）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('../support/server-harness');

const UPSTREAM_KEY = 'test-upstream-key';

// mock Hermes Agent API Server：实现 7A 勘察到的会话契约，记录调用并可注入延迟/故障
function startMockHermes({ onChat, onSessions } = {}) {
  const sessions = new Map();
  const calls = { sessions: [], chats: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) {
        return send(401, { error: 'invalid api key' });
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const json = raw ? JSON.parse(raw) : {};
        if (onSessions) { const r = onSessions(json); if (r) return r(send); }
        const id = json.id || 'api_auto';
        calls.sessions.push(json);
        sessions.set(id, { id, title: json.title });
        send(201, { object: 'hermes.session', session: { id, title: json.title } });
      } else if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/chat$/.test(url.pathname)) {
        const json = raw ? JSON.parse(raw) : {};
        calls.chats.push({ id: url.pathname.split('/')[3], body: json });
        const reply = () => send(200, {
          object: 'hermes.session.chat.completion',
          session_id: url.pathname.split('/')[3],
          message: { role: 'assistant', content: `回声：${json.message}` },
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        if (onChat) { const r = onChat(json); if (r && r.delay) return setTimeout(reply, r.delay); if (r && r.fail) return send(r.fail, { error: r.error || '上游失败' }); }
        reply();
      } else if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        send(200, { messages: [
          { role: 'user', content: '你好', timestamp: 1 },
          { role: 'assistant', content: '回声：你好', timestamp: 2 },
          { role: 'tool', content: '内部工具输出不应外传', timestamp: 3 },
        ] });
      } else {
        send(404, { error: 'not found' });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function openWithUpstream(mock, extraAppOptions = {}) {
  const s = await startServer({
    appOptions: { hermesBaseUrl: mock.baseUrl, hermesApiKey: UPSTREAM_KEY, ...extraAppOptions },
  });
  return s;
}

async function createConversation(api, title = '默认会话') {
  return (await api('POST', '/api/chat/conversation', { title })).json;
}

test('未配置上游：创建与发消息均 503，不编造回复', async () => {
  const s = await startServer();   // 无 hermesApiKey
  try {
    const r1 = await s.api('POST', '/api/chat/conversation', { title: 'x' });
    assert.equal(r1.status, 503);
    const r2 = await s.api('POST', '/api/chat/conversation/1/messages', { requestId: 'r1', message: 'hi' });
    assert.equal(r2.status, 503);
  } finally { await s.close(); }
});

test('创建会话：201 本地 id；上游收到独立 Manager Show 会话', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api, '求职周报');
    assert.ok(Number.isInteger(conv.id) && conv.id > 0);
    assert.equal(conv.title, '求职周报');
    assert.equal(mock.calls.sessions.length, 1);
    assert.equal(mock.calls.sessions[0].title, '求职周报');
    assert.equal(mock.calls.sessions[0].source, 'manager-show', '独立 Manager Show 来源会话');
    assert.match(mock.calls.sessions[0].id, /^manager_show_/, '会话 id 带 manager_show 前缀');
  } finally { await mock.close(); await s.close(); }
});

test('发消息：转发文本与 model=hermes-agent，非流式返回回复', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    const res = await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, {
      requestId: 'req-1', message: '帮我总结今天的待办',
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.reply, '回声：帮我总结今天的待办');
    assert.equal(res.json.replayed, false);
    assert.equal(mock.calls.chats.length, 1);
    assert.equal(mock.calls.chats[0].body.message, '帮我总结今天的待办');
    assert.equal(mock.calls.chats[0].body.model, 'hermes-agent', '模型名与计划一致');
  } finally { await mock.close(); await s.close(); }
});

test('幂等：同一 requestId 重放返回同一次结果，不重复触发上游', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    const body = { requestId: 'req-same', message: '只发一次' };
    const first = await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, body);
    const replay = await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, body);
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.reply, first.json.reply);
    assert.equal(replay.json.replayed, true);
    assert.equal(mock.calls.chats.length, 1, '上游 chat 只被调用一次');
  } finally { await mock.close(); await s.close(); }
});

test('上游故障：502 透传错误信息，不假回复、不缓存失败结果', async () => {
  const mock = await startMockHermes({ onChat: () => ({ fail: 500, error: '上游模型不可用' }) });
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    const res = await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { requestId: 'req-fail', message: 'hi' });
    assert.equal(res.status, 502);
    assert.match(res.json.error, /上游模型不可用/);
    assert.equal(res.json.reply, undefined, '不返回任何假回复');
  } finally { await mock.close(); await s.close(); }
});

test('限流：每分钟 10 次，第 11 次 429', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    for (let i = 1; i <= 10; i++) {
      const res = await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { requestId: `req-${i}`, message: `m${i}` });
      assert.equal(res.status, 200, `第 ${i} 次应成功`);
    }
    const eleventh = await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { requestId: 'req-11', message: 'm11' });
    assert.equal(eleventh.status, 429);
    assert.match(eleventh.json.error, /频繁/);
    assert.equal(mock.calls.chats.length, 10, '上游只收到 10 次');
  } finally { await mock.close(); await s.close(); }
});

test('限流：同一时刻仅 1 个进行中请求，第二个 429', async () => {
  const mock = await startMockHermes({ onChat: () => ({ delay: 200 }) });
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    const [a, b] = await Promise.all([
      s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { requestId: 'req-slow', message: '慢' }),
      s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { requestId: 'req-fast', message: '快' }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 429], `应一个成功一个 429，实际 ${a.status}/${b.status}`);
    assert.equal(mock.calls.chats.length, 1, '上游同一时刻只收到 1 次');
  } finally { await mock.close(); await s.close(); }
});

test('读回消息：只返回 user/assistant 文本，工具内部输出不外传', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    const res = await s.api('GET', `/api/chat/conversation/${conv.id}/messages`);
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 2);
    assert.ok(res.json.every((m) => !m.content.includes('内部工具输出')), 'tool 消息被过滤');
    assert.deepEqual(res.json.map((m) => m.role), ['user', 'assistant']);
  } finally { await mock.close(); await s.close(); }
});

test('参数校验与 404：requestId 必填、消息非空、会话不存在', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    const conv = await createConversation(s.api);
    assert.equal((await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { message: '无幂等键' })).status, 400);
    assert.equal((await s.api('POST', `/api/chat/conversation/${conv.id}/messages`, { requestId: 'r', message: '  ' })).status, 400);
    assert.equal((await s.api('POST', '/api/chat/conversation/9999/messages', { requestId: 'r', message: 'hi' })).status, 404);
    assert.equal((await s.api('GET', '/api/chat/conversation/9999/messages')).status, 404);
    assert.equal(mock.calls.chats.length, 0, '校验失败不触碰上游');
  } finally { await mock.close(); await s.close(); }
});

test('会话列表：本地会话可列出（不依赖上游在线）', async () => {
  const mock = await startMockHermes();
  const s = await openWithUpstream(mock);
  try {
    await createConversation(s.api, '会话A');
    await createConversation(s.api, '会话B');
    const list = await s.api('GET', '/api/chat/conversations');
    assert.equal(list.status, 200);
    assert.equal(list.json.length, 2);
    assert.deepEqual(list.json.map((c) => c.title), ['会话B', '会话A']);
  } finally { await mock.close(); await s.close(); }
});
