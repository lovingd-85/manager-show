'use strict';

// 同步器需要保留人工勾选的完成状态：否则界面上的「完成」每 15 分钟被同步打回，
// 用户无法真正结束一条由追踪表生成的待办。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { syncFromSources } = require('../scripts/sync-from-sources');

const HEAD = [
  '# 校招投递追踪表',
  '| 公司 | 岗位 | 投递日期 | 渠道 | 当前状态 | 关键时间节点 | 最近更新 |',
  '|---|---|---|---|---|---|---|',
];
const JD = '| 京东 | 算法工程师 | 2026-09-09 | 官网 | 🟢 在线专业笔试待参加 | 9/19 19:00–21:00 在线专业笔试（全程摄像头） | 2026-09-18 |';
const CX = '| 长鑫 | 算法工程师 | 2026-09-07 | 官网 | 🟡 在线人才测评待完成 | AI 初试已完成；最晚 9/14 23:59 完成在线测评 | 2026-09-07 |';

function setup(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-sync-done-'));
  const trackerPath = path.join(dir, 'tracker.md');
  fs.writeFileSync(trackerPath, [...HEAD, ...rows].join('\n'), 'utf8');
  const cronJobsPath = path.join(dir, 'jobs.json');
  fs.writeFileSync(cronJobsPath, JSON.stringify({ jobs: [] }), 'utf8');
  return { dbPath: path.join(dir, 'manager.db'), trackerPath, cronJobsPath };
}

test('同步保留人工勾选的完成状态，且不复活已从追踪表移除的条目', () => {
  const now = '2026-09-20T08:00:00+08:00';
  const { dbPath, trackerPath, cronJobsPath } = setup([JD, CX]);

  // 第一次同步：两条可操作流程各自生成待办，均为未完成
  syncFromSources({ dbPath, trackerPath, cronJobsPath, now });
  let db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker'").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker' AND done=0").get().n, 2);

  // 用户勾选京东这条为已完成
  db.prepare("UPDATE tasks SET done=1, done_at='2026-09-20T09:00:00Z' WHERE source='tracker' AND title LIKE '京东%'").run();
  assert.equal(db.prepare("SELECT done FROM tasks WHERE source='tracker' AND title LIKE '京东%'").get().done, 1);
  db.close();

  // 第二次同步（同一份追踪表）：完成状态必须保留，另一条不受影响
  syncFromSources({ dbPath, trackerPath, cronJobsPath, now });
  db = new DatabaseSync(dbPath);
  const jd = db.prepare("SELECT done, done_at FROM tasks WHERE source='tracker' AND title LIKE '京东%'").get();
  assert.equal(jd.done, 1, '已勾选的完成状态被同步重置了');
  assert.equal(jd.done_at, '2026-09-20T09:00:00Z', '完成时间被同步清空了');
  assert.equal(db.prepare("SELECT done FROM tasks WHERE source='tracker' AND title LIKE '长鑫%'").get().done, 0);
  db.close();

  // 第三次同步：追踪表里删掉的条目仍然要被删除（保留状态不能变成"不再删除"）
  fs.writeFileSync(trackerPath, [...HEAD, JD].join('\n'), 'utf8');
  syncFromSources({ dbPath, trackerPath, cronJobsPath, now });
  db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker' AND title LIKE '长鑫%'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker' AND title LIKE '京东%'").get().n, 1);
  db.close();
});

test('未勾选的新条目仍以未完成插入', () => {
  const now = '2026-09-20T08:00:00+08:00';
  const { dbPath, trackerPath, cronJobsPath } = setup([JD]);

  syncFromSources({ dbPath, trackerPath, cronJobsPath, now });
  syncFromSources({ dbPath, trackerPath, cronJobsPath, now });   // 再跑一次，未勾选不应变成已完成

  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT done, done_at FROM tasks WHERE source='tracker'").get();
  assert.equal(row.done, 0);
  assert.equal(row.done_at, null);
  db.close();
});
