'use strict';

// 提醒服务：entity_key 不持有会被同步脚本重建的自增 id。
// 手工记录 → manual:<id>；同步记录 → <source>:<external_key>（source 列存在时才可引用）。
// 无稳定 external_key 的同步记录不可设置独立提醒（由调用方提示复制为个人待办）。

const ACTIVE_STATUSES = ['scheduled', 'unread'];

function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// 解析实体键：manual:<id> 或 <source>:<external_key>；非法返回 null
function parseEntityKey(key) {
  if (typeof key !== 'string') return null;
  const m = /^manual:(\d+)$/.exec(key);
  if (m) return { kind: 'manual', id: Number(m[1]) };
  const i = key.indexOf(':');
  if (i > 0) {
    const source = key.slice(0, i);
    const externalKey = key.slice(i + 1);
    if (source && externalKey) return { kind: 'source', source, externalKey };
  }
  return null;
}

function hasSourceColumns(db, table) {
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r) => r.name);
  return cols.includes('source') && cols.includes('external_key');
}

// 解析实体：返回实体行；不存在返回 null；无法判断（同步键但表无 source 列）返回 undefined
function resolveEntity(db, entityType, key) {
  const parsed = parseEntityKey(key);
  if (!parsed) return undefined;
  const table = entityType === 'task' ? 'tasks' : 'events';
  if (parsed.kind === 'manual') {
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(parsed.id) || null;
  }
  if (!hasSourceColumns(db, table)) return undefined;
  return db.prepare(`SELECT * FROM ${table} WHERE source = ? AND external_key = ?`)
    .get(parsed.source, parsed.externalKey) || null;
}

// 严格解析提醒时间：必须带时区（Z 或 ±HH:MM），返回规范化 UTC ISO；非法返回 null。
// 正则只保证格式，Date.parse 排除 2026-02-30 这类滚动日期。
function parseRemindAt(value) {
  if (typeof value !== 'string') return null;
  if (!/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// 一条记录的全部稳定键（手工 id + 可能的同步键），用于删除/完成时取消提醒
function activeKeysFor(entityType, row) {
  const keys = [`manual:${row.id}`];
  if (row.source && row.external_key) keys.push(`${row.source}:${row.external_key}`);
  return keys;
}

// 取消某实体的全部活跃提醒（scheduled/unread → cancelled）
function cancelActiveForEntity(db, entityType, keys) {
  const stmt = db.prepare(
    `UPDATE reminders SET status = 'cancelled'
     WHERE entity_type = ? AND entity_key = ? AND status IN ('scheduled', 'unread')`,
  );
  for (const key of keys) stmt.run(entityType, key);
}

// 到点的 scheduled → unread（记录触发时间）；重复调用不重复触发（已 unread 的不再匹配）
function activateDue(db, now) {
  return db.prepare(
    `UPDATE reminders SET status = 'unread', triggered_at = ?
     WHERE status = 'scheduled' AND remind_at <= ?`,
  ).run(now, now).changes;
}

// 清理无效提醒：实体已删除，或任务已完成 → 取消活跃提醒。
// 同步键在表无 source 列时无法判断，保持原状（由同步脚本补齐列后下次 GET 清理）。
function cancelInvalid(db) {
  const active = db.prepare(
    `SELECT * FROM reminders WHERE status IN ('scheduled', 'unread')`,
  ).all();
  for (const r of active) {
    const entity = resolveEntity(db, r.entity_type, r.entity_key);
    if (entity === undefined) continue;
    if (!entity || (r.entity_type === 'task' && entity.done)) {
      cancelActiveForEntity(db, r.entity_type, [r.entity_key]);
    }
  }
}

module.exports = {
  ACTIVE_STATUSES,
  withTransaction,
  parseEntityKey,
  parseRemindAt,
  hasSourceColumns,
  resolveEntity,
  activeKeysFor,
  cancelActiveForEntity,
  activateDue,
  cancelInvalid,
};
