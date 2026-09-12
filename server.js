'use strict';

// 服务入口：node server.js 启动。数据库文件默认 data/manager.db（可用 MANAGER_DB 覆盖）。
const path = require('node:path');
const fs = require('node:fs');
const { createApp } = require('./src/app');
const { todayLocal } = require('./src/dates');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const dbPath = process.env.MANAGER_DB || path.join(__dirname, 'data', 'manager.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const app = createApp({ dbPath, seed: true });

app.listen(PORT, HOST, () => {
  console.log(`Manager Show 已启动：http://${HOST}:${PORT}  （今日：${todayLocal()}）`);
  console.log(`数据库文件：${dbPath}`);
  console.log(`登录页：http://${HOST}:${PORT}/login  （管理员密码通过 ADMIN_PASSWORD_HASH 环境变量配置，未配置时见上方首次启动输出）`);
});
