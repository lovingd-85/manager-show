'use strict';

// 前端视觉重设计契约测试：页面结构（关键 DOM 钩子）、CSP 合规（无内联脚本/外部 CDN）、
// 样式系统（玻璃卡片/状态色/动效偏好/响应式）、app.js 交互绑定完整性、登录页真实 HTTP 流程。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../support/server-harness');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

let api, page, close;
before(async () => { ({ api, page, close } = await startServer()); });
after(() => close());

/* ---------- 页面结构契约 ---------- */

test('index.html：包含全部 JS 依赖的 DOM 钩子（结构契约）', () => {
  const html = readPublic('index.html');
  // 全局容器
  for (const id of ['sidebar', 'btn-menu', 'topbar-title', 'topbar-date', 'view',
    'modal-mask', 'modal-title', 'modal-close', 'modal-form', 'toast',
    'btn-reset-seed', 'btn-logout', 'nebula-canvas', 'bottom-nav']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  // 四个路由导航（侧边栏 + 移动端底部导航各一份）
  for (const route of ['today', 'campus', 'tasks', 'achievements']) {
    assert.ok(html.includes(`data-route="${route}"`), `index.html 缺少导航 data-route="${route}"`);
    assert.ok(html.includes(`href="#/${route}"`), `index.html 缺少导航链接 #/${route}`);
  }
  const navCount = (html.match(/data-route="/g) || []).length;
  assert.equal(navCount, 8, '四个路由应各有两个导航入口（侧边栏 + 底部导航）');
  // 氛围背景三层：CSS 渐变降级层（仅默认靛紫配色极光层）+ WebGL 星云画布 + 可读性暗角层
  for (const cls of ['bg-fallback', 'bg-grid', 'aurora aurora-a']) {
    assert.ok(html.includes(`class="${cls}"`), `index.html 缺少背景层 .${cls}`);
  }
  assert.ok(html.includes('class="bg-nebula"'), 'index.html 缺少星云画布 .bg-nebula');
  assert.ok(html.includes('class="bg-veil"'), 'index.html 缺少可读性暗角层 .bg-veil');
  // 星云画布必须是 body 直接子元素结构（固定全屏，不挂在位移容器内）
  assert.match(html, /<canvas id="nebula-canvas"[^>]*><\/canvas>\s*<div class="bg-veil"/, '星云画布应独立于降级层，直接铺满视口');
  // 样式与脚本引用（vendor 为本地打包的 three + 星云引擎，同源加载）
  assert.match(html, /<link rel="stylesheet" href="\/styles\.css"/);
  assert.match(html, /<script src="\/theme\.js"><\/script>/);
  assert.match(html, /<script src="\/vendor\/nebula\.min\.js"><\/script>/);
  assert.match(html, /<script src="\/app\.js"><\/script>/);
});

test('login.html：登录表单结构完整', () => {
  const html = readPublic('login.html');
  for (const id of ['login-form', 'password', 'login-btn', 'login-error', 'pw-toggle']) {
    assert.ok(html.includes(`id="${id}"`), `login.html 缺少 #${id}`);
  }
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /<script src="\/theme\.js"><\/script>/);
  assert.match(html, /<script src="\/login\.js"><\/script>/);
  assert.match(html, /<script src="\/vendor\/nebula\.min\.js"><\/script>/);
  assert.match(html, /<canvas id="nebula-canvas"/);
  assert.match(html, /class="bg-fallback"/, '登录页应包含 CSS 渐变降级层');
});

test('CSP 合规：页面无内联脚本、无内联事件处理器、无外部 CDN 资源', () => {
  for (const name of ['index.html', 'login.html']) {
    const html = readPublic(name);
    // 无内联脚本：所有 <script> 必须带 src；无 <style> 块
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${name} 含内联 <script>`);
    assert.doesNotMatch(html, /<style/i, `${name} 含内联 <style>`);
    assert.doesNotMatch(html, /\son\w+\s*=/i, `${name} 含内联事件处理器`);
    assert.doesNotMatch(html, /src="https?:\/\//i, `${name} 引用了外部脚本`);
    assert.doesNotMatch(html, /href="https?:\/\//i, `${name} 引用了外部链接资源`);
  }
  // CSS 无外部资源；JS 文件本身来自同源静态目录
  const css = readPublic('styles.css');
  assert.doesNotMatch(css, /url\(\s*['"]?https?:\/\//i, 'styles.css 引用了外部 URL');
});

/* ---------- 设计系统契约 ---------- */

test('styles.css：暗色玻璃设计系统关键元素齐全', () => {
  const css = readPublic('styles.css');
  // 设计令牌与玻璃质感
  for (const token of ['--bg-0', '--glass', '--ink', '--accent', '--radius']) {
    assert.ok(css.includes(token), `styles.css 缺少令牌 ${token}`);
  }
  for (const feat of ['backdrop-filter', '.card', '.btn-primary', '.stat', '.lane', '.timeline']) {
    assert.ok(css.includes(feat), `styles.css 缺少 ${feat}`);
  }
  // 全部 8 种投递状态徽章（含重设计后新增的 b-gold Offer）
  for (const badge of ['b-gray', 'b-blue', 'b-violet', 'b-accent', 'b-green', 'b-gold', 'b-red', 'b-amber']) {
    assert.ok(css.includes(`.${badge}`), `styles.css 缺少状态色 .${badge}`);
  }
  // 全部 8 个泳道状态强调色
  for (const s of ['待投递', '已投递', '笔试', '面试', '流程完成', 'Offer', '已拒绝', '已结束']) {
    assert.ok(css.includes(`.lane[data-status="${s}"]`), `styles.css 缺少泳道状态色 [data-status="${s}"]`);
  }
  // 可访问性：focus-visible 与 prefers-reduced-motion
  assert.match(css, /:focus-visible\s*\{/, '缺少 :focus-visible 焦点样式');
  assert.match(css, /prefers-reduced-motion:\s*reduce/, '缺少 prefers-reduced-motion 处理');
  assert.match(css, /color-scheme:\s*dark/, '缺少 color-scheme: dark（暗色表单控件）');
  // 响应式断点
  assert.match(css, /@media\s*\(max-width:\s*760px\)/, '缺少移动端断点');
  assert.match(css, /@media\s*\(hover:\s*none\)/, '缺少触屏适配');
  // 新背景体系：固定全屏星云画布、CSS 降级层、底部导航
  assert.ok(css.includes('.bg-nebula'), '缺少星云画布样式 .bg-nebula');
  assert.ok(css.includes('.bg-fallback'), '缺少 CSS 渐变降级层 .bg-fallback');
  assert.ok(css.includes('no-webgl'), '缺少 WebGL 降级开关 no-webgl');
  assert.ok(css.includes('.bg-veil'), '缺少可读性暗角层 .bg-veil');
  assert.ok(css.includes('.bottom-nav'), '缺少移动端底部导航 .bottom-nav');
  assert.match(css, /env\(safe-area-inset-bottom/, '底部导航未适配 iOS 安全区');
});

test('theme.js：单一默认配色（仅降级层视差，不再切换氛围）', () => {
  const js = readPublic('theme.js');
  assert.doesNotMatch(js, /MSVibe|setVibe/, 'theme.js 不应保留氛围切换 API');
  assert.doesNotMatch(js, /'flow'|'risk'/, 'theme.js 不应保留 flow/risk 氛围');
  assert.doesNotMatch(js, /body\.dataset\.vibe/, 'theme.js 不应再写 body[data-vibe]');
  // 指针视差：仅在非 WebGL 降级模式下启用，且尊重动效偏好与触屏
  assert.match(js, /nebula-on/, 'theme.js 未在星云运行时跳过降级层视差');
  assert.match(js, /prefers-reduced-motion/, 'theme.js 未尊重 prefers-reduced-motion');
  assert.match(js, /hover:\s*hover/, 'theme.js 未限制触屏设备视差');
});

test('app.js：全部交互绑定与视图契约未被破坏', () => {
  const js = readPublic('app.js');
  // 数据钩子绑定（旧交互全部保留）
  for (const hook of ['data-task-toggle', 'data-app-id', 'data-task-edit', 'data-event-edit', 'data-ach-edit', 'data-status']) {
    assert.ok(js.includes(hook), `app.js 缺少交互钩子 ${hook}`);
  }
  // 视图渲染函数与路由
  for (const fn of ['renderToday', 'renderCampus', 'renderTasks', 'renderAchievements']) {
    assert.ok(js.includes(`async function ${fn}`), `app.js 缺少视图函数 ${fn}`);
  }
  for (const key of ['today', 'campus', 'tasks', 'achievements']) {
    assert.ok(js.includes(`${key}: {`), `app.js 路由表缺少 ${key}`);
  }
  // 弹窗表单（含新增的 Escape 关闭与首字段聚焦）
  assert.ok(js.includes("e.key === 'Escape'"), 'app.js 弹窗缺少 Escape 关闭');
  assert.ok(js.includes('first.focus()'), 'app.js 弹窗缺少首字段聚焦');
  // 单一默认配色：不再切换氛围
  assert.ok(!js.includes('setVibe'), 'app.js 不应再切换氛围');
  // 移动端底部导航与侧边栏共用路由高亮
  assert.ok(js.includes("'.nav a, .bottom-nav a'"), 'app.js 路由高亮未覆盖底部导航');
  // 8 种状态 + Offer 使用新增的金色徽章
  assert.ok(js.includes("'Offer': 'b-gold'"), 'Offer 状态应使用金色徽章');
  assert.match(js, /const APP_STATUSES = \['待投递', '已投递', '笔试', '面试', '流程完成', 'Offer', '已拒绝', '已结束'\]/, '状态枚举不应变化');
  // 结构类契约（模板依赖的类名）
  for (const cls of ['stats-strip', 'dash-grid', 'board', 'two-col', 'timeline', 'inline-form', 'chip-row']) {
    assert.ok(js.includes(cls), `app.js 模板缺少结构类 ${cls}`);
  }
});

/* ---------- 真实 HTTP 流程 ---------- */

test('登录流：未登录跳转 → 登录页 → 登录 → 首页携带全部视图骨架', async () => {
  // 本测试需要「未登录」起点：单独启动一个不自动登录的实例
  const unauthSrv = await startServer({ login: false, appOptions: { adminPassword: 'ui-test-secret' } });
  try {
    // 未登录访问首页：302 → /login
    const unauth = await unauthSrv.page('/');
    assert.equal(unauth.status, 302);
    assert.equal(unauth.headers.get('location'), '/login');

    // 登录页公开且结构完整
    const loginPage = await unauthSrv.page('/login');
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /id="login-form"/);
    assert.match(loginHtml, /<canvas id="nebula-canvas"/);

    // 登录页的前端资源均可访问（含本地打包的星云引擎）
    for (const p of ['/theme.js', '/styles.css', '/login.js', '/vendor/nebula.min.js']) {
      const r = await unauthSrv.api('GET', p);
      assert.equal(r.status, 200, `${p} 应可访问`);
    }

    // 登录：携带正确密码 → 200 且设置会话 Cookie；错误密码 → 401
    const bad = await unauthSrv.api('POST', '/api/auth/login', { password: 'wrong' });
    assert.equal(bad.status, 401);
    const ok = await unauthSrv.api('POST', '/api/auth/login', { password: 'ui-test-secret' });
    assert.equal(ok.status, 200);
  } finally {
    await unauthSrv.close();
  }

  // 登录成功后首页返回完整应用骨架
  const home = await page('/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Manager Show/);
  assert.match(html, /id="view"/);
  assert.match(html, /data-route="today"/);
  assert.match(html, /class="bg-fallback"/);
  assert.match(html, /class="aurora aurora-a"/);
  assert.match(html, /id="nebula-canvas"/);
  // 页面带 CSP，且 script-src 不含 unsafe-inline（内联脚本会被浏览器拦截）
  const csp = home.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/, 'CSP 应限制脚本为同源');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'CSP script-src 不应允许内联脚本');

  // 登录后 API 数据可用（前端渲染所依赖的接口全部正常）
  const dash = await api('GET', '/api/dashboard?date=' + new Date().toISOString().slice(0, 10));
  assert.equal(dash.status, 200);
  assert.ok('stats' in dash.json);
});
