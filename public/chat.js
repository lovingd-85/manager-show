/* Manager Show 聊天抽屉（7C）：常驻右下入口，位于 #view 之外，视图重渲染不丢。
   通过同源受保护代理连接 Hermes Agent（不直连模型、不假回复、不自动注入 DB 内容）。
   Enter 发送 / Shift+Enter 换行 / 输入法组合（IME）期间 Enter 不发送；Esc 关闭。
   回复以纯文本渲染（不执行上游 HTML）；复用全局 toast/esc（app.js）；401 → 跳转登录。 */
'use strict';

(function () {
  const $ = (sel, el = document) => el.querySelector(sel);
  const drawer = $('#chat-drawer');
  const bodyEl = $('#chat-body');
  const footEl = $('#chat-foot');
  const titleEl = $('#chat-title');

  let conversations = [];
  let current = null;      // 当前会话 { id, title }
  let sending = false;
  let composing = false;   // IME 组合中

  async function request(method, path, payload) {
    const res = await fetch(path, {
      method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('未登录');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error) || `请求失败（${res.status}）`);
    return res.status === 204 ? null : json;
  }

  // ---------- 会话列表视图 ----------
  function renderList() {
    titleEl.textContent = 'Hermes 对话';
    $('#chat-back').hidden = true;
    bodyEl.innerHTML = `
      <div class="chat-new">
        <input id="chat-new-title" maxlength="100" placeholder="新会话标题（可选）" aria-label="新会话标题" />
        <button class="btn btn-primary btn-sm" id="chat-new-btn">开始新会话</button>
      </div>
      <div class="chat-conv-list" id="chat-conv-list"></div>`;
    renderConvList();
    footEl.innerHTML = '<div class="chat-hint">通过同源代理连接 Hermes Agent；不会自动读取你的待办与投递数据。</div>';
  }

  function renderConvList() {
    const listEl = $('#chat-conv-list');
    if (!listEl) return;
    listEl.innerHTML = conversations.length === 0
      ? '<div class="chat-empty">尚未创建会话。开始一个对话，由 Hermes Agent 提供回答。</div>'
      : conversations.map((c) => `
          <button class="chat-conv" data-id="${c.id}">
            <span class="chat-conv-title">${esc(c.title)}</span>
            <span class="chat-conv-arrow" aria-hidden="true">›</span>
          </button>`).join('');
  }

  async function loadConversations() {
    try {
      conversations = await request('GET', '/api/chat/conversations');
      renderConvList();
    } catch (err) {
      if (err.message === '未登录') return;
      toast(err.message, true);
    }
  }

  async function createConversation() {
    if (sending) return;
    const input = $('#chat-new-title');
    const title = input.value.trim();
    sending = true;
    try {
      const conv = await request('POST', '/api/chat/conversation', { title });
      conversations.unshift(conv);
      await enterConversation(conv);
    } catch (err) {
      if (err.message === '未登录') return;
      toast(err.message, true);   // 503「聊天服务未配置」等如实提示，停留原视图
      renderConvList();
    } finally {
      sending = false;
    }
  }

  // ---------- 对话视图 ----------
  async function enterConversation(conv) {
    current = conv;
    titleEl.textContent = conv.title || 'Hermes 对话';
    $('#chat-back').hidden = false;
    bodyEl.innerHTML = '<div class="chat-msgs" id="chat-msgs"><div class="chat-empty">加载历史消息…</div></div>';
    footEl.innerHTML = `
      <div class="chat-compose">
        <textarea id="chat-input" rows="2" maxlength="4000" placeholder="输入消息…"></textarea>
        <button class="btn btn-primary" id="chat-send" aria-label="发送">发送</button>
      </div>
      <div class="chat-hint">Enter 发送 · Shift+Enter 换行</div>`;
    bindCompose();
    await loadHistory();
  }

  async function loadHistory() {
    const msgsEl = $('#chat-msgs');
    try {
      const msgs = await request('GET', `/api/chat/conversation/${current.id}/messages`);
      msgsEl.innerHTML = '';
      for (const m of msgs) appendMsg(m.role, m.content);
      if (msgs.length === 0) msgsEl.innerHTML = '<div class="chat-empty">还没有消息，开始对话吧。</div>';
    } catch (err) {
      if (err.message === '未登录') return;
      msgsEl.innerHTML = `<div class="chat-empty">加载失败：${esc(err.message)}</div>`;
    }
    scrollMsgs();
  }

  function appendMsg(role, content) {
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = content;   // 纯文本渲染：上游输出不执行 HTML
    div.appendChild(bubble);
    $('#chat-msgs').appendChild(div);
    scrollMsgs();
    return div;
  }

  function scrollMsgs() {
    const msgsEl = $('#chat-msgs');
    if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ---------- 发送（幂等 requestId：失败重试复用同一键，不重复触发上游） ----------
  async function sendWith(requestId, message) {
    if (!current) return;
    sending = true;
    setComposeBusy(true);
    const pending = appendMsg('assistant', '思考中…');
    pending.classList.add('pending');
    try {
      const res = await request('POST', `/api/chat/conversation/${current.id}/messages`, { requestId, message });
      pending.classList.remove('pending');
      pending.querySelector('.chat-bubble').textContent = res.reply;
    } catch (err) {
      if (err.message === '未登录') return;
      pending.classList.remove('pending');
      pending.classList.add('error');
      pending.querySelector('.chat-bubble').textContent = err.message;
      const retry = document.createElement('button');
      retry.className = 'btn btn-ghost btn-sm chat-retry';
      retry.dataset.retry = '1';
      retry.dataset.requestId = requestId;
      retry.dataset.message = message;
      retry.textContent = '重试';
      pending.appendChild(retry);
    } finally {
      sending = false;
      setComposeBusy(false);
      scrollMsgs();
    }
  }

  function sendCurrent() {
    const input = $('#chat-input');
    const text = input.value.trim();
    if (!text || sending) return;
    appendMsg('user', text);
    input.value = '';
    sendWith(crypto.randomUUID(), text);
  }

  function setComposeBusy(busy) {
    const input = $('#chat-input');
    const btn = $('#chat-send');
    if (input) input.disabled = busy;
    if (btn) btn.disabled = busy;
  }

  function bindCompose() {
    const input = $('#chat-input');
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (composing || e.isComposing) return;   // IME 组合中：Enter 结束组合，不发送
      if (e.shiftKey) return;                   // Shift+Enter 换行
      e.preventDefault();
      sendCurrent();
    });
    $('#chat-send').addEventListener('click', sendCurrent);
  }

  // ---------- 开关与全局交互 ----------
  function open() {
    drawer.hidden = false;
    loadConversations();
  }
  function close() {
    drawer.hidden = true;
  }
  function toggle() {
    if (drawer.hidden) open(); else close();
  }

  $('#btn-chat').addEventListener('click', toggle);
  $('#chat-close').addEventListener('click', close);
  $('#chat-back').addEventListener('click', () => {
    current = null;
    renderList();
  });
  bodyEl.addEventListener('click', (e) => {
    if (e.target.closest('#chat-new-btn')) return createConversation();
    const convBtn = e.target.closest('.chat-conv');
    if (convBtn) {
      const conv = conversations.find((c) => String(c.id) === convBtn.dataset.id);
      if (conv) return enterConversation(conv);
      return;
    }
    const retry = e.target.closest('[data-retry]');
    if (retry) return sendWith(retry.dataset.requestId, retry.dataset.message);
  });

  // Esc 关闭抽屉（捕获阶段：先于 app.js 弹窗的 Esc 处理判断弹窗是否打开，
  // 有打开的弹窗时 Esc 归弹窗，不关抽屉）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || drawer.hidden) return;
    if (!$('#modal-mask').hidden) return;
    close();
  }, true);

  renderList();
})();
