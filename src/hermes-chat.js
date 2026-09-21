'use strict';

// 7B：Hermes 同源聊天代理的上游客户端封装。
// 只转发用户文本到 Hermes Agent API Server 的会话端点（7A 勘察契约）；不直接调用模型、
// 不生成假回复、不注入工具调用；上游不可用即抛出明确错误由路由转达。
// 凭据（HERMES_API_KEY）只存在于服务端，浏览器不接触。

const DEFAULT_BASE_URL = 'http://127.0.0.1:8642';

function createHermesChat({ baseUrl = DEFAULT_BASE_URL, apiKey, fetchImpl = fetch } = {}) {
  const configured = () => Boolean(apiKey);

  async function callUpstream(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(baseUrl.replace(/\/+$/, '') + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* 上游非 JSON 响应，稍后按状态码报错 */ }
    if (!res.ok) {
      const err = new Error((json && json.error) || `上游返回 ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  // 创建独立 Manager Show 会话（不复用 Hermes 其它会话）
  async function createConversation({ title }) {
    const id = `manager_show_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const res = await callUpstream('/api/sessions', {
      method: 'POST',
      body: { id, title, source: 'manager-show' },
    });
    return res.session.id;
  }

  // 一次同步 agent turn（非流式）：POST /api/sessions/{id}/chat
  async function sendMessage(upstreamSessionId, message) {
    const res = await callUpstream(`/api/sessions/${encodeURIComponent(upstreamSessionId)}/chat`, {
      method: 'POST',
      body: { message, model: 'hermes-agent' },
    });
    return {
      reply: res.message && typeof res.message.content === 'string' ? res.message.content : '',
      usage: res.usage || null,
    };
  }

  // 读回会话消息：只保留 user/assistant 文本，工具内部输出不外传
  async function listMessages(upstreamSessionId) {
    const res = await callUpstream(`/api/sessions/${encodeURIComponent(upstreamSessionId)}/messages`);
    const rows = Array.isArray(res) ? res : (res.messages || []);
    return rows
      .filter((m) => (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string' && m.content)
      .map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp || null }));
  }

  return { configured, createConversation, sendMessage, listMessages };
}

// 进程内限流：1 并发 + 每分钟 N 次（与登录限流同粒度；多进程部署时由各实例独立计数）
function createChatLimiter({ maxPerMinute = 10, maxConcurrent = 1 } = {}) {
  const windowHits = [];
  let inFlight = 0;
  return {
    tryAcquire(now = Date.now()) {
      while (windowHits.length && windowHits[0] <= now - 60_000) windowHits.shift();
      if (windowHits.length >= maxPerMinute) return { ok: false, reason: 'rate' };
      if (inFlight >= maxConcurrent) return { ok: false, reason: 'concurrent' };
      inFlight += 1;
      windowHits.push(now);
      return { ok: true, release: () => { inFlight = Math.max(0, inFlight - 1); } };
    },
  };
}

module.exports = { createHermesChat, createChatLimiter };
