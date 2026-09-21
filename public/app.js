/* Manager Show 前端 SPA：无框架、无外部依赖，hash 路由 + fetch API */
'use strict';

/* ---------- 基础工具 ---------- */
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtCN(dateStr) {
  if (!dateStr) return '';
  const [, m, d] = dateStr.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function overdueDays(dateStr) {
  const today = todayStr();
  if (!dateStr || dateStr >= today) return 0;
  return Math.round((new Date(today + 'T00:00:00') - new Date(dateStr + 'T00:00:00')) / 86400000);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error) || `请求失败（${res.status}）`);
  invalidateFor(method, path);   // 写操作成功后精确失效相关 GET 缓存，杜绝陈旧数据
  return json;
}

/* ---------- 四个 GET 数据源的内存缓存 ----------
   apiCache：url → { data, ts }；inflight：url → Promise（并发去重）。
   路由先显示缓存（命中即秒开），超过 CACHE_TTL 后先显示缓存再后台刷新；
   写操作（POST/PATCH/DELETE/seed）成功后由 invalidateFor 精确失效。 */
const apiCache = new Map();
const inflight = new Map();
const CACHE_TTL = 30 * 1000;    // 30 秒内视为新鲜

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('未登录');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && json.error) || `请求失败（${res.status}）`);
  return json;
}

async function apiGet(url) {
  const hit = apiCache.get(url);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  // 过期缓存：先返回旧数据，后台刷新（失败静默，旧缓存继续可用）
  if (hit) {
    if (!inflight.has(url)) {
      const p = fetchJson(url)
        .then((data) => {
          if (inflight.get(url) === p) { apiCache.set(url, { data, ts: Date.now() }); inflight.delete(url); }
          return data;
        })
        .catch((err) => { if (inflight.get(url) === p) inflight.delete(url); throw err; });
      inflight.set(url, p);
      p.catch(() => {});
    }
    return hit.data;
  }

  // 无缓存：并发去重 —— 同一 URL 共享同一次请求
  if (inflight.has(url)) return inflight.get(url);
  const p = fetchJson(url)
    .then((data) => {
      if (inflight.get(url) === p) { apiCache.set(url, { data, ts: Date.now() }); inflight.delete(url); }
      return data;
    })
    .catch((err) => { if (inflight.get(url) === p) inflight.delete(url); throw err; });
  inflight.set(url, p);
  return p;
}

/* 写操作成功后精确失效相关缓存（不能展示陈旧任务或投递数据） */
function invalidateFor(method, path) {
  if (method === 'GET') return;
  const base = path.split('?')[0];
  const drop = (prefix) => {
    for (const k of [...apiCache.keys()]) if (k.startsWith(prefix)) apiCache.delete(k);
    for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
  };
  if (base.startsWith('/api/tasks')) { drop('/api/tasks'); drop('/api/dashboard'); return; }
  if (base.startsWith('/api/events')) { drop('/api/events'); drop('/api/dashboard'); return; }
  if (base.startsWith('/api/applications')) { drop('/api/applications'); drop('/api/dashboard'); return; }
  if (base.startsWith('/api/achievements')) { drop('/api/achievements'); drop('/api/dashboard'); return; }
  if (base === '/api/seed/reset') { drop('/api/'); return; }
}

/* ---------- 导航动效 ---------- */
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let navViaKeyboard = false;   // 键盘激活导航链接 → 跳过过渡，即时切换

function waitAnimEnd(el, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener('animationend', onEnd);
      clearTimeout(timer);
      resolve();
    };
    const onEnd = (e) => { if (e.target === el) done(); };
    const timer = setTimeout(done, timeoutMs);
    el.addEventListener('animationend', onEnd);
  });
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- 常量 ---------- */
const APP_STATUSES = ['待投递', '已投递', '笔试', '面试', '流程完成', 'Offer', '已拒绝', '已结束'];
const STATUS_BADGE = {
  '待投递': 'b-gray', '已投递': 'b-blue', '笔试': 'b-violet', '面试': 'b-accent',
  '流程完成': 'b-green', 'Offer': 'b-gold', '已拒绝': 'b-red', '已结束': 'b-gray',
};
const PRIORITY_BADGE = { '高': 'b-red', '中': 'b-amber', '低': 'b-gray' };
const TASK_CATEGORIES = ['求职', '实习', '学习', '生活', '其他'];
const ACH_CATEGORIES = ['项目', '学习', '协作', '成长', '其他'];
const ACH_BADGE = { '项目': 'b-accent', '学习': 'b-blue', '协作': 'b-green', '成长': 'b-gold', '其他': 'b-gray' };

/* ---------- 弹窗表单 ---------- */
// field: { name, label, type: text|date|time|select|textarea, options?, required?, placeholder?, full? }
function openModal({ title, fields, values = {}, submitText = '保存', onSubmit, onDelete }) {
  const mask = $('#modal-mask');
  $('#modal-title').textContent = title;
  const form = $('#modal-form');
  form.innerHTML = `
    <div class="form-grid">
      ${fields.map((f) => `
        <div class="field ${f.full || f.type === 'textarea' ? 'full' : ''}">
          <label for="mf-${f.name}">${esc(f.label)}${f.required ? ' *' : ''}</label>
          ${f.type === 'select'
            ? `<select id="mf-${f.name}" name="${f.name}">
                 ${f.options.map((o) => `<option value="${esc(o)}" ${values[f.name] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
               </select>`
            : f.type === 'textarea'
              ? `<textarea id="mf-${f.name}" name="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(values[f.name] || '')}</textarea>`
              : `<input id="mf-${f.name}" name="${f.name}" type="${f.type || 'text'}"
                   value="${esc(values[f.name] || '')}" placeholder="${esc(f.placeholder || '')}" />`}
        </div>`).join('')}
    </div>
    <div class="form-foot">
      ${onDelete ? '<button type="button" class="btn btn-danger left" id="mf-delete">删除</button>' : ''}
      <button type="button" class="btn" id="mf-cancel">取消</button>
      <button type="submit" class="btn btn-primary">${esc(submitText)}</button>
    </div>`;
  mask.hidden = false;

  const close = () => {
    mask.hidden = true;
    form.onsubmit = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('#modal-close').onclick = close;
  $('#mf-cancel').onclick = close;
  mask.onclick = (e) => { if (e.target === mask) close(); };
  const first = form.querySelector('input:not([type="hidden"]), select, textarea');
  if (first) first.focus();

  if (onDelete) {
    $('#mf-delete').onclick = async () => {
      if (!confirm('确定删除这条记录吗？')) return;
      try { await onDelete(); close(); } catch (err) { toast(err.message, true); }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (el) data[f.name] = el.value.trim();
    }
    try {
      await onSubmit(data);
      close();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/* ---------- 视图：今日首页 ---------- */
async function renderToday() {
  const d = await apiGet('/api/dashboard?date=' + todayStr());
  const statDefs = [
    ['投递总数', d.stats.applications, '▤', 'k1'], ['笔试/面试中', d.stats.interviewing, '◉', 'k2'],
    ['Offer', d.stats.offers, '✦', 'k3'], ['待办任务', d.stats.tasksOpen, '✓', 'k4'], ['成果记录', d.stats.achievements, '★', 'k5'],
  ];

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="stats-strip">
      ${statDefs.map(([label, n, ico, k]) => `
        <div class="card stat ${k}">
          <div class="stat-num">${n}</div>
          <div class="stat-label">${label}</div>
          <span class="stat-ico" aria-hidden="true">${ico}</span>
          <span class="stat-glow" aria-hidden="true"></span>
        </div>`).join('')}
    </div>
    <div class="dash-grid">
      <div class="dash-col">
        <section class="card panel">
          <h3 class="section-title">◉ 今日重点 <span class="count">${d.focus.length} 项</span></h3>
          ${d.focus.length === 0 ? '<div class="empty"><span class="empty-glyph">◌</span><p>还没有今日重点，去「任务日程」把任务标记为今日重点吧</p></div>' : ''}
          ${d.focus.slice(0, 3).map((t, i) => focusItem(t, i)).join('')}
          ${d.focus.length > 3 ? `<div class="empty">另有 ${d.focus.length - 3} 项重点，见任务页</div>` : ''}
        </section>
        <section class="card panel">
          <h3 class="section-title">▸ 今日待办 <span class="count">${d.todayTasks.length} 项</span></h3>
          ${d.todayTasks.length === 0 ? '<div class="empty"><span class="empty-glyph">✓</span><p>今天没有截止的任务</p></div>' : ''}
          ${d.todayTasks.map((t) => `
            <div class="focus-item">
              <input type="checkbox" class="check" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''}/>
              <div><div class="focus-title">${esc(t.title)}</div>
              <div class="focus-meta">${esc(t.category)}</div></div>
            </div>`).join('')}
        </section>
      </div>
      <div class="dash-col">
        <section class="card panel">
          <h3 class="section-title">⚠ 逾期与风险 <span class="count">${d.overdueTasks.length + d.riskApplications.length} 项</span></h3>
          ${d.overdueTasks.length + d.riskApplications.length === 0 ? '<div class="empty"><span class="empty-glyph">✓</span><p>一切正常，没有逾期与风险 🎉</p></div>' : ''}
          ${d.overdueTasks.map((t) => `
            <div class="risk-item">
              <div class="risk-head"><span class="badge b-red">任务逾期</span>
                <span class="risk-title">${esc(t.title)}</span>
                <span class="risk-days">已逾期 ${overdueDays(t.due_date)} 天</span></div>
              <div class="risk-meta">截止 ${fmtCN(t.due_date)} · ${esc(t.category)}</div>
            </div>`).join('')}
          ${d.riskApplications.map((a) => `
            <div class="risk-item">
              <div class="risk-head"><span class="badge b-amber">投递风险</span>
                <span class="risk-title">${esc(a.company)} · ${esc(a.position)}</span>
                <span class="risk-days">超期 ${overdueDays(a.next_step_date)} 天</span></div>
              <div class="risk-meta">下一步「${esc(a.next_step)}」原定 ${fmtCN(a.next_step_date)}，请尽快跟进</div>
            </div>`).join('')}
        </section>
      </div>
      <div class="dash-col">
        <section class="card panel">
          <h3 class="section-title">▸ 近期日程 <span class="count">未来 7 天</span></h3>
          ${d.upcomingEvents.length === 0 ? '<div class="empty"><span class="empty-glyph">▦</span><p>未来 7 天没有日程</p></div>' : ''}
          ${d.upcomingEvents.map((e) => eventItem(e)).join('')}
        </section>
      </div>
    </div>`;

  bindTaskToggles(box, () => rerender(renderToday));
  return box;
}

function focusItem(t, i) {
  return `
    <div class="focus-item ${t.done ? 'done' : ''}">
      <span class="focus-rank">${i + 1}</span>
      <input type="checkbox" class="check" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''}/>
      <div>
        <div class="focus-title">${esc(t.title)}</div>
        <div class="focus-meta">${esc(t.category)}${t.due_date ? ' · 截止 ' + fmtCN(t.due_date) : ''}</div>
      </div>
    </div>`;
}

function eventItem(e) {
  const isToday = e.date === todayStr();
  const [, m, day] = e.date.split('-');
  return `
    <div class="event-item ${isToday ? 'today' : ''}">
      <div class="event-date"><div class="m">${Number(m)}月</div><div class="d">${Number(day)}</div></div>
      <div>
        <div class="event-title">${esc(e.title)}${isToday ? ' <span class="badge b-accent">今天</span>' : ''}</div>
        <div class="event-meta">${[e.start_time && e.end_time ? `${e.start_time}–${e.end_time}` : e.start_time, e.location].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </div>`;
}

function bindTaskToggles(root, refresh) {
  root.querySelectorAll('[data-task-toggle]').forEach((el) => {
    el.addEventListener('change', async () => {
      try {
        await api('PATCH', `/api/tasks/${el.dataset.taskToggle}`, { done: el.checked });
        toast(el.checked ? '已完成，干得漂亮！' : '已标记为未完成');
        await refresh();
      } catch (err) { toast(err.message, true); el.checked = !el.checked; }
    });
  });
}

/* ---------- 视图：校招投递 ---------- */
const campusState = { status: '', q: '' };

async function renderCampus() {
  const params = new URLSearchParams();
  if (campusState.status) params.set('status', campusState.status);
  if (campusState.q) params.set('q', campusState.q);
  const apps = await apiGet('/api/applications?' + params.toString());

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="toolbar">
      <input type="search" id="campus-q" placeholder="搜索公司 / 岗位…" value="${esc(campusState.q)}" />
      <div class="chip-row">
        <button class="chip ${campusState.status === '' ? 'active' : ''}" data-status="">全部</button>
        ${APP_STATUSES.map((s) => `<button class="chip ${campusState.status === s ? 'active' : ''}" data-status="${s}">${s}</button>`).join('')}
      </div>
      <button class="btn btn-primary" id="btn-add-app" style="margin-left:auto">＋ 新增投递</button>
    </div>
    <div class="board">
      ${APP_STATUSES.map((s) => {
        const list = apps.filter((a) => a.status === s);
        return `
          <div class="lane" data-status="${s}">
            <div class="lane-head"><span class="lane-dot" aria-hidden="true"></span><span class="badge ${STATUS_BADGE[s]}">${s}</span>
              <span class="lane-count">${list.length}</span></div>
            <div class="lane-cards">
              ${list.length === 0 ? '<div class="lane-empty">暂无记录</div>' : ''}
              ${list.map(appCard).join('')}
            </div>
          </div>`;
      }).join('')}
    </div>`;

  $('#campus-q', box).addEventListener('input', debounce((e) => {
    campusState.q = e.target.value;
    rerender(renderCampus);
  }, 350));
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    campusState.status = c.dataset.status;
    rerender(renderCampus);
  }));
  $('#btn-add-app', box).addEventListener('click', () => openAppModal(null));
  box.querySelectorAll('[data-app-id]').forEach((card) => card.addEventListener('click', () => {
    const a = apps.find((x) => x.id === Number(card.dataset.appId));
    if (a) openAppModal(a);
  }));
  return box;
}

function appCard(a) {
  const od = overdueDays(a.next_step_date);
  const risky = od > 0 && !['流程完成', 'Offer', '已拒绝', '已结束'].includes(a.status);
  return `
    <div class="card hoverable app-card" data-app-id="${a.id}">
      <div class="company">${esc(a.company)}</div>
      <div class="position">${esc(a.position)}</div>
      <div class="tags">
        <span class="badge ${PRIORITY_BADGE[a.priority] || 'b-gray'}">${esc(a.priority)}优先级</span>
        ${a.city ? `<span class="badge b-gray">${esc(a.city)}</span>` : ''}
        ${a.applied_at ? `<span class="badge b-gray">投递于 ${fmtCN(a.applied_at)}</span>` : ''}
      </div>
      ${a.next_step ? `
        <div class="next ${risky ? 'overdue' : ''}">
          <span>▸ ${esc(a.next_step)}</span>
          ${a.next_step_date ? `<span class="date">${fmtCN(a.next_step_date)}${risky ? ` 超期${od}天` : ''}</span>` : ''}
        </div>` : ''}
    </div>`;
}

function openAppModal(a) {
  openModal({
    title: a ? `编辑投递 · ${a.company}` : '新增投递',
    fields: [
      { name: 'company', label: '公司', required: true, placeholder: '如：阿里巴巴' },
      { name: 'position', label: '岗位', required: true, placeholder: '如：前端开发工程师' },
      { name: 'status', label: '状态', type: 'select', options: APP_STATUSES },
      { name: 'priority', label: '优先级', type: 'select', options: ['高', '中', '低'] },
      { name: 'city', label: '城市', placeholder: '如：杭州' },
      { name: 'applied_at', label: '投递日期', type: 'date' },
      { name: 'next_step', label: '下一步', placeholder: '如：等待二面通知' },
      { name: 'next_step_date', label: '下一步日期', type: 'date' },
      { name: 'url', label: '投递链接', placeholder: 'https://…', full: true },
      { name: 'notes', label: '备注', type: 'textarea', placeholder: '面经、内推人、进度备注…' },
    ],
    values: a || { status: '已投递', priority: '中', applied_at: todayStr() },
    onSubmit: async (data) => {
      if (a) {
        await api('PATCH', `/api/applications/${a.id}`, data);
        toast('投递记录已更新');
      } else {
        await api('POST', '/api/applications', data);
        toast('已新增投递');
      }
      rerender(renderCampus);
    },
    onDelete: a ? async () => {
      await api('DELETE', `/api/applications/${a.id}`);
      toast('已删除');
      rerender(renderCampus);
    } : null,
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- 视图：任务日程 ---------- */
async function renderTasks() {
  const today = todayStr();
  const [tasks, events] = await Promise.all([
    apiGet('/api/tasks'),
    apiGet('/api/events?from=' + addDaysStr(today, -7) + '&to=' + addDaysStr(today, 30)),
  ]);

  const groups = [
    ['已逾期', tasks.filter((t) => !t.done && t.due_date && t.due_date < today), 'b-red'],
    ['今天截止', tasks.filter((t) => !t.done && t.due_date === today), 'b-accent'],
    ['即将截止', tasks.filter((t) => !t.done && t.due_date && t.due_date > today), 'b-blue'],
    ['无截止日期', tasks.filter((t) => !t.done && !t.due_date), 'b-gray'],
    ['已完成', tasks.filter((t) => t.done), 'b-green'],
  ];

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="two-col">
      <section class="card panel">
        <h3 class="section-title">✓ 任务清单 <span class="count">${tasks.filter((t) => !t.done).length} 项待办</span></h3>
        <form class="inline-form" id="form-add-task">
          <input class="grow" name="title" placeholder="新任务标题…" required />
          <input name="due_date" type="date" />
          <select name="category">${TASK_CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select>
          <button class="btn btn-primary" type="submit">添加</button>
        </form>
        <label style="font-size:12px;color:var(--ink-3);display:flex;gap:6px;align-items:center;margin:6px 2px 0">
          <input type="checkbox" id="add-task-focus" /> 同时标记为今日重点
        </label>
        ${groups.map(([name, list, badge]) => list.length === 0 ? '' : `
          <div class="task-group">
            <div class="task-group-title"><span class="badge ${badge}">${name}</span>${list.length} 项</div>
            ${list.map((t) => taskRow(t, today)).join('')}
          </div>`).join('')}
      </section>
      <section class="card panel">
        <h3 class="section-title">▦ 日程 <span class="count">近一周起 30 天</span></h3>
        <form class="inline-form" id="form-add-event">
          <input class="grow" name="title" placeholder="新日程…" required />
          <input name="date" type="date" required value="${today}" />
          <input name="start_time" type="time" />
          <button class="btn btn-primary" type="submit">添加</button>
        </form>
        ${events.length === 0 ? '<div class="empty"><span class="empty-glyph">▦</span><p>这段时间没有日程</p></div>' : ''}
        ${events.map((e) => `
          <div class="event-item ${e.date === today ? 'today' : ''}">
            <div class="event-date"><div class="m">${Number(e.date.split('-')[1])}月</div><div class="d">${Number(e.date.split('-')[2])}</div></div>
            <div style="flex:1;min-width:0">
              <div class="event-title">${esc(e.title)}</div>
              <div class="event-meta">${[e.start_time && e.end_time ? `${e.start_time}–${e.end_time}` : e.start_time, e.location].filter(Boolean).map(esc).join(' · ')}</div>
            </div>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" data-event-edit="${e.id}">编辑</button>
            </div>
          </div>`).join('')}
      </section>
    </div>`;

  $('#form-add-task', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/tasks', {
        title: f.title.value.trim(),
        due_date: f.due_date.value,
        category: f.category.value,
        focus_date: $('#add-task-focus', box).checked ? today : '',
      });
      toast('任务已添加');
      rerender(renderTasks);
    } catch (err) { toast(err.message, true); }
  });

  $('#form-add-event', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/events', {
        title: f.title.value.trim(), date: f.date.value, start_time: f.start_time.value,
      });
      toast('日程已添加');
      rerender(renderTasks);
    } catch (err) { toast(err.message, true); }
  });

  bindTaskToggles(box, () => rerender(renderTasks));
  box.querySelectorAll('[data-task-edit]').forEach((b) => b.addEventListener('click', () => {
    const t = tasks.find((x) => x.id === Number(b.dataset.taskEdit));
    if (t) openTaskModal(t);
  }));
  box.querySelectorAll('[data-event-edit]').forEach((b) => b.addEventListener('click', () => {
    const ev = events.find((x) => x.id === Number(b.dataset.eventEdit));
    if (ev) openEventModal(ev);
  }));
  return box;
}

function taskRow(t, today) {
  const od = !t.done && t.due_date && t.due_date < today;
  return `
    <div class="task-row ${t.done ? 'done' : ''}">
      <input type="checkbox" class="check" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''} />
      <div class="body">
        <div class="title">${esc(t.title)}${t.focus_date === today ? ' <span class="badge b-accent">今日重点</span>' : ''}</div>
        <div class="meta">
          <span>${esc(t.category)}</span>
          ${t.due_date ? `<span class="${od ? 'overdue' : ''}">截止 ${fmtCN(t.due_date)}${od ? `（逾期 ${overdueDays(t.due_date)} 天）` : ''}</span>` : ''}
          ${t.done && t.done_at ? `<span>完成于 ${esc(t.done_at.slice(0, 10))}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <button class="btn btn-ghost btn-sm" data-task-edit="${t.id}">编辑</button>
      </div>
    </div>`;
}

function openTaskModal(t) {
  openModal({
    title: '编辑任务',
    fields: [
      { name: 'title', label: '标题', required: true, full: true },
      { name: 'category', label: '分类', type: 'select', options: TASK_CATEGORIES },
      { name: 'due_date', label: '截止日期', type: 'date' },
      { name: 'focus_date', label: '重点日期（设为今日重点则填今天）', type: 'date', full: true },
      { name: 'notes', label: '备注', type: 'textarea' },
    ],
    values: t,
    onSubmit: async (data) => {
      await api('PATCH', `/api/tasks/${t.id}`, data);
      toast('任务已更新');
      rerender(renderTasks);
    },
    onDelete: async () => {
      await api('DELETE', `/api/tasks/${t.id}`);
      toast('任务已删除');
      rerender(renderTasks);
    },
  });
}

function openEventModal(ev) {
  openModal({
    title: '编辑日程',
    fields: [
      { name: 'title', label: '标题', required: true, full: true },
      { name: 'date', label: '日期', type: 'date', required: true },
      { name: 'location', label: '地点' },
      { name: 'start_time', label: '开始时间', type: 'time' },
      { name: 'end_time', label: '结束时间', type: 'time' },
      { name: 'notes', label: '备注', type: 'textarea' },
    ],
    values: ev,
    onSubmit: async (data) => {
      await api('PATCH', `/api/events/${ev.id}`, data);
      toast('日程已更新');
      rerender(renderTasks);
    },
    onDelete: async () => {
      await api('DELETE', `/api/events/${ev.id}`);
      toast('日程已删除');
      rerender(renderTasks);
    },
  });
}

/* ---------- 视图：成果记录 ---------- */
async function renderAchievements() {
  const list = await api('GET', '/api/achievements');
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="toolbar">
      <h3 class="section-title" style="margin:0">★ 实习成果记录 <span class="count">${list.length} 条</span></h3>
      <button class="btn btn-primary" id="btn-add-ach" style="margin-left:auto">＋ 记录成果</button>
    </div>
    ${list.length === 0 ? '<div class="card panel empty"><span class="empty-glyph">★</span><p>还没有成果，记录第一条吧！</p></div>' : ''}
    <div class="timeline">
      ${list.map((a) => `
        <div class="tl-item">
          <div class="card hoverable tl-card">
            <div class="tl-head">
              <span class="tl-date">${esc(a.date)}</span>
              <span class="badge ${ACH_BADGE[a.category] || 'b-gray'}">${esc(a.category)}</span>
              <span class="tl-title">${esc(a.title)}</span>
              <span class="tl-actions">
                <button class="btn btn-ghost btn-sm" data-ach-edit="${a.id}">编辑</button>
              </span>
            </div>
            ${a.impact ? `<div class="tl-impact">▲ ${esc(a.impact)}</div>` : ''}
            ${a.description ? `<div class="tl-desc">${esc(a.description)}</div>` : ''}
          </div>
        </div>`).join('')}
    </div>`;

  $('#btn-add-ach', box).addEventListener('click', () => openAchModal(null));
  box.querySelectorAll('[data-ach-edit]').forEach((b) => b.addEventListener('click', () => {
    const a = list.find((x) => x.id === Number(b.dataset.achEdit));
    if (a) openAchModal(a);
  }));
  return box;
}

function openAchModal(a) {
  openModal({
    title: a ? '编辑成果' : '记录成果',
    fields: [
      { name: 'title', label: '成果标题', required: true, full: true, placeholder: '如：上线数据看板' },
      { name: 'date', label: '日期', type: 'date', required: true },
      { name: 'category', label: '分类', type: 'select', options: ACH_CATEGORIES },
      { name: 'impact', label: '量化影响', full: true, placeholder: '如：渲染耗时降低 40% / 被 3 个团队采用' },
      { name: 'description', label: '描述', type: 'textarea', placeholder: '背景、你的角色、关键动作…' },
    ],
    values: a || { date: todayStr(), category: '项目' },
    onSubmit: async (data) => {
      if (a) {
        await api('PATCH', `/api/achievements/${a.id}`, data);
        toast('成果已更新');
      } else {
        await api('POST', '/api/achievements', data);
        toast('已记录成果，继续加油！');
      }
      rerender(renderAchievements);
    },
    onDelete: a ? async () => {
      await api('DELETE', `/api/achievements/${a.id}`);
      toast('已删除');
      rerender(renderAchievements);
    } : null,
  });
}

/* ---------- 真实 DOM 挂载 ----------
   render 函数返回真实节点（事件监听器随节点保留），错误字符串仍走 esc。
   绝不 cloneNode（克隆会丢监听器），绝不重建背景 Canvas。 */
function mountView(content) {
  if (typeof content === 'string') view.innerHTML = content;
  else view.replaceChildren(content);
}

/* ---------- 数据刷新（非路由切换）：直接替换 #view 内容，不播过渡动画 ---------- */
async function rerender(renderFn) {
  try {
    mountView(await renderFn());
  } catch (err) {
    view.innerHTML = `<div class="card panel empty">加载失败：${esc(err.message)}</div>`;
  }
}

/* ---------- 路由与启动 ---------- */
const ROUTES = {
  today: { title: '今日首页', render: renderToday },
  campus: { title: '校招投递', render: renderCampus },
  tasks: { title: '任务日程', render: renderTasks },
  achievements: { title: '成果记录', render: renderAchievements },
};

let navSeq = 0;
async function route() {
  const key = (location.hash.replace('#/', '') || 'today');
  const r = ROUTES[key] || ROUTES.today;
  const seq = ++navSeq;
  $('#topbar-title').textContent = r.title;
  // 侧边栏与移动端底部导航共用路由表，同步高亮
  document.querySelectorAll('.nav a, .bottom-nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === (ROUTES[key] ? key : 'today'));
  });
  $('#sidebar').classList.remove('open');

  // 键盘导航 / prefers-reduced-motion → 跳过过渡，即时切换
  const instant = reduceMotionQuery.matches || navViaKeyboard;
  navViaKeyboard = false;

  // 离场：当前内容短淡出 + 轻微上移（首屏仅 loading 占位时跳过）；
  // 背景 Canvas 保持单实例常驻、连续动画（不暂停/不降帧，避免恢复时卡顿），
  // 等离场结束后再切换内容，避免重叠。
  let exitDone = Promise.resolve();
  if (!instant && !view.querySelector('.loading')) {
    view.classList.remove('view-entering');
    view.classList.add('view-leaving');
    exitDone = waitAnimEnd(view, 450);
  }

  let html;
  try {
    html = await r.render();   // 缓存命中即秒开；未命中期间旧内容仍在，无闪白
  } catch (err) {
    html = `<div class="card panel empty">加载失败：${esc(err.message)}</div>`;
  }

  if (seq !== navSeq) return;  // 已被更新的导航取代
  await exitDone;
  if (seq !== navSeq) return;

  view.classList.remove('view-leaving');
  mountView(html);
  if (!instant) {
    view.classList.add('view-entering');   // 入场：淡入 + 轻微上移
    waitAnimEnd(view, 400).then(() => {
      if (seq === navSeq && !view.classList.contains('view-leaving')) {
        view.classList.remove('view-entering');
      }
    });
  }
}

function initChrome() {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  const hour = d.getHours();
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  $('#topbar-date').textContent = `${greet} · ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 星期${week}`;
  $('#btn-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#btn-reset-seed').addEventListener('click', async () => {
    if (!confirm('将清空全部数据并恢复示例数据，确定吗？')) return;
    try {
      await api('POST', '/api/seed/reset');
      toast('已恢复示例数据');
      route();
    } catch (err) { toast(err.message, true); }
  });
  $('#btn-logout').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 忽略网络错误 */ }
    location.href = '/login';
  });
  // 键盘激活导航链接 → 标记即时切换（跳过过渡动画，避免焦点与视觉错位）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target;
    if (t && t.closest && t.closest('.nav a, .bottom-nav a')) navViaKeyboard = true;
  });
  window.addEventListener('hashchange', route);
}

initChrome();
route();
