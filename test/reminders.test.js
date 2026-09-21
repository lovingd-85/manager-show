'use strict';

// 提醒持久化：独立表、幂等迁移、活跃提醒唯一约束（6A 范围：数据层）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-rem-'));
  return path.join(dir, 'test.db');
}

test('提醒表：空库自动建表、列与索引齐全', () => {
  const db = openDb(tmpDb());
  const cols = db.prepare("SELECT name FROM pragma_table_info('reminders')").all().map((r) => r.name);
  for (const c of ['id', 'entity_type', 'entity_key', 'remind_at', 'status', 'created_at', 'triggered_at', 'read_at']) {
    assert.ok(cols.includes(c), `reminders 缺少列 ${c}`);
  }
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminders'")
    .all().map((r) => r.name);
  assert.ok(idx.includes('reminders_due'), '缺少 reminders_due 索引');
  assert.ok(idx.includes('reminders_active_entity'), '缺少 reminders_active_entity 唯一索引');
  db.close();
});

test('提醒迁移：既有旧 schema 不丢行，重复迁移幂等', () => {
  const dbPath = tmpDb();
  // 旧 schema（无 reminders 表）先写入既有行
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '其他',
    due_date TEXT NOT NULL DEFAULT '',
    focus_date TEXT NOT NULL DEFAULT '',
    done INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    done_at TEXT
  )`);
  old.prepare('INSERT INTO tasks (title, category, due_date, focus_date, done, notes, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
    .run('既有任务', '生活', '', '', 0, '', '2026-09-20T00:00:00.000Z');
  old.close();

  // 重复 openDb（迁移执行两次）不报错、既有行保留
  const db1 = openDb(dbPath);
  const db2 = openDb(dbPath);
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, '迁移不得丢既有行');
  assert.equal(db2.prepare('SELECT title FROM tasks').get().title, '既有任务');
  db1.close();
  db2.close();
});

test('提醒唯一约束：同一实体同时只有一个活跃提醒', () => {
  const db = openDb(tmpDb());
  const insert = db.prepare('INSERT INTO reminders (entity_type, entity_key, remind_at, status, created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run('task', 'manual:1', '2030-01-01T00:00:00.000Z', 'scheduled', '2026-09-22T00:00:00.000Z');
  // 同一实体再插入活跃提醒 → 唯一约束拒绝
  assert.throws(
    () => insert.run('task', 'manual:1', '2030-01-02T00:00:00.000Z', 'scheduled', '2026-09-22T00:00:00.000Z'),
    /UNIQUE/i,
  );
  // 取消后可重新设置（read 状态同样不占活跃位）
  db.prepare("UPDATE reminders SET status = 'cancelled' WHERE entity_key = 'manual:1'").run();
  insert.run('task', 'manual:1', '2030-01-02T00:00:00.000Z', 'scheduled', '2026-09-22T00:00:00.000Z');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_key = 'manual:1'").get().n, 2);
  db.close();
});
