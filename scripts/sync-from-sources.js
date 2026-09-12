'use strict';

/**
 * Manager Show read-model synchronizer.
 * Canonical sources stay outside the dashboard: tracker markdown + Hermes cron.
 */
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { nowIso } = require('../src/dates');

function clean(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/[🟢🟡🔴✅]/g, '')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .trim();
}

function splitRow(line) {
  return line.trim().split('|').slice(1, -1).map((cell) => clean(cell));
}

function parseTracker(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length !== 7 || cells[0] === '公司' || /^-+$/.test(cells[0])) continue;
    rows.push({ company: cells[0], position: cells[1], appliedAt: cells[2], channel: cells[3], statusText: cells[4], timing: cells[5], updatedAt: cells[6] });
  }
  return rows;
}

function applicationStatus(text) {
  if (/新岗位投递已完成/.test(text)) return '已投递';
  if (/未通过|不匹配|流程结束|拒绝/.test(text)) return '已拒绝';
  if (/Offer/.test(text)) return 'Offer';
  if (/AI 初试待完成|面试已约|面试待完成/.test(text)) return '面试';
  if (/(?:笔试|测评)待完成/.test(text)) return '笔试';
  if (/已完成|(?:测评|笔试|面试).*(?:已过|完成)/.test(text)) return '流程完成';
  return '已投递';
}

function extractDateTime(text, fallbackYear) {
  const raw = String(text);
  const matches = [...raw.matchAll(/(?:(20\d{2})-)?(\d{1,2})\/(\d{1,2})(?:[^\d]{0,8}(\d{1,2}:\d{2}))?|(?:(20\d{2})-(\d{1,2})-(\d{1,2})(?:[^\d]{0,8}(\d{1,2}:\d{2}))?)/g)];
  if (!matches.length) return { date: '', time: '' };
  const m = matches.at(-1);
  const year = m[1] || m[5] || fallbackYear;
  const month = m[2] || m[6];
  const day = m[3] || m[7];
  const time = m[4] || m[8] || '';
  return { date: `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`, time };
}

function ensureSourceColumns(db) {
  for (const table of ['applications', 'tasks', 'events']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (!columns.includes('source')) db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'`);
    if (!columns.includes('external_key')) db.exec(`ALTER TABLE ${table} ADD COLUMN external_key TEXT NOT NULL DEFAULT ''`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_source_external_key ON ${table}(source, external_key) WHERE external_key != ''`);
  }
}

function replaceSource(db, table, source, records, columns) {
  db.prepare(`DELETE FROM ${table} WHERE source = ?`).run(source);
  if (!records.length) return;
  const sql = `INSERT INTO ${table} (${columns.join(', ')}, source, external_key) VALUES (${columns.map(() => '?').join(', ')}, ?, ?)`;
  const insert = db.prepare(sql);
  for (const record of records) insert.run(...record.values, source, record.key);
}

function deleteLegacyApplicationDuplicates(db) {
  db.prepare("DELETE FROM applications WHERE source = 'manual' AND notes LIKE '渠道：%'").run();
}

function deleteLegacyEventDuplicates(db) {
  db.prepare(`DELETE FROM events
    WHERE source = 'manual' AND EXISTS (
      SELECT 1 FROM events synced
      WHERE synced.source = 'tracker'
        AND synced.date = events.date
        AND synced.start_time = events.start_time
    )`).run();
}

function syncFromSources({ dbPath, trackerPath, cronJobsPath, now = nowIso() }) {
  const db = openDb(dbPath);
  ensureSourceColumns(db);
  const year = String(now).slice(0, 4);
  const tracker = parseTracker(fs.readFileSync(trackerPath, 'utf8'));
  const apps = tracker.map((row) => {
    const actionText = `${row.statusText} ${row.timing}`;
    const dateTime = extractDateTime(actionText, year);
    const status = applicationStatus(actionText);
    return {
      key: `${row.company}|${row.position}`,
      values: [row.company, row.position, '', '', status, /面试|笔试|测评|AI 初试/.test(`${row.statusText} ${row.timing}`) ? '高' : '中', row.appliedAt, row.statusText, dateTime.date, `渠道：${row.channel}\n${row.timing}`, now, now],
      dateTime, status, row,
    };
  });
  const trackerTasks = [];
  const trackerEvents = [];
  for (const app of apps) {
    const action = `${app.row.statusText} ${app.row.timing}`;
    const actionable = /(?:AI 初试|面试|笔试|测评)待完成|面试已约|(?:须|需要)[^。；]*投递/.test(action);
    if (!app.dateTime.date || !actionable) continue;
    const title = `${app.row.company}：${app.row.position}`;
    trackerTasks.push({ key: app.key, values: [title, '求职', app.dateTime.date, app.dateTime.date, 0, `${app.row.statusText}；${app.row.timing}`, now, null] });
    if (app.dateTime.time) trackerEvents.push({ key: app.key, values: [title, app.dateTime.date, app.dateTime.time, '', '线上/待确认', app.row.timing] });
  }

  // Cron remains the execution/reminder layer. The dashboard shows the underlying
  // action once from the tracker instead of duplicating it as task + calendar event.
  const cronTasks = [];
  const cronEvents = [];

  db.exec('BEGIN');
  try {
    deleteLegacyApplicationDuplicates(db);
    replaceSource(db, 'applications', 'tracker', apps, ['company', 'position', 'city', 'url', 'status', 'priority', 'applied_at', 'next_step', 'next_step_date', 'notes', 'created_at', 'updated_at']);
    replaceSource(db, 'tasks', 'tracker', trackerTasks, ['title', 'category', 'due_date', 'focus_date', 'done', 'notes', 'created_at', 'done_at']);
    replaceSource(db, 'events', 'tracker', trackerEvents, ['title', 'date', 'start_time', 'end_time', 'location', 'notes']);
    deleteLegacyEventDuplicates(db);
    replaceSource(db, 'tasks', 'cron', cronTasks, ['title', 'category', 'due_date', 'focus_date', 'done', 'notes', 'created_at', 'done_at']);
    replaceSource(db, 'events', 'cron', cronEvents, ['title', 'date', 'start_time', 'end_time', 'location', 'notes']);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  return { applications: apps.length, trackerTasks: trackerTasks.length, trackerEvents: trackerEvents.length, cronTasks: cronTasks.length, cronEvents: cronEvents.length };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const result = syncFromSources({
    dbPath: process.env.MANAGER_DB || path.join(root, 'data', 'manager.db'),
    trackerPath: process.env.TRACKER_PATH || '/home/ubuntu/投递追踪表.md',
    cronJobsPath: process.env.CRON_JOBS_PATH || '/home/ubuntu/.hermes/cron/jobs.json',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { parseTracker, syncFromSources };
