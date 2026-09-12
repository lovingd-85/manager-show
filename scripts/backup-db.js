'use strict';

// 以 SQLite VACUUM INTO 创建一致性备份；由 root-owned systemd timer 调用。
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const source = process.env.MANAGER_DB || '/home/ubuntu/Manager_Show/data/manager.db';
const destinationDir = process.env.MANAGER_BACKUP_DIR || '/var/backups/manager-show';
fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = path.join(destinationDir, `manager-${stamp}.db`);
const db = new DatabaseSync(source);
try {
  // destination is generated here, never from user input.
  db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  fs.chmodSync(destination, 0o600);
  // Retain the newest 30 backups.
  const old = fs.readdirSync(destinationDir)
    .filter((f) => /^manager-.*\.db$/.test(f))
    .sort()
    .slice(0, -30);
  for (const file of old) fs.unlinkSync(path.join(destinationDir, file));
  console.log(`backup_created=${path.basename(destination)}`);
} finally {
  db.close();
}
