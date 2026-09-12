'use strict';

// 测试辅助：在临时数据库上启动真实 HTTP 服务，并以管理员身份自动登录。
// startServer({ seed, appOptions, login, loginPassword })
//  - appOptions 透传给 createApp（如 { adminPassword: '…' }）
//  - login 默认 true：启动后自动登录，返回的 api/page 自动携带会话 Cookie；
//    安全层测试传 login: false 以便自行控制未登录/登录状态。
// 用法：在 before() 中调用 startServer()，在 after() 中调用 close()。
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createApp } = require('../src/app');

function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function startServer({ seed = true, appOptions = {}, login = true, loginPassword } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const opts = { dbPath, seed, ...appOptions };
  if (!opts.adminPasswordHash && !opts.adminPassword) opts.adminPassword = 'test-secret';
  const app = createApp(opts);

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 自动登录，后续请求携带会话 Cookie
  let cookieHeader = '';
  if (login) {
    const password = loginPassword ?? opts.adminPassword ?? 'test-secret';
    const res = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const getSetCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    cookieHeader = getSetCookie.map((c) => c.split(';')[0]).join('; ');
    if (!res.ok || !cookieHeader) throw new Error(`测试自动登录失败（${res.status}）`);
  }

  async function api(method, urlPath, body, headers = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  }

  // 页面请求（携带 Cookie，不跟随重定向）
  function page(urlPath) {
    return fetch(baseUrl + urlPath, {
      headers: cookieHeader ? { Cookie: cookieHeader } : {},
      redirect: 'manual',
    });
  }

  function close() {
    return new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        resolve();
      });
    });
  }

  return { baseUrl, api, page, close };
}

module.exports = { startServer, localToday, addDays };
