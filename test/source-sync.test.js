'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDb } = require('../src/db');
const { syncFromSources } = require('../scripts/sync-from-sources');

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-show-sync-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('同步器只把未完成的求职流程呈现为待办和正式日程', () => {
  const tracker = tempFile('tracker.md', [
    '# 校招投递追踪表',
    '| 公司 | 岗位 | 投递日期 | 渠道 | 当前状态 | 关键时间节点 | 最近更新 |',
    '|---|---|---|---|---|---|---|',
    '| 测试公司 | 算法工程师 | 2026-09-01 | 官网 | ✅ 视频面试已完成（9/9 16:00） | 等待后续通知 | 2026-09-09 |',
    '| 京东 | 算法工程师 | 2026-09-09 | 官网 | 🟢 在线专业笔试待参加 | 9/19 19:00–21:00 在线专业笔试（全程摄像头） | 2026-09-18 |',
    '| 长鑫 | 算法工程师 | 2026-09-07 | 官网 | 🟡 在线人才测评待完成 | AI 初试已完成；最晚 9/14 23:59 完成在线测评 | 2026-09-07 |',
    '| 米哈游 | 算法研究员 | 2026-09-03 | 官网 | 🟡 获新岗位投递邀请 | 新岗位邀请须于 9/12 17:55 前投递 | 2026-09-10 |',
    '| 米哈游完成 | 算法研究员 | 2026-09-03 | 官网 | 🔴 原岗位未通过；✅ 新岗位投递已完成 | 等待后续通知 | 2026-09-10 |',
    '| 人保 | 科技运营 | 2026-09-02 | 官网 | 🟢 投递成功 | 面试时出示二维码 | 2026-09-02 |',
    '| 联想 | NLP工程师 | 2026-09-06 | 官网 | 🟢 已投递（下一步：测评） | — | 2026-09-06 |',
  ].join('\n'));
  const cron = tempFile('jobs.json', JSON.stringify({ jobs: [{
    id: 'cron-1', name: '面试前检查', enabled: true,
    schedule: { kind: 'once', run_at: '2026-09-09T15:40:00+08:00' }, prompt: '测试提醒',
  }]}));
  const dbPath = path.join(path.dirname(tracker), 'manager.db');
  const legacy = openDb(dbPath);
  legacy.prepare(`INSERT INTO applications
    (company, position, city, url, status, priority, applied_at, next_step, next_step_date, notes, created_at, updated_at)
    VALUES (?, ?, '', '', '面试', '高', '2026-09-01', '', '', '渠道：官网\n旧导入副本', 'x', 'x')`)
    .run('测试公司', '算法工程师');
  legacy.close();

  const result = syncFromSources({ dbPath, trackerPath: tracker, cronJobsPath: cron, now: '2026-09-10T08:00:00+08:00' });
  assert.deepEqual(result, { applications: 7, trackerTasks: 3, trackerEvents: 3, cronTasks: 0, cronEvents: 0 });

  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT count(*) AS n FROM applications WHERE company='测试公司' AND position='算法工程师'").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM applications WHERE company='测试公司'").get().status, '流程完成');
  const jd = db.prepare("SELECT company, next_step_date FROM applications WHERE company='京东'").get();
  assert.equal(jd.company, '京东');
  assert.equal(jd.next_step_date, '2026-09-19');
  assert.equal(db.prepare("SELECT status FROM applications WHERE company='米哈游完成'").get().status, '已投递');
  assert.equal(db.prepare("SELECT status FROM applications WHERE company='人保'").get().status, '已投递');
  assert.equal(db.prepare("SELECT status FROM applications WHERE company='联想'").get().status, '已投递');
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker'").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='cron'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE source='tracker'").get().n, 3);
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE source='cron'").get().n, 0);
  db.close();
});

// 只有真正存在待办动作时，追踪表里的日期才是"下一步日期"。
// 否则过去的日期（投递确认日、双选会开始日、已完成事项的日期）会被首页当成"超期风险"报警。
test('没有待办动作的投递不产生下一步日期，有待办动作的保留日期', () => {
  const tracker = tempFile('tracker.md', [
    '# 校招投递追踪表',
    '| 公司 | 岗位 | 投递日期 | 渠道 | 当前状态 | 关键时间节点 | 最近更新 |',
    '|---|---|---|---|---|---|---|',
    '| 待动作公司 | 算法工程师 | 2026-09-01 | 官网 | 🟢 在线专业笔试待参加 | 9/25 19:00 在线专业笔试 | 2026-09-20 |',
    '| 已递确认公司 | 算法工程师 | 2026-09-01 | 官网 | 🟢 已投递确认，等待筛选 | 9/3 收到投递成功通知 | 2026-09-03 |',
    '| 完成公司 | 算法工程师 | 2026-09-01 | 官网 | ✅ 在线笔试已完成 | 9/17 在线笔试已完成，等待复筛 | 2026-09-17 |',
  ].join('\n'));
  const cron = tempFile('jobs.json', JSON.stringify({ jobs: [] }));
  const dbPath = path.join(path.dirname(tracker), 'manager.db');

  syncFromSources({ dbPath, trackerPath: tracker, cronJobsPath: cron, now: '2026-09-22T08:00:00+08:00' });

  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT next_step_date FROM applications WHERE company='待动作公司'").get().next_step_date, '2026-09-25');
  assert.equal(db.prepare("SELECT next_step_date FROM applications WHERE company='已递确认公司'").get().next_step_date, '');
  assert.equal(db.prepare("SELECT next_step_date FROM applications WHERE company='完成公司'").get().next_step_date, '');
  assert.equal(db.prepare("SELECT count(*) AS n FROM applications WHERE next_step_date != '' AND next_step_date < '2026-09-22'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source='tracker'").get().n, 1);   // 只有待动作公司生成待办
  db.close();
});
