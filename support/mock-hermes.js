'use strict';

// Mock Hermes Agent API Server（测试替身）：实现 7A 勘察到的会话契约，
// 供聊天代理（7B）与聊天抽屉（7C）的隔离测试使用；记录调用并可注入延迟/故障。
const http = require('node:http');

const UPSTREAM_KEY = 'test-upstream-key';

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
        sessions.set(id, { id, title: json.title, messages: [] });
        send(201, { object: 'hermes.session', session: { id, title: json.title } });
      } else if (req.method === 'POST' && /^\/api\/sessions\/[^/]+\/chat$/.test(url.pathname)) {
        const json = raw ? JSON.parse(raw) : {};
        const id = url.pathname.split('/')[3];
        calls.chats.push({ id, body: json });
        if (sessions.has(id)) {
          sessions.get(id).messages.push({ role: 'user', content: json.message }, { role: 'assistant', content: `回声：${json.message}` });
        }
        const reply = () => send(200, {
          object: 'hermes.session.chat.completion',
          session_id: id,
          message: { role: 'assistant', content: `回声：${json.message}` },
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        if (onChat) {
          const r = onChat(json);
          // 支持「延迟后失败」：fail + delay 先等待（客户端可观察 pending），再返回错误
          if (r && r.fail && r.delay) return setTimeout(() => send(r.fail, { error: r.error || '上游失败' }), r.delay);
          if (r && r.fail) return send(r.fail, { error: r.error || '上游失败' });
          if (r && r.delay) return setTimeout(reply, r.delay);
        }
        reply();
      } else if (req.method === 'GET' && /^\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        const id = url.pathname.split('/')[3];
        const conv = sessions.get(id);
        if (!conv) return send(404, { error: 'session not found' });
        if (conv.messages.length) return send(200, { messages: conv.messages });
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

module.exports = { startMockHermes, UPSTREAM_KEY };
