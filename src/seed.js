'use strict';

// 可编辑示例数据：日期均相对“写入当天”计算，保证任何时候初始化演示数据都是“活的”。
const { todayLocal, addDays, nowIso } = require('./dates');

function sampleData() {
  const T = todayLocal();
  const d = (n) => addDays(T, n);
  const now = nowIso();

  const applications = [
    { company: '阿里巴巴', position: '前端开发工程师（2027 届校招）', city: '杭州', url: 'https://campus.alibaba.com', status: '面试', priority: '高', applied_at: d(-14), next_step: '三面（技术面，视频）', next_step_date: d(1), notes: '一二面已过，重点准备项目深挖与系统设计。' },
    { company: '字节跳动', position: '后端开发工程师', city: '北京', url: '', status: '笔试', priority: '高', applied_at: d(-10), next_step: '在线笔试（第二场）', next_step_date: d(0), notes: '第一场笔试 65 分，复盘动态规划错题。' },
    { company: '腾讯', position: '产品策划（技术方向）', city: '深圳', url: '', status: '已投递', priority: '中', applied_at: d(-6), next_step: '等待简历筛选结果', next_step_date: '', notes: '内推人：学长王工。' },
    { company: '美团', position: '前端开发工程师', city: '北京', url: '', status: '笔试', priority: '中', applied_at: d(-20), next_step: '笔试复盘并约面试时间', next_step_date: d(-1), notes: '笔试已过一周未跟进，需要主动询问 HR。' },
    { company: '拼多多', position: '服务端开发工程师', city: '上海', url: '', status: '已投递', priority: '低', applied_at: d(-3), next_step: '', next_step_date: '', notes: '' },
    { company: '蔚来', position: '前端开发实习生', city: '上海', url: '', status: 'Offer', priority: '高', applied_at: d(-30), next_step: '比较薪资与转正机会', next_step_date: d(6), notes: '实习 Offer 已到手，可作为校招保底对照。' },
    { company: '百度', position: '前端开发工程师', city: '北京', url: '', status: '已拒绝', priority: '低', applied_at: d(-25), next_step: '', next_step_date: '', notes: '二面挂，反馈：工程化经验不足。' },
    { company: '小红书', position: '前端开发工程师', city: '上海', url: 'https://campus.xiaohongshu.com', status: '待投递', priority: '中', applied_at: '', next_step: '官网投递截止', next_step_date: d(5), notes: '需要先更新简历到 V3。' },
  ].map((a) => ({ ...a, created_at: now, updated_at: now }));

  const tasks = [
    { title: '梳理阿里三面：项目难点与系统设计提纲', category: '求职', due_date: d(0), focus_date: d(0), done: 0, notes: '围绕实习数据看板项目准备 STAR 叙述。' },
    { title: '整理字节笔试错题集（动态规划专题）', category: '求职', due_date: d(1), focus_date: d(0), done: 0, notes: '' },
    { title: '更新简历 V3 并同步到各官网', category: '求职', due_date: d(2), focus_date: d(0), done: 0, notes: '小红书投递前必须完成。' },
    { title: '美团笔试复盘并发邮件询问进度', category: '求职', due_date: d(-1), focus_date: '', done: 0, notes: '已逾期，今天必须处理。' },
    { title: '给导师发送本周实习周报', category: '实习', due_date: d(-2), focus_date: '', done: 0, notes: '' },
    { title: '复盘蔚来 Offer 薪资与转正条款', category: '求职', due_date: d(-3), focus_date: '', done: 1, done_at: nowIso(), notes: '已整理成对比表格。' },
    { title: '健身 30 分钟', category: '生活', due_date: d(0), focus_date: '', done: 0, notes: '' },
  ].map((t) => ({ created_at: now, done_at: null, ...t }));

  const events = [
    { title: '字节跳动在线笔试（第二场）', date: d(0), start_time: '14:00', end_time: '16:00', location: '线上（牛客网）', notes: '提前 15 分钟进入，准备身份证。' },
    { title: '阿里巴巴三面（视频面试）', date: d(1), start_time: '19:00', end_time: '20:00', location: '线上（钉钉）', notes: '面试官为部门主管。' },
    { title: '实习组会：汇报数据看板进展', date: d(3), start_time: '10:00', end_time: '11:00', location: '公司 3F 会议室', notes: '' },
    { title: '小红书官网投递截止', date: d(5), start_time: '18:00', end_time: '', location: '线上', notes: '截止前提交简历 V3。' },
    { title: '职业规划咨询（学校就业中心）', date: d(7), start_time: '15:00', end_time: '16:00', location: '就业中心 201', notes: '' },
    { title: '导师周会（上周）', date: d(-1), start_time: '20:00', end_time: '21:00', location: '线上（腾讯会议）', notes: '已结束。' },
  ];

  const achievements = [
    { date: d(-2), title: '重构实习项目看板组件', category: '项目', impact: '首屏渲染耗时降低 40%', description: '将列表渲染改为虚拟滚动，并拆分重型图表组件按需加载。' },
    { date: d(-9), title: '上线实习生数据看板', category: '项目', impact: '被 3 个业务团队日常采用', description: '独立负责需求梳理、前端开发与灰度发布。' },
    { date: d(-15), title: '完成 SQL 优化专题学习', category: '学习', impact: '负责接口慢查询平均耗时 -60%', description: '为 4 个高频接口补充索引并重写联表查询。' },
    { date: d(-21), title: '独立交付运营活动页', category: '项目', impact: '活动 PV 12 万，转化率 8.2%', description: '从设计稿到上线一周内交付，无线上事故。' },
    { date: d(-30), title: '入职并搭建个人工作流', category: '成长', impact: '周报/任务/成果记录体系化', description: '建立个人管理驾驶舱的雏形（即本系统）。' },
  ].map((a) => ({ ...a, created_at: now }));

  return { applications, tasks, events, achievements };
}

function seed(db) {
  const data = sampleData();
  const insertApp = db.prepare(`INSERT INTO applications
    (company, position, city, url, status, priority, applied_at, next_step, next_step_date, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const a of data.applications) {
    insertApp.run(a.company, a.position, a.city, a.url, a.status, a.priority, a.applied_at, a.next_step, a.next_step_date, a.notes, a.created_at, a.updated_at);
  }
  const insertTask = db.prepare(`INSERT INTO tasks
    (title, category, due_date, focus_date, done, notes, created_at, done_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const t of data.tasks) {
    insertTask.run(t.title, t.category, t.due_date, t.focus_date, t.done, t.notes, t.created_at, t.done_at);
  }
  const insertEvent = db.prepare(`INSERT INTO events
    (title, date, start_time, end_time, location, notes) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const e of data.events) {
    insertEvent.run(e.title, e.date, e.start_time, e.end_time, e.location, e.notes);
  }
  const insertAch = db.prepare(`INSERT INTO achievements
    (date, title, category, impact, description, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const a of data.achievements) {
    insertAch.run(a.date, a.title, a.category, a.impact, a.description, a.created_at);
  }
}

function reset(db) {
  for (const t of ['applications', 'tasks', 'events', 'achievements']) {
    db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name = '${t}'`);
  }
  seed(db);
  return {
    applications: db.prepare('SELECT COUNT(*) AS n FROM applications').get().n,
    tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    achievements: db.prepare('SELECT COUNT(*) AS n FROM achievements').get().n,
  };
}

module.exports = { seed, reset };
