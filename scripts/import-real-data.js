'use strict';

// 将 /home/ubuntu/投递追踪表.md（2026-09-08）中已确认的信息写入 Manager Show。
// 仅使用追踪表内明确出现的数据；未知城市、链接和后续日期保持为空，不做猜测。
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { nowIso } = require('../src/dates');

const dbPath = path.resolve(__dirname, '..', 'data', 'manager.db');
const backupPath = path.resolve(__dirname, '..', 'data', `manager.before-real-import-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);

const applications = [
  ['腾讯', '（待补充）', '2026-08', '校招官网', '已投递', '等待后续通知', '', '综合素质测评已过；测评于 9 月初完成。', '中'],
  ['阳光电源', '算法工程师·27届校招', '2026-08', '官网', '面试', '视频面试', '2026-09-09', '已约 9/9 16:00 视频面试（约 1 小时）；腾讯会议链接见原始投递追踪表，Moka 可改约 2 次。', '高'],
  ['地平线', '深度学习模型开发工程师-mono', '2026-08', '官网+内推码 ogyqlc', '已拒绝', '', '', '面试未通过，09-01 收到致谢函；简历已入人才库，可留意后续岗位。', '中'],
  ['科大讯飞', '（待补充）', '2026-08', 'iflytek.zhiye.com', '已投递', '等待筛选', '', '已投递确认。', '中'],
  ['作业帮', '大模型算法工程师（自然语言）·27秋招', '2026-08', 'Moka系统', '已投递', '等待筛选', '', '已投递确认。', '高'],
  ['智联·西北五省双选会', '多岗位', '2026-09', 'sxh.zhaopin.com/mix/web/jobfair/details/18879', '已投递', '双选会进行中', '2026-11-30', '双选会进行期：2026-09-01 至 2026-11-30。', '低'],
  ['人保财险', '总公司科技类-科技运营岗·2027届校招（J78700）', '2026-09-02', '校招官网，第1志愿', '已投递', '面试时出示应聘二维码', '', '投递成功，已保存应聘二维码。', '中'],
  ['群核科技（酷家乐）', '科研算法工程师（大模型与AIGC方向）·27届校招', '2026-09-02', '招聘官网', '已投递', '等待筛选', '', '申请成功，静待佳音。', '高'],
  ['诺瓦星云', '大模型算法工程师（西安）+算法工程师（西安）·27届校招', '2026-09-02', '官网投递，短信确认', '已投递', '两岗筛选', '', '简历已收到；完善简历已于 9/3 完成，原截止 9/9。', '中'],
  ['舜宇集团', '机器学习-杭州·27届校招', '2026-09-02', 'Moka代发测评邮件', '已投递', '等待测评结果', '', '测评已于 9/2 晚完成，结果决定是否晋级。', '中'],
  ['酷睿程（大众×地平线合资）', '智能驾驶算法工程师-深度学习方向·第1志愿', '2026-09-02', '校招官网', '笔试', '完成心理测评', '2026-09-10', '在线笔试 9/8 19:00–20:20；心理测评截止 9/10 23:59，约 85 分钟。', '高'],
  ['三星电子（SRCB）', '多模态大模型算法工程师 + 自然语言处理算法工程师·27届校招', '2026-09-02', '校招官网', '已投递', '等待初筛', '', '两岗均已投递；NLP 岗处于简历初筛-评估中。', '高'],
  ['满帮集团', '算法工程师·27届校招', '2026-09-03', '校招官网', '已投递', '等待筛选', '', '已投递。', '高'],
  ['携程（Trip.com Group）', '算法工程师（NLP方向）·27届秋招（MJ036676，AI&BI部门）', '2026-09-03', '招聘门户', '已投递', '等待后续通知', '', '能力测评与 AI 视频面试均已完成；AI 面试于 9/8 完成。', '高'],
  ['米哈游（miHoYo）', '基础研究-LLM Post-train 算法研究员·27届校招', '2026-09-03', '校招官网', '已投递', '等待筛选', '', '投递成功；联系邮箱 campus@mihoyo.com。', '高'],
  ['网易（雷火事业群）', 'AI算法工程师（Agent与强化学习方向；LLM Agent方向）·27届秋招', '2026-09-03', '校招官网', '已投递', '等待筛选', '', '第 1 志愿为 Agent 与强化学习方向，第 2 志愿为 LLM Agent 方向。', '高'],
  ['网易（互娱事业群）', 'AI研究工程师 + AI Agent工程师·游戏研发方向·27届校招', '2026-09-03', '互娱校招官网', '已投递', '等待筛选', '', '第 1 志愿 AI 研究工程师，第 2 志愿 AI Agent 工程师。', '高'],
  ['中国电信', 'AI工程师（南京）+ AI研发工程师（南京秦淮区）·27届校招', '2026-09-03', '校招官网', '已投递', '等待筛选', '', '第 1 志愿 AI 工程师；第 2 志愿 AI 研发工程师；简历 100% 完善。', '中'],
  ['九号公司', '九号星-AI应用开发工程师（集团-信息化）·27届校招', '2026-09-03', '校招官网（Moka代发确认）', '已投递', '等待筛选', '', '9/3 收到投递确认。', '中'],
  ['智加科技（PlusAI）', '自动驾驶算法工程师·27届校招', '2026-09-06', '招聘官网', '已投递', '等待筛选', '', '申请成功，静待佳音。', '高'],
  ['滴滴（国际外卖·DiDi Food部门）', 'AI算法工程师·27届秋招', '2026-09-06', '招聘平台', '已投递', '简历筛选中', '', '简历筛选中。', '高'],
  ['小米', '大语言模型算法工程师 + AI算法工程师-AICoding/Agents方向·27届校招', '2026-09-06', '官网', '已投递', '等待下一阶段通知', '', '第 1 志愿测评已于 9/7 晚完成。', '高'],
  ['快手', '推荐大模型算法工程师·27届校招', '2026-09-06', '官网', '已投递', '等待筛选', '', '杭州岗位；简历阶段进行中。', '高'],
  ['Shopee（虾皮）', '算法工程师-AIGC基模方向·27届秋招', '2026-09-06', '招聘系统', '已投递', '初筛阶段', '', '流程：初筛→笔试→初试→复试→加面→HR面。', '高'],
  ['贝壳（Beike）', '大模型算法工程师·27届秋招（J72259）', '2026-09-06', '官网', '已投递', '简历初筛-处理中', '', '简历初筛处理中。', '高'],
  ['联想（Lenovo）', '自然语言处理工程师（技术研究类·IDG/CTO组织）·27届校招', '2026-09-06', '官网', '已投递', '测评', '', '已投递；下一步为测评。', '中'],
  ['字节跳动（ByteDance）', '多模态大模型算法工程师（TikTok内容安全·北京）+ 大模型算法工程师（TikTok研发·上海）·27届校招', '2026-09-06', '校招官网', '已投递', '研发岗等待筛选', '', '内容安全岗不匹配，9/7 流程结束并入人才库；研发岗等待筛选。', '高'],
  ['长鑫存储（CXMT）', '大模型/智能体研究员（J20778）+ AI研究员（J20761）·27届校招', '2026-09-07', '校招官网', '面试', '远程 AI 面试', '2026-09-14', '9/7 21:11 收到邀请；最晚 9/14 23:59 完成远程 AI 面试。', '高'],
  ['蔚来汽车（NIO）', '座舱大模型后训练/Agentic 算法工程师 + 大模型与智能体开发工程师 + 大模型工程师·27届校招', '2026-09-08', '官网', '已投递', '等待筛选', '', '已投 3 岗；岗位城市与调剂意向详见原始投递追踪表。', '高'],
];

const tasks = [
  ['参加阳光电源视频面试', '求职', '2026-09-09', '2026-09-09', 0, '16:00 视频面试，预计 1 小时。'],
  ['完成酷睿程心理测评', '求职', '2026-09-10', '', 0, '心理测评截止 9/10 23:59，约 85 分钟。'],
  ['完成长鑫存储远程 AI 面试', '求职', '2026-09-14', '', 0, '最晚 9/14 23:59 完成。'],
  ['留意地平线人才库后续岗位', '求职', '', '', 0, '原深度学习模型开发工程师-mono 面试未通过，后续岗位自动匹配。'],
];

const events = [
  ['阳光电源视频面试', '2026-09-09', '16:00', '17:00', '线上', '约 1 小时；腾讯会议链接见原始投递追踪表。'],
  ['酷睿程在线笔试', '2026-09-08', '19:00', '20:20', '线上', '电脑、Chrome、身份证、摄像头；原定 9/8。'],
];

const achievements = [
  ['2026-09-08', '蚂蚁集团百灵组：模型推理/架构优化', '项目', '项目收尾阶段', '投递追踪表记录的当前实习内容。'],
  ['2026-09-08', '吉利集团：OPD（on-policy RL）', '项目', '进行中，工作日白天', '投递追踪表记录的当前实习内容。'],
];

if (!fs.existsSync(dbPath)) throw new Error(`未找到数据库：${dbPath}`);
fs.copyFileSync(dbPath, backupPath);
const db = openDb(dbPath);
const now = nowIso();

try {
  db.exec('BEGIN');
  for (const table of ['applications', 'tasks', 'events', 'achievements']) db.exec(`DELETE FROM ${table}`);
  for (const table of ['applications', 'tasks', 'events', 'achievements']) db.exec(`DELETE FROM sqlite_sequence WHERE name = '${table}'`);

  const insertApp = db.prepare(`INSERT INTO applications
    (company, position, city, url, status, priority, applied_at, next_step, next_step_date, notes, created_at, updated_at)
    VALUES (?, ?, '', '', ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [company, position, appliedAt, channel, status, nextStep, nextStepDate, note, priority] of applications) {
    insertApp.run(company, position, status, priority, appliedAt, nextStep, nextStepDate, `渠道：${channel}\n${note}`, now, now);
  }

  const insertTask = db.prepare('INSERT INTO tasks (title, category, due_date, focus_date, done, notes, created_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)');
  for (const t of tasks) insertTask.run(...t, now);

  const insertEvent = db.prepare('INSERT INTO events (title, date, start_time, end_time, location, notes) VALUES (?, ?, ?, ?, ?, ?)');
  for (const e of events) insertEvent.run(...e);

  const insertAchievement = db.prepare('INSERT INTO achievements (date, title, category, impact, description, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const a of achievements) insertAchievement.run(...a, now);
  db.exec('COMMIT');

  const counts = Object.fromEntries(['applications', 'tasks', 'events', 'achievements'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  console.log(JSON.stringify({ imported: counts, backup: backupPath }, null, 2));
} catch (error) {
  try { db.exec('ROLLBACK'); } catch {}
  throw error;
} finally {
  db.close();
}
