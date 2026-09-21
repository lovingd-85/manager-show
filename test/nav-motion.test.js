'use strict';

// 导航性能与交互契约测试（TDD 先行）：
//  - 视觉：唯一背景色板（default 靛紫），移除按页面/风险/日程的 flow/risk 色板切换与过渡
//  - 背景：Canvas 单实例常驻，不随路由重建；Canvas 始终连续动画 ——
//    正常动效模式下路由切换不得调用 MSNebula.setPriority、不得暂停/降帧
//    （保留 prefers-reduced-motion 静态帧 / WebGL 降级 / 页面隐藏暂停）
//  - 前景：#view 内容短淡出 + 轻微上移离场，新内容淡入 + 轻微上移入场；
//    避免闪白与重叠；键盘导航与减少动画偏好下即时切换
//  - 性能：四个 GET 数据源（dashboard/applications/tasks/events）内存缓存 + 并发去重，
//    路由先显示缓存再后台刷新；POST/PATCH/DELETE/seed 成功后精确失效相关缓存
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

/* ---------- 单一默认配色（移除 flow/risk 色板切换） ---------- */

test('app.js：不再按页面/风险/日程切换氛围（仅保留 default 靛紫配色）', () => {
  const js = readPublic('app.js');
  assert.ok(!js.includes('setVibe'), 'app.js 不应再调用氛围切换');
  assert.doesNotMatch(js, /'flow'|'risk'/, 'app.js 不应出现 flow/risk 氛围常量');
});

test('theme.js / index.html / login.html / styles.css：只保留默认配色层', () => {
  const theme = readPublic('theme.js');
  assert.doesNotMatch(theme, /MSVibe|setVibe/, 'theme.js 不应保留氛围切换 API');
  assert.doesNotMatch(theme, /'flow'|'risk'/, 'theme.js 不应保留 flow/risk 氛围');
  for (const name of ['index.html', 'login.html']) {
    const html = readPublic(name);
    assert.doesNotMatch(html, /data-vibe/, `${name} 不应再带 body[data-vibe]`);
    assert.doesNotMatch(html, /aurora-b|aurora-c/, `${name} 不应保留 flow/risk 极光层`);
    assert.ok(html.includes('aurora aurora-a'), `${name} 缺少默认配色极光层`);
  }
  const css = readPublic('styles.css');
  assert.doesNotMatch(css, /data-vibe/, 'styles.css 不应保留氛围切换规则');
  assert.doesNotMatch(css, /\.aurora-b|\.aurora-c|aurora-drift-[bc]/, 'styles.css 不应保留 flow/risk 极光层与过渡');
  assert.match(css, /@keyframes\s+aurora-drift-a/, 'styles.css 应保留默认配色极光动画');
});

test('星云引擎：唯一色板 default，移除色板过渡与切换 API', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'webgl', 'nebula.js'), 'utf8');
  assert.ok(src.includes('default:'), '引擎缺少唯一色板 default');
  assert.doesNotMatch(src, /\b(flow|risk)\s*:/, '引擎不应保留 flow/risk 色板');
  assert.doesNotMatch(src, /uBlend/, '引擎不应保留色板过渡 uniform');
  assert.doesNotMatch(src, /setVibe/, '引擎不应保留氛围切换 API');
});

/* ---------- Canvas 单实例常驻 + 背景连续动画（路由过渡不让出资源） ---------- */

test('Canvas 单实例：页面仅一个 #nebula-canvas，app.js 从不创建/重建画布', () => {
  const html = readPublic('index.html');
  assert.equal((html.match(/id="nebula-canvas"/g) || []).length, 1, '页面应只有一个星云画布');
  const js = readPublic('app.js');
  assert.doesNotMatch(js, /createElement\(\s*['"]canvas/, 'app.js 不应创建画布');
  assert.ok(!js.includes('nebula-canvas'), 'app.js 不应触碰画布元素（路由切换不重建）');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'webgl', 'nebula.js'), 'utf8');
  const binds = src.match(/getElementById\('nebula-canvas'\)/g) || [];
  assert.equal(binds.length, 1, '引擎应恰好绑定一次画布（单实例常驻）');
});

test('路由过渡：正常动效下背景连续动画，不得调用 setPriority / 暂停降帧', () => {
  const js = readPublic('app.js');
  assert.doesNotMatch(js, /setPriority\(\s*['"]low['"]\s*\)/, 'app.js 过渡期间不应让背景降帧/暂停');
  assert.doesNotMatch(js, /setPriority\(\s*['"]normal['"]\s*\)/, 'app.js 过渡后不应有恢复背景的调用（背景从未暂停）');
  assert.doesNotMatch(js, /setPriority/, 'app.js 路由切换不得调用 MSNebula.setPriority（背景必须连续动画）');
  assert.doesNotMatch(js, /yieldBackground/, 'app.js 不应保留背景让路函数（暂停后恢复会造成卡顿）');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'webgl', 'nebula.js'), 'utf8');
  assert.doesNotMatch(src, /setPriority\s*[:(]/, '引擎不应保留 setPriority 暂停/恢复 API（Canvas 始终连续动画）');
  assert.match(src, /setAnimationLoop\(null\)/, '引擎仍应保留动画循环关闭路径（reduced-motion 静态帧 / WebGL 降级）');
  assert.match(src, /reducedMotion\(\)/, '引擎应尊重 prefers-reduced-motion');
});

/* ---------- #view 路由过渡 ---------- */

test('#view 过渡：离场淡出上移 + 入场淡入上移，短而精致', () => {
  const css = readPublic('styles.css');
  assert.match(css, /\.view-leaving\s*\{[^}]*animation:\s*view-out/, '缺少离场动画类');
  assert.match(css, /\.view-entering\s*\{[^}]*animation:\s*view-in/, '缺少入场动画类');
  const out = css.match(/@keyframes\s+view-out\s*\{[\s\S]*?\n\}/);
  assert.ok(out, '缺少 view-out 关键帧');
  assert.match(out[0], /opacity:\s*0/, '离场应淡出至透明');
  assert.match(out[0], /translateY\(-/, '离场应轻微上移');
  const inn = css.match(/@keyframes\s+view-in\s*\{[\s\S]*?\n\}/);
  assert.ok(inn, '缺少 view-in 关键帧');
  assert.match(inn[0], /opacity:\s*0/, '入场应从透明开始');
  assert.match(inn[0], /translateY\(/, '入场应轻微上移');
  const js = readPublic('app.js');
  assert.match(js, /view-leaving/, 'app.js 未应用离场动画类');
  assert.match(js, /view-entering/, 'app.js 未应用入场动画类');
  assert.match(js, /animationend/, 'app.js 未等待离场动画结束再切换内容（避免重叠）');
});

test('#view 过渡：键盘导航与减少动画偏好下即时切换', () => {
  const js = readPublic('app.js');
  assert.match(js, /prefers-reduced-motion/, 'app.js 未检测减少动画偏好');
  assert.match(js, /keydown/, 'app.js 未检测键盘导航');
  assert.match(js, /navViaKeyboard/, 'app.js 缺少键盘导航即时切换标记');
  const css = readPublic('styles.css');
  assert.match(css,
    /prefers-reduced-motion:\s*reduce\)[\s\S]{0,900}?\.view-(leaving|entering)[\s\S]{0,120}?animation:\s*none/,
    'reduced-motion 下视图过渡应被禁用（即时切换）');
});

/* ---------- 四个 GET 数据源：内存缓存 + 并发去重 + 写后精确失效 ---------- */

test('四个 GET 数据源走统一缓存入口（内存缓存 + 并发去重 + 后台刷新）', () => {
  const js = readPublic('app.js');
  assert.match(js, /apiCache\s*=\s*new Map\(\)/, '缺少内存缓存存储');
  assert.match(js, /inflight\s*=\s*new Map\(\)/, '缺少并发去重存储');
  assert.match(js, /CACHE_TTL/, '缺少缓存新鲜度 TTL');
  assert.match(js, /async function apiGet/, '缺少缓存读取入口 apiGet');
  assert.match(js, /inflight\.has\(url\)/, '缺少并发去重判断');
  assert.match(js, /后台刷新/, '缺少过期缓存后台刷新（先显示缓存再刷新）');
  for (const src of ["apiGet('/api/dashboard", "apiGet('/api/applications?'",
    "apiGet('/api/tasks'", "apiGet('/api/events?"]) {
    assert.ok(js.includes(src), `四个数据源之一未走缓存入口：${src}`);
  }
});

test('写操作成功后精确失效相关缓存（不展示陈旧任务/投递数据）', () => {
  const js = readPublic('app.js');
  assert.match(js, /invalidateFor\(\s*method\s*,\s*path\s*\)/, 'api() 写成功后未触发缓存失效');
  assert.match(js, /function invalidateFor/, '缺少缓存失效路由函数');
  assert.match(js, /method\s*===\s*'GET'\)\s*return/, '失效应只针对写操作');
  assert.ok(js.includes("startsWith('/api/tasks')"), '任务写入未失效任务缓存');
  assert.ok(js.includes("startsWith('/api/events')"), '日程写入未失效日程缓存');
  assert.ok(js.includes("startsWith('/api/applications')"), '投递写入未失效投递缓存');
  assert.ok(js.includes("startsWith('/api/achievements')"), '成果写入未失效成果缓存');
  assert.ok(!js.includes("'/api/seed/reset'"), '不应保留 seed 重置缓存失效分支');
  assert.match(js, /drop\('\/api\/dashboard'\)/, '写操作未联动失效今日首页缓存');
});
