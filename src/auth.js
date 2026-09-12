'use strict';

// 认证与会话：
//  - 密码哈希：scrypt（格式 scrypt$N$r$p$saltHex$hashHex），校验使用恒定时间比较
//  - 会话：随机 token 存 SQLite（只存 token 的 sha256），Cookie 为 HttpOnly + Secure + SameSite=Strict
//  - 凭据解析优先级：显式参数 > 环境变量 > 数据库 settings > 首次启动生成随机密码（安全初始化）
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
const SETTING_PASSWORD_HASH = 'admin_password_hash';
const SESSION_COOKIE = 'ms_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function isHashFormat(stored) {
  return typeof stored === 'string' && stored.startsWith('scrypt$') && stored.split('$').length === 6;
}

function verifyPassword(password, stored) {
  if (!isHashFormat(stored)) return false;
  try {
    const [, n, r, p, saltHex, hashHex] = stored.split('$');
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomPassword() {
  return crypto.randomBytes(12).toString('base64url'); // 16 字符，URL 安全
}

// 确定“生效的管理员凭据”并返回 verify 函数。
// 无任何配置时执行安全初始化：生成随机密码、哈希入库、并在日志中输出一次。
function resolveCredential(db, { adminPasswordHash, adminPassword, warn = console.warn } = {}) {
  if (adminPasswordHash) {
    return { verify: (pw) => verifyPassword(pw, adminPasswordHash), source: 'env-hash' };
  }
  if (adminPassword) {
    // 明文只存在于环境变量（或测试参数），每次启动重新哈希，绝不落盘
    return { verify: (pw) => verifyPassword(pw, hashPassword(adminPassword)), source: 'env-plain' };
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_PASSWORD_HASH);
  if (row && isHashFormat(row.value)) {
    return { verify: (pw) => verifyPassword(pw, row.value), source: 'db' };
  }
  const generated = randomPassword();
  const hash = hashPassword(generated);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTING_PASSWORD_HASH, hash);
  warn([
    '============================================================',
    '[安全初始化] 未配置管理员密码，已生成随机密码（仅本次输出）：',
    `  密码: ${generated}`,
    '请立即登录并妥善保存。可用 scripts/set-password.js 修改，',
    '或设置 ADMIN_PASSWORD_HASH 环境变量（推荐，优先级最高）。',
    '============================================================',
  ].join('\n'));
  return { verify: (pw) => verifyPassword(pw, hash), source: 'generated' };
}

// SQLite 会话存储：token 只以 sha256 形式落库，泄漏数据库文件也无法伪造会话。
function createSessionStore(db, { ttlMs, now = () => new Date() }) {
  const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
  const insert = db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)');
  const select = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const pruneStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

  return {
    create() {
      const token = crypto.randomBytes(32).toString('hex');
      insert.run(tokenHash(token), now().toISOString(), new Date(now().getTime() + ttlMs).toISOString());
      return { token, maxAgeSec: Math.floor(ttlMs / 1000) };
    },
    get(token) {
      if (!token) return null;
      const row = select.get(tokenHash(token));
      if (!row) return null;
      if (row.expires_at < now().toISOString()) {
        remove.run(tokenHash(token));
        return null;
      }
      return { token };
    },
    destroy(token) {
      if (token) remove.run(tokenHash(token));
    },
    prune() {
      pruneStmt.run(now().toISOString());
    },
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(token, { maxAgeSec, secure, clear = false } = {}) {
  const parts = [`${SESSION_COOKIE}=${clear ? '' : token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${maxAgeSec}`);
  return parts.join('; ');
}

module.exports = {
  hashPassword,
  verifyPassword,
  isHashFormat,
  resolveCredential,
  createSessionStore,
  parseCookies,
  sessionCookie,
  SESSION_COOKIE,
  SETTING_PASSWORD_HASH,
};
