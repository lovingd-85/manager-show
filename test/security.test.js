'use strict';

// 安全层行为测试：登录、会话 Cookie 属性、接口与页面保护、CSRF、登录限流、安全响应头、退出。
// 使用独立于 harness 的 HTTP 客户端：手动维护会话 Cookie、可自定义请求头、不自动跟随重定向。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../support/server-harness');

const PASSWORD = 'correct-horse-battery-staple';

let srv;
before(async () => {
  srv = await startServer({ login: false, appOptions: { adminPassword: PASSWORD } });
});
after(() => srv.close());

function makeClient(baseUrl) {
  let cookie = '';
  async function req(method, urlPath, { body, headers = {} } = {}) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const getSetCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (getSetCookie.length) cookie = getSetCookie.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return {
      status: res.status, json, text,
      headers: res.headers,
      location: res.headers.get('location'),
      setCookies: getSetCookie,
    };
  }
  return { req };
}

test('未登录：所有读接口返回 401 且不泄露数据', async () => {
  const client = makeClient(srv.baseUrl);
  const readPaths = [
    '/api/dashboard?date=2099-01-01',
    '/api/applications', '/api/applications/1',
    '/api/tasks', '/api/tasks/1',
    '/api/events', '/api/events/1',
    '/api/achievements', '/api/achievements/1',
  ];
  for (const p of readPaths) {
    const res = await client.req('GET', p);
    assert.equal(res.status, 401, `GET ${p} 未登录应返回 401`);
    assert.equal(res.json && res.json.error, '未登录');
  }
});

test('未登录：所有写接口返回 401 且数据不被修改', async () => {
  const client = makeClient(srv.baseUrl);
  const writeAttempts = [
    ['POST', '/api/applications', { company: '入侵公司', position: 'x' }],
    ['PATCH', '/api/applications/1', { company: '被篡改' }],
    ['DELETE', '/api/applications/1'],
    ['POST', '/api/tasks', { title: '入侵任务' }],
    ['PATCH', '/api/tasks/1', { done: true }],
    ['DELETE', '/api/tasks/1'],
    ['POST', '/api/events', { title: '入侵日程', date: '2099-01-01' }],
    ['PATCH', '/api/events/1', { title: '被篡改日程' }],
    ['DELETE', '/api/events/1'],
    ['POST', '/api/achievements', { title: '入侵成果', date: '2099-01-01' }],
    ['PATCH', '/api/achievements/1', { title: '被篡改成果' }],
    ['DELETE', '/api/achievements/1'],
    ['POST', '/api/seed/reset'],
  ];
  for (const [method, p, body] of writeAttempts) {
    const res = await client.req(method, p, { body });
    assert.equal(res.status, 401, `${method} ${p} 未登录应返回 401`);
  }

  // 登录后确认：数据未被写入、篡改、删除，种子重置未生效
  const login = await client.req('POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(login.status, 200);

  const apps = (await client.req('GET', '/api/applications')).json;
  assert.ok(apps.length >= 5, '种子投递数据应保持完整');
  assert.ok(apps.every((a) => a.company !== '入侵公司' && a.company !== '被篡改'));
  assert.ok(apps.some((a) => a.company === '阿里巴巴'), '未登录的 seed/reset 不应清空重灌数据');

  const tasks = (await client.req('GET', '/api/tasks')).json;
  assert.ok(tasks.every((t) => t.title !== '入侵任务'));

  const events = (await client.req('GET', '/api/events')).json;
  assert.ok(events.every((e) => e.title !== '入侵日程' && e.title !== '被篡改日程'));

  const achievements = (await client.req('GET', '/api/achievements')).json;
  assert.ok(achievements.every((a) => a.title !== '入侵成果' && a.title !== '被篡改成果'));
});

test('重置示例数据默认关闭：登录后 404；显式开启的隔离实例才可用；认证中间件不变', async () => {
  const client = makeClient(srv.baseUrl);
  const login = await client.req('POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  // 默认（未显式 allowSeedReset）：即使登录也不存在可调用的重置接口
  const denied = await client.req('POST', '/api/seed/reset');
  assert.equal(denied.status, 404);

  // 显式开启的隔离实例：可用且真的重置
  const demo = await startServer({ login: false, appOptions: { adminPassword: PASSWORD, allowSeedReset: true } });
  try {
    const dClient = makeClient(demo.baseUrl);
    // 未登录：认证中间件不变，仍是 401
    const unauth = await dClient.req('POST', '/api/seed/reset');
    assert.equal(unauth.status, 401);
    // 登录后：可调用，且清空手工数据重灌种子
    const dLogin = await dClient.req('POST', '/api/auth/login', { body: { password: PASSWORD } });
    assert.equal(dLogin.status, 200);
    const created = (await dClient.req('POST', '/api/tasks', { body: { title: '重置前任务', category: '生活' } })).json;
    assert.ok(created.id);
    const reset = await dClient.req('POST', '/api/seed/reset');
    assert.equal(reset.status, 200);
    assert.ok(reset.json.counts.applications >= 5);
    const tasks = (await dClient.req('GET', '/api/tasks')).json;
    assert.ok(tasks.every((t) => t.title !== '重置前任务'), '重置应清空手工数据');
  } finally {
    await demo.close();
  }
});

test('页面保护：未登录跳转登录页；登录页、静态资源、健康检查公开', async () => {
  const client = makeClient(srv.baseUrl);

  const home = await client.req('GET', '/');
  assert.equal(home.status, 302, '未登录访问首页应跳转');
  assert.equal(home.location, '/login');

  const index = await client.req('GET', '/index.html');
  assert.equal(index.status, 302, '未登录访问 index.html 应跳转');

  const loginPage = await client.req('GET', '/login');
  assert.equal(loginPage.status, 200, '登录页必须公开');
  assert.match(loginPage.text, /登录|password/i);

  // 静态资源不含业务数据，保持公开
  for (const p of ['/styles.css', '/app.js', '/login.js']) {
    const r = await client.req('GET', p);
    assert.equal(r.status, 200, `${p} 应公开可访问`);
  }

  const health = await client.req('GET', '/api/health');
  assert.equal(health.status, 200, '健康检查应公开');

  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.status, 401, '未登录的会话状态接口应返回 401');
});

test('登录：成功设置安全会话 Cookie；错误/空密码被拒绝', async () => {
  const client = makeClient(srv.baseUrl);

  const bad = await client.req('POST', '/api/auth/login', { body: { password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  assert.match(bad.json.error, /密码/);
  assert.equal(bad.setCookies.length, 0, '失败登录不应设置会话 Cookie');

  const empty = await client.req('POST', '/api/auth/login', { body: { password: '' } });
  assert.equal(empty.status, 401);

  const ok = await client.req('POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const cookieLine = ok.setCookies.find((c) => c.startsWith('ms_session='));
  assert.ok(cookieLine, '登录成功应设置会话 Cookie');
  assert.match(cookieLine, /HttpOnly/i, 'Cookie 应为 HTTP-only');
  assert.match(cookieLine, /Secure/i, 'Cookie 应带 Secure');
  assert.match(cookieLine, /SameSite=Strict/i, 'Cookie 应为 SameSite=Strict');
  assert.match(cookieLine, /Path=\//i);
  assert.match(cookieLine, /Max-Age=\d+/i);

  // 携带会话 Cookie 后可正常读取数据、访问首页
  const apps = await client.req('GET', '/api/applications');
  assert.equal(apps.status, 200);
  assert.ok(Array.isArray(apps.json));

  const home = await client.req('GET', '/');
  assert.equal(home.status, 200, '登录后访问首页不再跳转');
  assert.match(home.text, /Manager Show/);

  const me = await client.req('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.authenticated, true);
});

test('CSRF：跨站写请求被拒绝，同源写请求正常', async () => {
  const client = makeClient(srv.baseUrl);
  const login = await client.req('POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  const host = new URL(srv.baseUrl).host;

  // 伪造跨站 Origin → 403
  const evil = await client.req('POST', '/api/tasks', {
    body: { title: '跨站任务' },
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(evil.status, 403);

  // Sec-Fetch-Site: cross-site → 403
  const cross = await client.req('POST', '/api/tasks', {
    body: { title: '跨站任务2' },
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  assert.equal(cross.status, 403);

  // 同源 Origin → 正常创建
  const same = await client.req('POST', '/api/tasks', {
    body: { title: '同源任务' },
    headers: { Origin: `http://${host}` },
  });
  assert.equal(same.status, 201);

  // 确认跨站请求未写入
  const tasks = (await client.req('GET', '/api/tasks')).json;
  assert.ok(tasks.every((t) => t.title !== '跨站任务' && t.title !== '跨站任务2'));

  // 登录接口本身同样受 CSRF 校验保护
  const evilLogin = await client.req('POST', '/api/auth/login', {
    body: { password: PASSWORD },
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(evilLogin.status, 403);
});

test('登录限流：连续失败后返回 429', async () => {
  const s = await startServer({
    login: false,
    appOptions: { adminPassword: 'pw', loginMaxAttempts: 3, loginWindowMinutes: 60 },
  });
  try {
    const client = makeClient(s.baseUrl);
    for (let i = 0; i < 3; i++) {
      const r = await client.req('POST', '/api/auth/login', { body: { password: 'wrong' } });
      assert.equal(r.status, 401);
    }
    const blocked = await client.req('POST', '/api/auth/login', { body: { password: 'wrong' } });
    assert.equal(blocked.status, 429, '超过失败次数应返回 429');
    assert.ok(blocked.headers.get('retry-after'), '429 应带 Retry-After');
    assert.match(blocked.json.error, /稍后/);

    // 限流期间即使密码正确也被拦截
    const correct = await client.req('POST', '/api/auth/login', { body: { password: 'pw' } });
    assert.equal(correct.status, 429);
  } finally {
    await s.close();
  }
});

test('安全响应头：所有响应带防护头，API 禁止缓存', async () => {
  const client = makeClient(srv.baseUrl);

  const res = await client.req('GET', '/api/health');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy') || '', /default-src/);
  assert.match(res.headers.get('permissions-policy') || '', /geolocation=\(\)/);
  assert.equal(res.headers.get('cache-control'), 'no-store', 'API 响应应禁止缓存');
  assert.equal(res.headers.get('x-powered-by'), null, '不应暴露 X-Powered-By');

  const page = await client.req('GET', '/login');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff', '页面也应带安全头');
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors/);

  const notFound = await client.req('GET', '/api/不存在');
  assert.equal(notFound.headers.get('cache-control'), 'no-store');
});

test('退出登录：会话失效并清除 Cookie', async () => {
  const client = makeClient(srv.baseUrl);
  const login = await client.req('POST', '/api/auth/login', { body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal((await client.req('GET', '/api/applications')).status, 200);

  const out = await client.req('POST', '/api/auth/logout');
  assert.equal(out.status, 204);
  const cleared = out.setCookies.find((c) => c.startsWith('ms_session='));
  assert.ok(cleared, '退出应清除会话 Cookie');
  assert.match(cleared, /Max-Age=0|Expires=/i);

  assert.equal((await client.req('GET', '/api/applications')).status, 401, '退出后会话应立即失效');
  assert.equal((await client.req('GET', '/api/auth/me')).status, 401);
});

test('会话到期后自动失效', async () => {
  // 极短 TTL（约 180ms），验证过期会话被拒绝
  const s = await startServer({
    login: false,
    appOptions: { adminPassword: 'pw', sessionTtlHours: 0.00005 },
  });
  try {
    const client = makeClient(s.baseUrl);
    const login = await client.req('POST', '/api/auth/login', { body: { password: 'pw' } });
    assert.equal(login.status, 200);
    assert.equal((await client.req('GET', '/api/applications')).status, 200);

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal((await client.req('GET', '/api/applications')).status, 401, '过期会话应失效');
  } finally {
    await s.close();
  }
});

test('支持 scrypt 哈希形式的管理员密码配置（环境变量部署方式）', async () => {
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('hashed-pass', salt, 32, { N: 16384, r: 8, p: 1 });
  const stored = `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;

  const s = await startServer({ login: false, appOptions: { adminPasswordHash: stored } });
  try {
    const client = makeClient(s.baseUrl);
    const bad = await client.req('POST', '/api/auth/login', { body: { password: 'nope' } });
    assert.equal(bad.status, 401);
    const ok = await client.req('POST', '/api/auth/login', { body: { password: 'hashed-pass' } });
    assert.equal(ok.status, 200);
    assert.equal((await client.req('GET', '/api/tasks')).status, 200);
  } finally {
    await s.close();
  }
});

test('反向代理模式：信任代理后按 X-Forwarded-Proto 下发 HSTS', async () => {
  const s = await startServer({ login: false, appOptions: { adminPassword: 'pw', trustProxy: 'loopback' } });
  try {
    const client = makeClient(s.baseUrl);
    // 直连（无 X-Forwarded-Proto）不应下发 HSTS
    const plain = await client.req('GET', '/api/health');
    assert.equal(plain.headers.get('strict-transport-security'), null);

    // 代理宣告 HTTPS 后应下发 HSTS
    const proxied = await client.req('GET', '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(proxied.headers.get('strict-transport-security') || '', /max-age=/);
  } finally {
    await s.close();
  }
});

test('无任何密码配置时自动生成随机密码（安全初始化）', async (t) => {
  if (process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD) {
    t.skip('环境已设置管理员密码环境变量，跳过安全初始化测试');
    return;
  }
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const { createApp } = require('../src/app');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-sec-'));
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(' '));
  let app;
  try {
    app = createApp({ dbPath: path.join(tmpDir, 'test.db'), seed: true });
  } finally {
    console.warn = originalWarn;
  }

  const m = captured.join('\n').match(/密码[:：]\s*([A-Za-z0-9_-]{10,})/);
  assert.ok(m, '启动日志应输出生成的随机密码');

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = makeClient(baseUrl);
    const ok = await client.req('POST', '/api/auth/login', { body: { password: m[1] } });
    assert.equal(ok.status, 200, '生成的随机密码应可登录');
  } finally {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
