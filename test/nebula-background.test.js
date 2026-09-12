'use strict';

// WebGL 星云背景契约测试：
//  - three 本地打包产物存在、自托管加载（无 CDN）、与 CSP script-src 'self' 兼容
//  - 引擎源码：cover 裁切（无黑边/截断）、WebGL 降级、prefers-reduced-motion 静态帧、
//    页面隐藏暂停、DPR 上限、氛围色板
//  - 页面 DOM：固定全屏画布（body 直接子元素）+ 渐变降级层 + 可读性暗角层
//  - 真实 HTTP：vendor 资源可访问且类型正确
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../support/server-harness');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_FILE = path.join(PUBLIC_DIR, 'vendor', 'nebula.min.js');
const readPublic = (name) => fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.close());

/* ---------- 本地打包产物 ---------- */

test('vendor 产物：three 已本地打包为单文件，无 CDN 引用', () => {
  assert.ok(fs.existsSync(VENDOR_FILE), 'public/vendor/nebula.min.js 不存在，请先运行 npm run build:vendor');
  const bundle = fs.readFileSync(VENDOR_FILE, 'utf8');
  // 包含 three 引擎（WebGLRenderer 等 API 属性名在 minify 后保留）与星云入口
  assert.ok(bundle.includes('WebGLRenderer'), '产物未包含 three WebGLRenderer');
  assert.ok(bundle.includes('MSNebula'), '产物未包含星云引擎入口 MSNebula');
  assert.ok(bundle.includes('nebula-canvas'), '产物未绑定 #nebula-canvas');
  assert.ok(!bundle.includes('setPriority'), '产物不应保留 setPriority（Canvas 始终连续动画，路由过渡不暂停）');
  assert.doesNotMatch(bundle, /uBlend/, '产物不应保留色板过渡 uniform');
  // 体积下限：three 本体约 500KB（防止空文件/构建失败被提交）
  assert.ok(fs.statSync(VENDOR_FILE).size > 300 * 1024, '产物体积异常，疑似构建失败');
  // 无 CDN / 外部资源（CSP script-src 'self' 下运行时不应发起任何外部请求）。
  // three 内部仅含两类合法字面量：XML 命名空间（w3.org/1999/xhtml）与
  // 色调映射论文引用（jcgt.org），其余 http(s) URL 一律视为违规。
  assert.doesNotMatch(bundle, /https?:\/\/(?!www\.w3\.org\/|jcgt\.org\/)/i, '产物含外部 URL 引用');
  assert.doesNotMatch(bundle, /cdn|unpkg|jsdelivr/i, '产物疑似引用 CDN');
});

test('页面脚本引用：全部同源，无内联脚本（CSP script-src self 兼容）', () => {
  for (const name of ['index.html', 'login.html']) {
    const html = readPublic(name);
    const scripts = [...html.matchAll(/<script[^>]*>/g)].map((m) => m[0]);
    assert.ok(scripts.length >= 3, `${name} 脚本数量异常`);
    for (const tag of scripts) {
      assert.match(tag, /\bsrc="\/(?!\/)/, `${name} 存在非同源/内联脚本: ${tag}`);
      assert.doesNotMatch(tag, /https?:\/\//i, `${name} 引用了外部脚本: ${tag}`);
    }
    // 星云画布与降级层结构
    assert.match(html, /<canvas id="nebula-canvas"/, `${name} 缺少星云画布`);
    assert.match(html, /<div class="bg-fallback"/, `${name} 缺少渐变降级层`);
  }
});

/* ---------- 引擎源码契约（构建源） ---------- */

test('引擎源码：cover 裁切 + 降级 + 动效偏好 + 性能护栏', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'webgl', 'nebula.js'), 'utf8');
  // cover 裁切：中心化 + 最短边归一 —— 任意宽高比填满视口，无黑边/无截断
  assert.match(src, /gl_FragCoord\.xy\s*-\s*0\.5\s*\*\s*iResolution/, '缺少中心化坐标');
  assert.match(src, /min\(iResolution\.x,\s*iResolution\.y\)/, '缺少最短边归一（cover 裁切）');
  // 全屏尺寸同步：视口尺寸 + DPR 上限（品质与填充压力平衡）
  assert.match(src, /window\.innerWidth/, '未按视口宽度设置渲染尺寸');
  assert.match(src, /setSize\(w,\s*h,\s*false\)/, '渲染缓冲尺寸未与视口同步');
  assert.match(src, /MAX_DPR\s*=\s*2/, 'DPR 未设上限');
  // WebGL 不可用 / 上下文丢失 → CSS 渐变降级
  assert.match(src, /no-webgl/, '缺少降级类 no-webgl');
  assert.match(src, /webglcontextlost/, '未处理 WebGL 上下文丢失');
  assert.match(src, /WebGLRenderingContext/, '未做 WebGL 能力预检');
  // prefers-reduced-motion → 只渲染一帧静态星云，不启动循环
  assert.match(src, /prefers-reduced-motion/, '未尊重 prefers-reduced-motion');
  assert.match(src, /renderStatic\(\)/, '缺少静态帧渲染');
  assert.match(src, /setAnimationLoop\(null\)/, '未提供动画循环关闭路径');
  // 页面隐藏时暂停渲染
  assert.match(src, /document\.hidden/, '未在页面隐藏时暂停渲染');
  // 唯一背景色板（default 靛紫）：不再按页面/风险/日程切换 flow/risk 色板与过渡
  assert.ok(src.includes('default:'), '缺少唯一色板 default');
  assert.doesNotMatch(src, /\b(flow|risk)\s*:/, '不应保留 flow/risk 色板');
  assert.doesNotMatch(src, /uBlend/, '不应保留色板过渡 uniform');
  assert.doesNotMatch(src, /setVibe/, '不应保留氛围切换 API');
  // Canvas 始终连续动画：不提供 setPriority 暂停/恢复 API
  // （曾因路由过渡暂停背景再恢复显得卡顿；reduced-motion 静态帧 / 页面隐藏暂停不受影响）
  assert.doesNotMatch(src, /setPriority\s*[:(]/, '引擎不应保留 setPriority 暂停/恢复 API');
  // 品质：光线行进 8 步 + 提前退出 + 高精度 + 去色带颗粒
  assert.match(src, /i\s*<\s*8/, '光线行进步数不足 8 步');
  assert.match(src, /GL_FRAGMENT_PRECISION_HIGH/, '未启用 highp 精度分支');
  assert.match(src, /antialias:\s*true/, '未开启抗锯齿');
  // 中心变暗保证内容可读
  assert.match(src, /uDim/, '缺少中心变暗（内容可读性）uniform');
});

test('styles.css：固定全屏裁切 + no-webgl 降级 + 内容层可读性', () => {
  const css = readPublic('styles.css');
  // 星云画布固定全屏（body 直接子元素），不依赖 transform/位移容器
  assert.match(css, /\.bg-nebula\s*\{[^}]*position:\s*fixed/, '.bg-nebula 未固定定位');
  assert.match(css, /\.bg-nebula\s*\{[^}]*inset:\s*0/, '.bg-nebula 未铺满视口');
  assert.match(css, /\.bg-nebula\s*\{[^}]*width:\s*100%[^}]*height:\s*100%/, '.bg-nebula 未设置 100% 尺寸');
  // 降级：no-webgl 时隐藏画布，露出 CSS 渐变
  assert.match(css, /body\.no-webgl\s+\.bg-nebula\s*\{[^}]*display:\s*none/, 'no-webgl 降级未隐藏画布');
  assert.ok(css.includes('radial-gradient'), '降级层缺少 CSS 渐变背景');
  // 内容层可读性：暗角叠加层 + 内容层在背景之上
  assert.match(css, /\.bg-veil\s*\{[^}]*pointer-events:\s*none/, '暗角层未禁用指针事件');
  assert.match(css, /\.layout\s*\{[^}]*z-index:\s*1/, '内容层未置于背景之上');
  // reduced-motion 下背景淡入过渡被全局动画关闭规则覆盖
  assert.match(css, /prefers-reduced-motion:\s*reduce/, '缺少 reduced-motion 全局规则');
});

/* ---------- 真实 HTTP 流程 ---------- */

test('vendor 资源可自托管访问，且类型正确', async () => {
  const r = await srv.api('GET', '/vendor/nebula.min.js');
  assert.equal(r.status, 200, 'vendor 资源应可访问');
  const type = await (await srv.page('/vendor/nebula.min.js')).headers.get('content-type');
  assert.match(type, /javascript/i, 'vendor 资源 Content-Type 应为 JavaScript');
});

test('首页响应 CSP：script-src 仅同源，星云画布随页面下发', async () => {
  const home = await srv.page('/');
  assert.equal(home.status, 200);
  const csp = home.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src\s+'self'/, 'CSP 应限制脚本为同源');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'CSP script-src 不应允许内联脚本');
  const html = await home.text();
  assert.match(html, /src="\/vendor\/nebula\.min\.js"/, '首页应引用本地 vendor 脚本');
});
