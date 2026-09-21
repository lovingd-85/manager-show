'use strict';

// 日期工具：全程明确 Asia/Shanghai（中国时间），不依赖主机或浏览器时区。
function pad(n) { return String(n).padStart(2, '0'); }

const cnDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

// 上海时区的「今天」（YYYY-MM-DD）。now 可注入以便测试。
function todayLocal(now = new Date()) {
  const parts = cnDateFmt.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s ||
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === s;
}

function isValidTime(s) {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}$/.test(s)) return false;
  const [h, m] = s.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// datetime-local 输入（YYYY-MM-DDTHH:MM[:SS]）明确按 +08:00 解释后转 UTC ISO。
// 先严格校验各分量再转换：非法日期/时间返回 null，绝不靠 JS Date 静默滚动
// （如 02-30 会滚成 03-02）。
function parseDateTimeLocalCN(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const datePart = s.slice(0, 10);
  if (!isValidDate(datePart)) return null;
  const timePart = s.slice(11, 16);
  if (!isValidTime(timePart)) return null;
  return new Date(s + '+08:00').toISOString();
}

function nowIso() { return new Date().toISOString(); }

module.exports = { todayLocal, addDays, isValidDate, isValidTime, parseDateTimeLocalCN, nowIso };
