'use strict';

// 生成管理员密码哈希，用于 ADMIN_PASSWORD_HASH 环境变量（推荐的部署方式）。
// 用法：
//   node scripts/hash-password.js            # 从 stdin 读取（换行结束）
//   node scripts/hash-password.js '新密码'    # 直接传参（会留在 shell 历史中，仅建议临时使用）
const { hashPassword } = require('../src/auth');

function printHash(password) {
  if (!password) {
    console.error('未提供密码。用法：echo "新密码" | node scripts/hash-password.js');
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
}

const fromArg = process.argv[2];
if (fromArg) {
  printHash(fromArg);
} else {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; });
  process.stdin.on('end', () => printHash(buf.replace(/\r?\n$/, '')));
}
