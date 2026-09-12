'use strict';

// 修改数据库中保存的管理员密码哈希（无需重启即可轮换密码）。
// 用法：echo "新密码" | node scripts/set-password.js   （可用 MANAGER_DB 指定数据库文件）
// 注意：若设置了 ADMIN_PASSWORD_HASH / ADMIN_PASSWORD 环境变量，登录仍以环境变量为准。
const path = require('node:path');
const { openDb } = require('../src/db');
const { hashPassword, SETTING_PASSWORD_HASH } = require('../src/auth');

const dbPath = process.env.MANAGER_DB || path.join(__dirname, '..', 'data', 'manager.db');
const db = openDb(dbPath);

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  const password = buf.replace(/\r?\n$/, '');
  if (!password) {
    console.error('未提供密码。用法：echo "新密码" | node scripts/set-password.js');
    process.exit(1);
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SETTING_PASSWORD_HASH, hashPassword(password));
  console.log(`已更新管理员密码（数据库 ${dbPath} 的 settings.${SETTING_PASSWORD_HASH}）。`);
  process.exit(0);
});
