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

// 全程明确 Asia/Shanghai：不依赖浏览器/主机时区
const cnDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
function todayStr(now = new Date()) {
  const parts = cnDateFmt.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error((error && error.error) || `请求失败（${res.status}）`);
  }
  invalidateFor(method, path);   // 写操作成功后精确失效相关 GET 缓存，杜绝陈旧数据（含 204 空响应）
  if (res.status === 204) return null;
  return res.json();
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

  // 过期缓存：先返回旧数据，后台刷新。
  // 刷新成功：仅当仍停留在发起刷新的视图、且用户没有正在编辑的表单时才更新视图；
  // 刷新失败：明确提示「更新失败，可重试」，绝不永远静默显示旧数据。
  if (hit) {
    if (!inflight.has(url)) {
      const p = fetchJson(url)
        .then((data) => {
          if (inflight.get(url) === p) { apiCache.set(url, { data, ts: Date.now() }); inflight.delete(url); }
          return data;
        })
        .catch((err) => { if (inflight.get(url) === p) inflight.delete(url); throw err; });
      inflight.set(url, p);
      const gen = navSeq;
      p.then(() => {
        if (gen === navSeq && !viewBeingEdited()) rerender(currentRender());
      }).catch(() => {
        if (gen === navSeq) toast('更新失败，可重试', true);
      });
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
const TASK_CATEGORIES = ['生活', '工作', '学习', '求职', '实习', '其他'];
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
  const today = d.date || todayStr();
  const openCount = d.openTasks.length;
  const riskCount = d.overdueTasks.length + d.riskApplications.length;

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="quick-add">
      <button class="btn btn-primary" id="btn-quick-task">＋ 新增待办</button>
      <button class="btn btn-ghost" id="btn-quick-app">＋ 新增投递</button>
    </div>
    <div class="dash-grid">
      <div class="dash-col">
        <section class="card panel dash-todo">
          <h3 class="section-title"><a class="link" href="#/tasks?state=open">✓ 全部待办 <span class="count">${openCount} 项</span></a></h3>
          ${openCount === 0 ? '<div class="empty"><span class="empty-glyph">✓</span><p>没有未完成的待办</p></div>' : ''}
          ${d.openTasks.slice(0, 5).map((t) => taskRow(t, today)).join('')}
          ${openCount > 5 ? `<div class="dash-more"><a class="link" href="#/tasks?state=open">查看全部 ${openCount} 项</a></div>` : ''}
        </section>
        <section class="card panel dash-focus">
          <h3 class="section-title">◉ 今日重点 <span class="count">${d.focus.length} 项</span></h3>
          ${d.focus.length === 0 ? `
            <div class="empty">
              <span class="empty-glyph">◌</span><p>还没有今日重点</p>
              <button class="btn btn-primary" id="btn-add-focus-task">＋ 新增待办</button>
            </div>` : ''}
          ${d.focus.slice(0, 3).map((t, i) => focusItem(t, i)).join('')}
          ${d.focus.length > 3 ? `<div class="empty">另有 ${d.focus.length - 3} 项重点，见<a class="link" href="#/tasks?state=open">任务页</a></div>` : ''}
        </section>
      </div>
      <div class="dash-col">
        <section class="card panel">
          <h3 class="section-title">⚠ 提醒 <span class="count">${riskCount} 项</span></h3>
          ${riskCount === 0 ? '<div class="empty"><span class="empty-glyph">✓</span><p>一切正常，没有逾期与风险 🎉</p></div>' : ''}
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
        <section class="card panel">
          <h3 class="section-title">▸ 近期日程 <span class="count">未来 7 天</span></h3>
          ${d.upcomingEvents.length === 0 ? '<div class="empty"><span class="empty-glyph">▦</span><p>未来 7 天没有日程</p></div>' : ''}
          ${d.upcomingEvents.map((e) => eventItem(e)).join('')}
        </section>
      </div>
      <div class="dash-col">
        <section class="card panel">
          <h3 class="section-title">▤ 求职摘要</h3>
          ${jobStatCards(d.stats)}
        </section>
        <section class="card panel dash-interviews">
          <h3 class="section-title">◉ 笔试/面试明细 <span class="count">${d.interviewApplications.length} 项</span></h3>
          ${d.interviewApplications.length === 0 ? '<div class="empty"><span class="empty-glyph">◉</span><p>当前没有进行中的笔试或面试</p></div>' : ''}
          ${d.interviewApplications.map(interviewItem).join('')}
        </section>
      </div>
    </div>`;

  bindTaskToggles(box, () => rerender(renderToday));
  bindTaskCopyButtons(box, d.openTasks);
  $('#btn-quick-task', box).addEventListener('click', () => openTaskModal(null));
  $('#btn-quick-app', box).addEventListener('click', () => openAppModal(null));
  const focusAdd = $('#btn-add-focus-task', box);
  if (focusAdd) focusAdd.addEventListener('click', () => openTaskModal(null));
  box.querySelectorAll('[data-task-edit]').forEach((b) => b.addEventListener('click', () => {
    const t = d.openTasks.find((x) => x.id === Number(b.dataset.taskEdit));
    if (t) openTaskModal(t);
  }));
  return box;
}

// 统计卡是可点击的 <a>：点数字直达可解释的明细页
function jobStatCards(stats) {
  const defs = [
    ['投递总数', stats.applications, '▤', 'k1', '#/campus'],
    ['笔试/面试中', stats.interviewing, '◉', 'k2', '#/campus?stage=interviewing'],
    ['Offer', stats.offers, '✦', 'k3', '#/campus?status=Offer'],
    ['待办任务', stats.tasksOpen, '✓', 'k4', '#/tasks?state=open'],
    ['成果记录', stats.achievements, '★', 'k5', '#/achievements'],
  ];
  return defs.map(([label, n, ico, k, href]) => `
    <a class="card stat ${k}" href="${href}">
      <div class="stat-num">${n}</div>
      <div class="stat-label">${label}</div>
      <span class="stat-ico" aria-hidden="true">${ico}</span>
      <span class="stat-glow" aria-hidden="true"></span>
    </a>`).join('');
}

// 笔试/面试明细条目：点击深链到投递记录；无下一步日期明确「未安排」
function interviewItem(a) {
  const badge = a.status === '面试' ? 'b-blue' : 'b-amber';
  return `
    <a class="interview-item" href="#/campus?id=${a.id}">
      <div class="interview-head">
        <span class="badge ${badge}">${esc(a.status)}</span>
        <span class="interview-company">${esc(a.company)}</span>
        <span class="interview-pos">${esc(a.position)}</span>
      </div>
      <div class="interview-meta">下一步「${esc(a.next_step)}」${a.next_step_date ? ' · ' + fmtCN(a.next_step_date) : ' · 未安排'}</div>
    </a>`;
}

function focusItem(t, i) {
  const synced = t.source && t.source !== 'manual';
  return `
    <div class="focus-item ${t.done ? 'done' : ''}">
      <span class="focus-rank">${i + 1}</span>
      ${synced ? '' : `<input type="checkbox" class="check" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''}/>`}
      <div>
        <div class="focus-title">${esc(t.title)}${synced ? ` <span class="badge b-violet">同步 · ${esc(t.source)}</span>` : ''}</div>
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
const campusState = { q: '' };   // 搜索词保留在本地（不进入 URL）；状态筛选由 URL 驱动

// 按当前 URL 参数构建「新增投递」等工具栏，状态筛选芯片写入 hash（可分享/可前进后退）
function campusToolbar(params, q) {
  const urlStatus = APP_STATUSES.includes(params.get('status')) ? params.get('status') : '';
  const urlStage = params.get('stage') === 'interviewing' ? 'interviewing' : '';
  return `
    <div class="toolbar">
      <input type="search" id="campus-q" placeholder="搜索公司 / 岗位…" value="${esc(q)}" />
      <div class="chip-row">
        <button class="chip ${!urlStatus && !urlStage ? 'active' : ''}" data-status="">全部</button>
        <button class="chip ${urlStage ? 'active' : ''}" data-stage="interviewing">笔试/面试</button>
        ${APP_STATUSES.map((s) => `<button class="chip ${urlStatus === s ? 'active' : ''}" data-status="${s}">${s}</button>`).join('')}
      </div>
      <button class="btn btn-primary" id="btn-add-app" style="margin-left:auto">＋ 新增投递</button>
    </div>`;
}

async function renderCampus(urlParams = new URLSearchParams()) {
  const urlStatus = APP_STATUSES.includes(urlParams.get('status')) ? urlParams.get('status') : '';
  const urlStage = urlParams.get('stage') === 'interviewing' ? 'interviewing' : '';
  const rawId = urlParams.get('id');
  const idNum = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;

  // id 深链：定位单条记录（非法 id 不请求；不存在则说明原因而非空白）
  if (idNum !== null) {
    let a;
    try {
      a = await apiGet('/api/applications/' + idNum);
    } catch (err) {
      if (/不存在/.test(err.message)) {
        return campusNotFound(idNum);
      }
      throw err;
    }
    const box = document.createElement('div');
    box.innerHTML = campusToolbar(urlParams, campusState.q) + `
      <div class="board">
        <div class="lane" data-status="${a.status}">
          <div class="lane-head"><span class="lane-dot" aria-hidden="true"></span><span class="badge ${STATUS_BADGE[a.status]}">${a.status}</span>
            <span class="lane-count">1</span><span class="lane-located">已定位到该记录</span></div>
          <div class="lane-cards">${appCard(a)}</div>
        </div>
      </div>`;
    bindCampusControls(box, urlParams, [a]);
    if (deepLinkId === String(a.id)) openAppModal(a);
    return box;
  }

  // 组合筛选（stage / stage+status）：后端不支持「笔试,面试」组合，从全部记录本地筛选
  const qp = new URLSearchParams();
  if (campusState.q) qp.set('q', campusState.q);
  if (urlStatus && !urlStage) qp.set('status', urlStatus);
  let apps = await apiGet('/api/applications?' + qp.toString());
  let filterLabel = '';
  if (urlStage) {
    apps = apps.filter((a) => a.status === '笔试' || a.status === '面试');
    filterLabel = '笔试/面试';
    if (urlStatus) {
      apps = apps.filter((a) => a.status === urlStatus);
      filterLabel = `笔试/面试 · ${urlStatus}`;
    }
  } else if (urlStatus) {
    filterLabel = urlStatus;
  }

  const box = document.createElement('div');
  if (filterLabel) {
    // 有筛选：只展示筛选结果（不展示其他空列），空结果给出原因与清除筛选
    box.innerHTML = campusToolbar(urlParams, campusState.q) + `
      <div class="filter-bar">
        <span>已筛选：<span class="badge b-violet">${esc(filterLabel)}</span></span>
        <a href="#/campus" class="link" id="clear-filter">清除筛选</a>
      </div>
      ${apps.length === 0 ? `
        <div class="card panel empty filter-empty">
          <span class="empty-glyph">◌</span>
          <p>没有符合「${esc(filterLabel)}」筛选的记录</p>
          <p class="empty-sub">可调整筛选条件，或 <a href="#/campus" class="link">清除筛选</a> 查看全部记录</p>
        </div>` : `
        <div class="board">
          <div class="lane" data-status="filtered">
            <div class="lane-head"><span class="lane-dot" aria-hidden="true"></span><span class="badge b-violet">${esc(filterLabel)}</span>
              <span class="lane-count">${apps.length}</span></div>
            <div class="lane-cards">${apps.map(appCard).join('')}</div>
          </div>
        </div>`}`;
  } else {
    box.innerHTML = campusToolbar(urlParams, campusState.q) + `
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
  }
  bindCampusControls(box, urlParams, apps);
  return box;
}

function campusNotFound(idNum) {
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="card panel empty">
      <span class="empty-glyph">◌</span>
      <p>事项已更新或删除（未找到投递记录 #${esc(idNum)}）</p>
      <p class="empty-sub"><a href="#/campus" class="link">返回全部投递</a></p>
    </div>`;
  return box;
}

function bindCampusControls(box, urlParams, apps) {
  $('#campus-q', box).addEventListener('input', debounce((e) => {
    campusState.q = e.target.value;
    rerender(currentRender());
  }, 350));
  box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    if (c.dataset.stage) {
      navigateWithParams('campus', { stage: 'interviewing', status: '', id: '' });
    } else {
      navigateWithParams('campus', { status: c.dataset.status, stage: '', id: '' });
    }
  }));
  $('#btn-add-app', box).addEventListener('click', () => openAppModal(null));
  box.querySelectorAll('[data-app-id]').forEach((card) => card.addEventListener('click', () => {
    const a = apps.find((x) => x.id === Number(card.dataset.appId));
    if (a) openAppModal(a);
  }));
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
      rerender(currentRender());
    },
    onDelete: a ? async () => {
      await api('DELETE', `/api/applications/${a.id}`);
      toast('已删除');
      rerender(currentRender());
    } : null,
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ---------- 视图：待办与日程 ---------- */
async function renderTasks(urlParams = new URLSearchParams()) {
  const today = todayStr();
  const urlState = ['open', 'done', 'all'].includes(urlParams.get('state')) ? urlParams.get('state') : 'open';
  const rawCategory = urlParams.get('category');
  const urlCategory = TASK_CATEGORIES.includes(rawCategory) ? rawCategory : '';
  const rawId = urlParams.get('id');
  const idNum = rawId && /^\d+$/.test(rawId) ? Number(rawId) : null;

  // id 深链：定位单条记录（非法 id 不请求；不存在则说明原因而非空白）
  if (idNum !== null) {
    let t;
    try {
      t = await apiGet('/api/tasks/' + idNum);
    } catch (err) {
      if (/不存在/.test(err.message)) {
        return taskNotFound(idNum);
      }
      throw err;
    }
    const box = await buildTasksView({ today, tasks: [t], events: [], urlState, urlCategory, locatedTask: t, title: '✓ 已定位事项' });
    if (deepLinkId === String(t.id)) openTaskModal(t);
    return box;
  }

  let tasks = await apiGet('/api/tasks');
  const [events] = await Promise.all([
    apiGet('/api/events?from=' + addDaysStr(today, -7) + '&to=' + addDaysStr(today, 30)),
  ]);
  if (urlCategory) tasks = tasks.filter((t) => t.category === urlCategory);
  return buildTasksView({ today, tasks, events, urlState, urlCategory, locatedTask: null, title: null });
}

function taskNotFound(idNum) {
  const box = document.createElement('div');
  box.innerHTML = `
    <div class="card panel empty">
      <span class="empty-glyph">◌</span>
      <p>事项已更新或删除（未找到任务 #${esc(idNum)}）</p>
      <p class="empty-sub"><a href="#/tasks" class="link">返回全部待办</a></p>
    </div>`;
  return box;
}

async function buildTasksView({ today, tasks, events, urlState, urlCategory, locatedTask, title }) {
  const openGroups = [
    ['已逾期', tasks.filter((t) => !t.done && t.due_date && t.due_date < today), 'b-red'],
    ['今天截止', tasks.filter((t) => !t.done && t.due_date === today), 'b-accent'],
    ['即将截止', tasks.filter((t) => !t.done && t.due_date && t.due_date > today), 'b-blue'],
    ['无截止日期', tasks.filter((t) => !t.done && !t.due_date), 'b-gray'],
  ];
  const doneGroup = ['已完成', tasks.filter((t) => t.done), 'b-green'];
  const groups = urlState === 'done' ? [doneGroup]
    : urlState === 'all' ? [...openGroups, doneGroup]
      : openGroups;

  const openCount = tasks.filter((t) => !t.done).length;
  const countLabel = urlState === 'done'
    ? `${tasks.filter((t) => t.done).length} 项已完成`
    : urlState === 'all'
      ? `共 ${tasks.length} 项 · ${openCount} 项待办`
      : `${openCount} 项待办`;
  const emptyReason = urlState === 'done'
    ? '没有已完成的待办，完成一项后这里会出现记录'
    : urlState === 'all'
      ? '还没有任何待办，用上面的表单添加第一条'
      : '没有未完成的待办，太棒了！';
  const visible = groups.flatMap(([, list]) => list);

  const box = document.createElement('div');
  box.innerHTML = `
    <div class="two-col">
      <section class="card panel">
        <h3 class="section-title">${esc(title || '✓ 任务清单')} <span class="count">${esc(countLabel)}</span></h3>
        <div class="chip-row task-filters">
          <button class="chip ${urlState === 'open' ? 'active' : ''}" data-state="open">未完成</button>
          <button class="chip ${urlState === 'all' ? 'active' : ''}" data-state="all">全部</button>
          <button class="chip ${urlState === 'done' ? 'active' : ''}" data-state="done">已完成</button>
          <span class="chip-sep">· 分类：</span>
          <button class="chip ${urlCategory === '' ? 'active' : ''}" data-category="">全部</button>
          ${TASK_CATEGORIES.map((c) => `<button class="chip ${urlCategory === c ? 'active' : ''}" data-category="${c}">${c}</button>`).join('')}
        </div>
        <div class="panel-actions">
          <button class="btn btn-primary" id="btn-add-task">＋ 新增待办</button>
        </div>
        ${visible.length === 0 ? `<div class="empty"><span class="empty-glyph">✓</span><p>${esc(emptyReason)}</p></div>` : ''}
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

  // 新增与编辑共用 openTaskModal（首页快捷新增走同一表单）
  $('#btn-add-task', box).addEventListener('click', () => openTaskModal(null));

  $('#form-add-event', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/events', {
        title: f.title.value.trim(), date: f.date.value, start_time: f.start_time.value,
      });
      toast('日程已添加');
      rerender(currentRender());
    } catch (err) { toast(err.message, true); }
  });

  box.querySelectorAll('.task-filters .chip').forEach((c) => c.addEventListener('click', () => {
    if (c.dataset.state !== undefined) {
      navigateWithParams('tasks', { state: c.dataset.state, id: '' });
    } else {
      navigateWithParams('tasks', { category: c.dataset.category, id: '' });
    }
  }));

  bindTaskToggles(box, () => rerender(currentRender()));
  bindTaskCopyButtons(box, tasks);
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
  const synced = t.source && t.source !== 'manual';
  return `
    <div class="task-row ${t.done ? 'done' : ''}">
      ${synced ? '' : `<input type="checkbox" class="check" data-task-toggle="${t.id}" ${t.done ? 'checked' : ''} />`}
      <div class="body">
        <div class="title">${esc(t.title)}${t.focus_date === today ? ' <span class="badge b-accent">今日重点</span>' : ''}${synced ? ` <span class="badge b-violet">同步 · ${esc(t.source)}</span>` : ''}</div>
        <div class="meta">
          <span>${esc(t.category)}</span>
          ${t.due_date ? `<span class="${od ? 'overdue' : ''}">截止 ${fmtCN(t.due_date)}${od ? `（逾期 ${overdueDays(t.due_date)} 天）` : ''}</span>` : ''}
          ${t.done && t.done_at ? `<span>完成于 ${esc(t.done_at.slice(0, 10))}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        ${synced
          ? `<button class="btn btn-ghost btn-sm" data-task-copy="${t.id}">复制为个人待办</button>`
          : `<button class="btn btn-ghost btn-sm" data-task-edit="${t.id}">编辑</button>`}
      </div>
    </div>`;
}

// 同步任务复制为独立手工待办：预填内容，保存走 POST，新记录 source=manual
function openTaskCopyModal(t) {
  openTaskModal(null, {
    title: t.title, category: t.category, due_date: t.due_date, notes: t.notes,
  });
}

// 绑定「复制为个人待办」按钮（首页摘要与任务页共用）
function bindTaskCopyButtons(box, tasks) {
  box.querySelectorAll('[data-task-copy]').forEach((b) => b.addEventListener('click', () => {
    const t = tasks.find((x) => x.id === Number(b.dataset.taskCopy));
    if (t) openTaskCopyModal(t);
  }));
}

function openTaskModal(t, preset) {
  // 自定义旧分类不在预设列表时补入现值，避免保存时悄悄变成默认分类
  const base = t || preset || {};
  const options = base.category && !TASK_CATEGORIES.includes(base.category)
    ? [...TASK_CATEGORIES, base.category]
    : TASK_CATEGORIES;
  openModal({
    title: t ? '编辑任务' : '新增待办',
    fields: [
      { name: 'title', label: '标题', required: true, full: true },
      { name: 'category', label: '分类', type: 'select', options },
      { name: 'due_date', label: '截止日期', type: 'date' },
      { name: 'focus_date', label: '重点日期（设为今日重点则填今天）', type: 'date', full: true },
      { name: 'notes', label: '备注', type: 'textarea' },
    ],
    values: t || preset || { category: '生活', due_date: '', focus_date: '' },
    onSubmit: async (data) => {
      if (t) {
        await api('PATCH', `/api/tasks/${t.id}`, data);
        toast('任务已更新');
      } else {
        await api('POST', '/api/tasks', data);
        toast('任务已添加');
      }
      rerender(currentRender());
    },
    onDelete: t ? async () => {
      await api('DELETE', `/api/tasks/${t.id}`);
      toast('任务已删除');
      rerender(currentRender());
    } : null,
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
      rerender(currentRender());
    },
    onDelete: async () => {
      await api('DELETE', `/api/events/${ev.id}`);
      toast('日程已删除');
      rerender(currentRender());
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
      rerender(currentRender());
    },
    onDelete: a ? async () => {
      await api('DELETE', `/api/achievements/${a.id}`);
      toast('已删除');
      rerender(currentRender());
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
let rerenderSeq = 0;
async function rerender(renderFn) {
  const gen = navSeq;      // 挂载必须仍处于发起刷新时的路由代际
  const seq = ++rerenderSeq;   // 同代际内只允许最后一次刷新挂载
  try {
    const content = await renderFn();
    if (gen !== navSeq || seq !== rerenderSeq) return;   // 已有更新的导航/刷新
    mountView(content);
  } catch (err) {
    if (gen !== navSeq || seq !== rerenderSeq) return;
    view.innerHTML = `<div class="card panel empty">加载失败：${esc(err.message)}</div>`;
  }
}

/* ---------- 路由与启动 ---------- */
const ROUTES = {
  today: { title: '今日首页', render: renderToday },
  campus: { title: '校招投递', render: renderCampus },
  tasks: { title: '待办与日程', render: renderTasks },
  achievements: { title: '成果记录', render: renderAchievements },
};

// hash → { key, params }：#/campus?stage=interviewing → { key:'campus', params:… }
function parseRoute(hash) {
  const [raw, query = ''] = hash.replace(/^#\/?/, '').split('?');
  return { key: raw || 'today', params: new URLSearchParams(query) };
}

// 更新当前路由的查询参数（保留其余参数；值为空则删除），筛选状态写入 URL 可分享/可前进后退
function navigateWithParams(key, updates) {
  const { params } = parseRoute(location.hash);
  for (const [k, v] of Object.entries(updates)) {
    if (v === '' || v === null || v === undefined) params.delete(k);
    else params.set(k, v);
  }
  const qs = params.toString();
  location.hash = '#/' + key + (qs ? '?' + qs : '');
}

let navSeq = 0;
let deepLinkId = null;   // 本次路由进入时的 id 深链（只消费一次，rerender 不重复打开弹窗）

// 当前路由的渲染函数：保存/删除后的刷新跟随当前路由，避免旧回调把视图拖回别的页面
function currentRender() {
  const { key, params } = parseRoute(location.hash);
  const r = ROUTES[key] || ROUTES.today;
  return () => r.render(params);
}

// 用户是否正在编辑视图内的表单（弹窗打开，或焦点在 #view 内的表单控件上）
function viewBeingEdited() {
  if (document.querySelector('#modal-mask:not([hidden])')) return true;
  const el = document.activeElement;
  return !!(el && el.closest && el.closest('#view form'));
}

async function route() {
  const { key, params } = parseRoute(location.hash);
  const r = ROUTES[key] || ROUTES.today;
  const seq = ++navSeq;
  deepLinkId = params.get('id');   // 供视图消费：id 深链只在本路由入口打开一次
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
    html = await r.render(params);   // 缓存命中即秒开；未命中期间旧内容仍在，无闪白
  } catch (err) {
    html = `<div class="card panel empty">加载失败：${esc(err.message)}</div>`;
  }

  if (seq !== navSeq) return;  // 已被更新的导航取代
  await exitDone;
  if (seq !== navSeq) return;

  deepLinkId = null;   // 深链已消费（或视图无 id 处理）
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
  // 问候语同样按上海时间展示，不随浏览器时区漂移
  const d = new Date();
  const [y, m, day] = todayStr(d).split('-');
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(`${y}-${m}-${day}T00:00:00`).getDay()];
  const hour = (d.getUTCHours() + 8) % 24;   // 上海 = UTC+8，无夏令时
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  $('#topbar-date').textContent = `${greet} · ${Number(m)} 月 ${Number(day)} 日 · 星期${week}`;
  $('#btn-menu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
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
