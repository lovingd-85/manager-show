/* Manager Show 站内提醒中心（6C）：
   铃铛入口 + 未读角标 + 面板；加载时/每 30s 前台轮询/可见性恢复立即轮询。
   v1 边界：仅站内提醒，关闭网页时不会主动推送（系统通知是用户点击「启用通知」后的可选增强，
   拒绝授权不影响提醒中心）。轮询只更新面板与角标，绝不触碰 #view，不会重置用户正在编辑的表单。
   与 app.js 协作：暴露 window.remindersHub 供任务/日程表单保存提醒；复用全局 toast/esc（app.js）。 */
'use strict';

(function () {
  const POLL_MS = 30 * 1000;
  let list = [];               // 最近一次成功的提醒列表（unread 优先 + scheduled）
  let seenUnread = new Set();  // 已触发过系统通知的 unread 提醒 id（不重复通知）
  let polling = false;
  let pollTimer = null;

  const $ = (sel, el = document) => el.querySelector(sel);

  // 与 app.js api() 相同的 401 语义：未登录 → 清除状态并跳转登录，停止轮询
  async function request(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      stopPolling();
      location.href = '/login';
      throw new Error('未登录');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error) || `请求失败（${res.status}）`);
    return res.status === 204 ? null : json;
  }

  // ---------- 中国时区时间转换（datetime-local 无时区 → 上海墙上时间 → UTC ISO） ----------
  const cnLocalFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // ISO → datetime-local 值（上海墙上时间），用于表单预填
  function toLocalValue(iso) {
    const parts = cnLocalFmt.formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }
  // datetime-local 值 → UTC ISO（明确 +08:00）；非法返回 null
  function fromLocalValue(s) {
    if (typeof s !== 'string' || !/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.test(s)) return null;
    const ms = Date.parse(s + ':00+08:00');
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  }

  // ---------- 展示格式化（全程 Asia/Shanghai；拼装保证「9月23日 09:00」不受 locale 差异影响） ----------
  const cnPartsFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  function fmtRemindAt(iso) {
    const parts = cnPartsFmt.formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${Number(get('month'))}月${Number(get('day'))}日 ${get('hour')}:${get('minute')}`;
  }

  // ---------- 数据 ----------
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      list = await request('GET', '/api/reminders');
      renderPanel();
    } catch (err) {
      if (err.message === '未登录') return;
      // 后台轮询失败保持现状不打扰；首次无数据时如实显示加载失败
      const listEl = $('#reminders-list');
      if (list.length === 0 && listEl) {
        listEl.innerHTML = `<div class="rem-empty">加载失败：${esc(err.message)}</div>`;
      }
    } finally {
      polling = false;
    }
  }

  async function findActive(entityType, entityKey) {
    const all = await request('GET', '/api/reminders');
    return all.find((r) => r.entity_type === entityType && r.entity_key === entityKey) || null;
  }

  // 表单保存提醒：localValue 为空 → 取消现有活跃提醒；否则创建或更新（upsert，不产生两条）
  async function saveEntityReminder(entityType, entityKey, localValue) {
    const active = await findActive(entityType, entityKey);
    if (!localValue) {
      if (active) await request('PATCH', `/api/reminders/${active.id}`, { status: 'cancelled' });
      await refresh();
      return { ok: true };
    }
    const iso = fromLocalValue(localValue);
    if (!iso) return { ok: false, error: '提醒时间格式不正确' };
    if (active) {
      if (active.remind_at !== iso) {
        await request('PATCH', `/api/reminders/${active.id}`, { remind_at: iso });
      }
    } else {
      await request('POST', '/api/reminders', {
        entity_type: entityType, entity_key: entityKey, remind_at: iso,
      });
    }
    await refresh();
    return { ok: true };
  }

  // 编辑表单预填：当前活跃提醒的上海 datetime-local 值；无则空串
  async function activeReminderFor(entityType, entityKey) {
    const active = await findActive(entityType, entityKey);
    return active ? toLocalValue(active.remind_at) : '';
  }

  // ---------- 面板渲染 ----------
  function entryHtml(r) {
    const unread = r.status === 'unread';
    // 任务可深链到详情；日程页无深链，仅导航到日程所在页面
    const href = r.entity_type === 'task' && r.entity_id != null
      ? `#/tasks?id=${r.entity_id}` : '#/tasks';
    return `
      <div class="rem-entry ${unread ? 'unread' : ''}">
        <div class="rem-head">
          <span class="rem-title">${esc(r.entity_title || '（事项已删除）')}</span>
          <span class="badge ${unread ? 'b-red' : 'b-gray'}">${unread ? '未读' : '待触发'}</span>
          <span class="badge b-violet">${r.entity_type === 'task' ? '待办' : '日程'}</span>
        </div>
        <div class="rem-meta">⏰ ${esc(fmtRemindAt(r.remind_at))}</div>
        <div class="rem-actions">
          <a class="btn btn-ghost btn-sm" href="${href}" data-rem-view="${r.id}">查看事项</a>
          ${unread ? `<button class="btn btn-ghost btn-sm" data-rem-read="${r.id}">已读</button>` : ''}
          <button class="btn btn-ghost btn-sm" data-rem-cancel="${r.id}">取消</button>
        </div>
      </div>`;
  }

  function renderPanel() {
    const countEl = $('#reminders-count');
    if (!countEl) return;
    const unread = list.filter((r) => r.status === 'unread');
    countEl.hidden = unread.length === 0;
    countEl.textContent = String(unread.length);

    const listEl = $('#reminders-list');
    if (listEl) {
      listEl.innerHTML = list.length === 0
        ? '<div class="rem-empty">暂无提醒</div>'
        : list.map(entryHtml).join('');
    }

    // 可选系统通知：该 unread 首次出现时计一次候选（观察点 __msNotifyCandidates，不重复）；
    // 仅用户已授权时才真正发送（__msNotified）。无头 Chromium 一律拒绝通知权限——授权分支
    // 在真实浏览器环境由用户点击启用后生效，测试覆盖至权限门并断言拒绝不破坏中心。
    for (const r of unread) {
      if (seenUnread.has(r.id)) continue;
      seenUnread.add(r.id);
      window.__msNotifyCandidates = (window.__msNotifyCandidates || 0) + 1;
      if ('Notification' in window && Notification.permission === 'granted') {
        window.__msNotified = (window.__msNotified || 0) + 1;
        try {
          new Notification('Manager Show 提醒', {
            body: `${r.entity_title || '事项'} · ${fmtRemindAt(r.remind_at)}`,
          });
        } catch { /* 通知展示失败不影响站内提醒 */ }
      }
    }
    seenUnread = new Set(unread.map((r) => r.id));
  }

  // ---------- 交互 ----------
  function togglePanel(force) {
    const panel = $('#reminders-panel');
    if (!panel) return;
    const open = force !== undefined ? force : !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) refresh();
  }

  function initPanelActions() {
    const panel = $('#reminders-panel');
    $('#btn-reminders').addEventListener('click', () => togglePanel());
    document.addEventListener('click', (e) => {
      if (e.target.closest('#reminders-panel') || e.target.closest('#btn-reminders')) return;
      panel.classList.remove('open');
    });
    $('#reminders-list').addEventListener('click', async (e) => {
      const viewLink = e.target.closest('[data-rem-view]');
      if (viewLink) { panel.classList.remove('open'); return; }   // hash 链接自行导航
      const readBtn = e.target.closest('[data-rem-read]');
      const cancelBtn = e.target.closest('[data-rem-cancel]');
      if (!readBtn && !cancelBtn) return;
      try {
        if (readBtn) await request('PATCH', `/api/reminders/${readBtn.dataset.remRead}`, { status: 'read' });
        else await request('PATCH', `/api/reminders/${cancelBtn.dataset.remCancel}`, { status: 'cancelled' });
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    // 可选系统通知：点击后如实反馈授权结果；拒绝不影响提醒中心
    $('#btn-reminders-notify').addEventListener('click', async function () {
      if (!('Notification' in window)) {
        this.textContent = '浏览器不支持通知（不影响站内提醒）';
        this.disabled = true;
        return;
      }
      let perm = Notification.permission;
      if (perm === 'default') perm = await Notification.requestPermission();
      this.textContent = perm === 'granted' ? '通知已开启（仅网页打开时）'
        : perm === 'denied' ? '通知未授权（不影响站内提醒）' : '通知未开启（不影响站内提醒）';
      if (perm === 'granted') refresh();   // 授权成功后补一次：后续新未读会即时通知
    });
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function init() {
    initPanelActions();
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
    });
  }

  window.remindersHub = { refresh, saveEntityReminder, activeReminderFor };
  init();
})();
