'use strict';

// 输入校验：所有资源共用的小工具。返回 { ok: true, value } 或 { ok: false, error }。
const { isValidDate, isValidTime } = require('./dates');

function fail(error) { return { ok: false, error }; }
function ok(value) { return { ok: true, value }; }

function asStr(v) { return typeof v === 'string' ? v.trim() : ''; }

// 创建时的字段校验集合
function reqStr(body, field, label, maxLen = 200) {
  const v = asStr(body[field]);
  if (!v) return fail(`${label}不能为空`);
  if (v.length > maxLen) return fail(`${label}过长（最多 ${maxLen} 字）`);
  return ok(v);
}

function optStr(body, field, label, maxLen = 2000, fallback = '') {
  if (body[field] === undefined || body[field] === null) return ok(fallback);
  const v = asStr(body[field]);
  if (v.length > maxLen) return fail(`${label}过长（最多 ${maxLen} 字）`);
  return ok(v);
}

function optDate(body, field, label) {
  const v = asStr(body[field]);
  if (!v) return ok('');
  if (!isValidDate(v)) return fail(`${label}格式应为 YYYY-MM-DD`);
  return ok(v);
}

function reqDate(body, field, label) {
  const v = asStr(body[field]);
  if (!isValidDate(v)) return fail(`${label}格式应为 YYYY-MM-DD`);
  return ok(v);
}

function optTime(body, field, label) {
  const v = asStr(body[field]);
  if (!v) return ok('');
  if (!isValidTime(v)) return fail(`${label}格式应为 HH:MM`);
  return ok(v);
}

function optEnum(body, field, label, allowed, fallback) {
  if (body[field] === undefined || body[field] === null || body[field] === '') return ok(fallback);
  const v = asStr(body[field]);
  if (!allowed.includes(v)) return fail(`${label}只能是：${allowed.join(' / ')}`);
  return ok(v);
}

// PATCH 时：仅校验 body 中出现的字段
function pickDefined(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

// 依次执行字段级校验，汇总为对象
function collect(checks) {
  const value = {};
  for (const [field, result] of Object.entries(checks)) {
    if (!result.ok) return result;
    value[field] = result.value;
  }
  return ok(value);
}

module.exports = { ok, fail, asStr, reqStr, optStr, optDate, reqDate, optTime, optEnum, pickDefined, collect };
