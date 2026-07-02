'use strict';

/**
 * IRDRC HUB - zero-dependency Node.js application server.
 * Data is persisted to data/db.json. For production, replace this JSON store
 * with PostgreSQL/MySQL and persist sessions in a durable session store.
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const ROOT = __dirname;
readEnvFile();
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const COOKIE_NAME = process.env.SESSION_COOKIE || 'irdrc_hub_session';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_BODY_BYTES = 1024 * 1024;

const Roles = Object.freeze({
  ADMIN: 'Admin',
  LEADER: 'Lãnh đạo Viện',
  STAFF: 'Nhân sự Viện',
  COLLAB: 'Cộng tác viên'
});

const TaskStatus = Object.freeze({
  NEW: 'NEW',
  IN_PROGRESS: 'IN_PROGRESS',
  PENDING: 'PENDING',
  DONE: 'DONE',
  ADJUSTMENT: 'ADJUSTMENT',
  REVIEW_REJECTED: 'REVIEW_REJECTED'
});

const GROUPS = [
  'Nghiên cứu',
  'Tư vấn',
  'Quản lý vận hành',
  'Tập huấn',
  'Hội nghị/Hội thảo',
  'Công bố quốc tế'
];

const PRIORITIES = ['Cao', 'Trung bình', 'Thấp'];
let db = null;
const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function addDays(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function uuid(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function readEnvFile() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  const rows = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const row of rows) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, packed) {
  const [salt, hash] = String(packed || '').split(':');
  if (!salt || !hash) return false;
  const derived = await scrypt(password, salt, 64);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(derived.toString('hex'), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeUser(user, details = false) {
  if (!user) return null;
  const base = {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    initials: user.initials || initials(user.name),
    active: user.active !== false
  };
  if (details) {
    Object.assign(base, {
      birthDate: user.birthDate || '',
      degree: user.degree || '',
      academicRank: user.academicRank || '',
      occupation: user.occupation || '',
      unit: user.unit || '',
      hometown: user.hometown || '',
      createdAt: user.createdAt || ''
    });
  }
  return base;
}

function initials(name = '') {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'IR';
}

async function persistDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, DB_FILE);
}

function userByUsername(username) {
  return db.users.find((user) => user.username.toLowerCase() === String(username).toLowerCase());
}

function userById(id) {
  return db.users.find((user) => user.id === id);
}

function projectById(id) {
  return db.projects.find((project) => project.id === id);
}

function taskById(id) {
  return db.tasks.find((task) => task.id === id);
}

function isWorker(user) {
  return [Roles.ADMIN, Roles.LEADER, Roles.STAFF].includes(user.role);
}

function canViewProject(user, project) {
  if (!project || !user) return false;
  if (user.role === Roles.ADMIN) return true;
  return [project.ownerId, ...(project.coLeadIds || []), ...(project.memberIds || [])].includes(user.id);
}

function canEditProject(user, project) {
  if (!project || !user || !isWorker(user)) return false;
  return project.ownerId === user.id || (project.coLeadIds || []).includes(user.id);
}

function canViewTask(user, task) {
  if (!task || !user) return false;
  if (user.role === Roles.ADMIN) return true;
  if ([task.assignerId, task.assigneeId].includes(user.id)) return true;
  const project = projectById(task.projectId);
  return Boolean(project && canViewProject(user, project));
}

function canEditTask(user, task) {
  return Boolean(user && task && isWorker(user) && task.assignerId === user.id);
}

function taskStatusLabel(status) {
  return {
    [TaskStatus.NEW]: 'Mới giao',
    [TaskStatus.IN_PROGRESS]: 'Đang làm',
    [TaskStatus.PENDING]: 'Công việc chờ duyệt',
    [TaskStatus.DONE]: 'Hoàn thành',
    [TaskStatus.ADJUSTMENT]: 'Chờ điều chỉnh',
    [TaskStatus.REVIEW_REJECTED]: 'Không duyệt'
  }[status] || status;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function asText(value, max = 5000) {
  return String(value || '').trim().slice(0, max);
}

function asIdArray(value) {
  return [...new Set(ensureArray(value).map((item) => asText(item, 100)).filter(Boolean))];
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function validateUserReferences(ids) {
  return ids.every((id) => Boolean(userById(id)));
}

function appendActivity(task, actorId, type, note = '') {
  task.activity = ensureArray(task.activity);
  task.activity.push({
    id: uuid('act'),
    at: nowIso(),
    actorId,
    type,
    note: asText(note, 2000)
  });
}

async function seedDatabase() {
  const now = nowIso();
  const users = [
    { id: 'u-admin', username: 'admin', password: 'admin123', name: 'Quản trị viên IRDRC HUB', role: Roles.ADMIN, birthDate: '1988-01-01', degree: 'Thạc sĩ', academicRank: '', occupation: 'Quản trị hệ thống', unit: 'IRDRC - UEH', hometown: 'TP.HCM' },
    { id: 'u-lead-vien', username: 'lanhdao.vien', password: 'LanhDao@2026', name: 'Lãnh đạo Viện', role: Roles.LEADER, birthDate: '1975-05-20', degree: 'Tiến sĩ', academicRank: 'PGS.', occupation: 'Lãnh đạo đơn vị', unit: 'IRDRC - UEH', hometown: 'TP.HCM' },
    { id: 'u-dc-khai', username: 'dc.khai', password: 'Khai@2026', name: 'Đinh Công Khải', role: Roles.LEADER, birthDate: '1980-08-15', degree: 'Tiến sĩ', academicRank: '', occupation: 'Lãnh đạo/Điều phối', unit: 'IRDRC - UEH', hometown: 'Đồng Tháp' },
    { id: 'u-nk-duc', username: 'nk.duc', password: 'Duc@2026', name: 'Nguyễn Khánh Đức', role: Roles.LEADER, birthDate: '1983-10-12', degree: 'Thạc sĩ', academicRank: '', occupation: 'Lãnh đạo/Điều phối', unit: 'IRDRC - UEH', hometown: 'Hà Nội' },
    { id: 'u-pt-dung', username: 'pt.dung', password: 'Dung@2026', name: 'PT Dũng', role: Roles.STAFF, birthDate: '1990-03-08', degree: 'Thạc sĩ', academicRank: '', occupation: 'Nghiên cứu viên', unit: 'IRDRC - UEH', hometown: 'TP.HCM' },
    { id: 'u-thl-vu', username: 'thl.vu', password: 'Vu@2026', name: 'THL Vũ', role: Roles.STAFF, birthDate: '1992-07-19', degree: 'Thạc sĩ', academicRank: '', occupation: 'Nghiên cứu viên', unit: 'IRDRC - UEH', hometown: 'Cà Mau' },
    { id: 'u-ntq-tram', username: 'ntq.tram', password: 'Tram@2026', name: 'NTQ Trâm', role: Roles.STAFF, birthDate: '1995-11-10', degree: 'Cử nhân', academicRank: '', occupation: 'Chuyên viên dữ liệu', unit: 'IRDRC - UEH', hometown: 'Vĩnh Long' },
    { id: 'u-v-son', username: 'v.son', password: 'Son@2026', name: 'V Sơn', role: Roles.COLLAB, birthDate: '1994-05-06', degree: 'Cử nhân', academicRank: '', occupation: 'Cộng tác viên truyền thông', unit: 'IRDRC - UEH', hometown: 'TP.HCM' },
    { id: 'u-ntt-linh', username: 'ntt.linh', password: 'Linh@2026', name: 'NTT Linh', role: Roles.COLLAB, birthDate: '1996-12-20', degree: 'Cử nhân', academicRank: '', occupation: 'Cộng tác viên tổng hợp', unit: 'IRDRC - UEH', hometown: 'Đồng Nai' },
    { id: 'u-ctv-minh', username: 'ctv.minh', password: 'Minh@2026', name: 'CTV Minh', role: Roles.COLLAB, birthDate: '1997-02-14', degree: 'Cử nhân', academicRank: '', occupation: 'Cộng tác viên dự án', unit: 'IRDRC - UEH', hometown: 'Long An' }
  ];

  const hashedUsers = [];
  for (const user of users) {
    hashedUsers.push({
      ...user,
      passwordHash: await hashPassword(user.password),
      password: undefined,
      initials: initials(user.name),
      active: true,
      createdAt: now
    });
  }

  const projects = [
    { id: 'p-kx-dbscl', title: 'Đề tài KX ĐBSCL', group: 'Nghiên cứu', ownerId: 'u-lead-vien', coLeadIds: ['u-pt-dung'], memberIds: ['u-pt-dung', 'u-thl-vu', 'u-ntq-tram'], province: 'Đồng Tháp', commune: 'Xã Phước Vĩnh Tây', startDate: addDays(-20), endDate: addDays(160), priority: 'Cao', description: 'Nghiên cứu các nội dung và đề tài nhánh trong khuôn khổ đề tài KX vùng Đồng bằng sông Cửu Long.', deliverable: 'Báo cáo nghiên cứu, đề tài nhánh và bộ số liệu liên quan.', evidenceLink: '', createdAt: now, updatedAt: now },
    { id: 'p-kx-dmst', title: 'Đề tài KX Đổi mới sáng tạo', group: 'Nghiên cứu', ownerId: 'u-dc-khai', coLeadIds: ['u-ntq-tram'], memberIds: ['u-pt-dung', 'u-ntq-tram'], province: 'TP.HCM', commune: '', startDate: addDays(-15), endDate: addDays(120), priority: 'Cao', description: 'Nghiên cứu cơ chế thúc đẩy đổi mới sáng tạo và phát triển vùng.', deliverable: 'Bộ số liệu, báo cáo phân tích và khuyến nghị chính sách.', evidenceLink: '', createdAt: now, updatedAt: now },
    { id: 'p-nnl', title: 'Nguồn nhân lực chất lượng cao vùng ĐBSCL', group: 'Nghiên cứu', ownerId: 'u-nk-duc', coLeadIds: ['u-thl-vu'], memberIds: ['u-thl-vu', 'u-ntq-tram'], province: 'Cần Thơ', commune: '', startDate: addDays(-10), endDate: addDays(90), priority: 'Trung bình', description: 'Khung nghiên cứu, dữ liệu và bài viết về nguồn nhân lực chất lượng cao vùng ĐBSCL.', deliverable: 'Methodology, bộ dữ liệu và bài viết khoa học.', evidenceLink: '', createdAt: now, updatedAt: now },
    { id: 'p-logistics', title: 'Logistics Đồng Tháp', group: 'Tư vấn', ownerId: 'u-lead-vien', coLeadIds: ['u-ntq-tram'], memberIds: ['u-ntq-tram', 'u-v-son'], province: 'Đồng Tháp', commune: '', startDate: addDays(-30), endDate: addDays(80), priority: 'Cao', description: 'Tư vấn phát triển logistics và chuỗi giá trị địa phương.', deliverable: 'Hồ sơ tiến độ, công văn gia hạn và báo cáo tư vấn.', evidenceLink: '', createdAt: now, updatedAt: now },
    { id: 'p-camau', title: 'Hội thảo KHCN Cà Mau', group: 'Hội nghị/Hội thảo', ownerId: 'u-dc-khai', coLeadIds: ['u-thl-vu'], memberIds: ['u-thl-vu', 'u-ntt-linh'], province: 'Cà Mau', commune: '', startDate: addDays(-5), endDate: addDays(30), priority: 'Trung bình', description: 'Chuẩn bị bài tham luận và phối hợp tổ chức hội thảo khoa học.', deliverable: 'Bài viết, slide trình bày và hồ sơ hội thảo.', evidenceLink: '', createdAt: now, updatedAt: now },
    { id: 'p-annual', title: 'Báo cáo thường niên TP.HCM 2026', group: 'Quản lý vận hành', ownerId: 'u-lead-vien', coLeadIds: [], memberIds: ['u-pt-dung', 'u-thl-vu'], province: 'TP.HCM', commune: '', startDate: addDays(-8), endDate: addDays(25), priority: 'Cao', description: 'Quản lý thủ tục tài chính và báo cáo thường niên năm 2026.', deliverable: 'Bộ hồ sơ tài chính và báo cáo tổng hợp.', evidenceLink: '', createdAt: now, updatedAt: now }
  ];

  const task = (data) => ({
    id: uuid('task'),
    title: data.title,
    projectId: data.projectId,
    group: data.group,
    assignerId: data.assignerId,
    assigneeId: data.assigneeId,
    priority: data.priority || 'Trung bình',
    startDate: data.startDate || addDays(-2),
    dueDate: data.dueDate || addDays(5),
    status: data.status || TaskStatus.NEW,
    progress: Number(data.progress || 0),
    description: data.description || '',
    deliverable: data.deliverable || '',
    evidenceLink: data.evidenceLink || '',
    decline: data.decline || null,
    approval: data.approval || null,
    originalTaskId: data.originalTaskId || null,
    createdAt: now,
    updatedAt: now,
    activity: data.activity || [{ id: uuid('act'), at: now, actorId: data.assignerId, type: 'CREATED', note: 'Đã giao công việc.' }]
  });

  const tasks = [
    task({ title: 'Hoàn thiện thủ tục tài chính Báo cáo thường niên TP.HCM 2026', projectId: 'p-annual', group: 'Quản lý vận hành', assignerId: 'u-lead-vien', assigneeId: 'u-pt-dung', priority: 'Cao', startDate: addDays(-2), dueDate: addDays(4), status: TaskStatus.IN_PROGRESS, progress: 55, description: 'Rà soát hồ sơ, chứng từ và phối hợp thanh toán.', deliverable: 'Bộ hồ sơ tài chính hoàn chỉnh' }),
    task({ title: 'Tiếp tục hoàn thiện đề tài nhánh trong đề tài KX ĐBSCL', projectId: 'p-kx-dbscl', group: 'Nghiên cứu', assignerId: 'u-lead-vien', assigneeId: 'u-pt-dung', priority: 'Cao', startDate: addDays(-3), dueDate: addDays(2), status: TaskStatus.PENDING, progress: 100, description: 'Hoàn thiện nội dung thuyết minh, rà soát tính logic và dữ liệu nền.', deliverable: 'Bản nháp đề tài nhánh KX ĐBSCL', approval: { reviewerId: 'u-lead-vien', submittedAt: now, note: '' } }),
    task({ title: 'Xử lý số liệu đề tài KX Đổi mới sáng tạo', projectId: 'p-kx-dmst', group: 'Nghiên cứu', assignerId: 'u-dc-khai', assigneeId: 'u-pt-dung', priority: 'Cao', startDate: addDays(-1), dueDate: addDays(5), status: TaskStatus.PENDING, progress: 100, description: 'Làm sạch dữ liệu, chạy mô tả và tổng hợp kết quả chính.', deliverable: 'Kết quả xử lý số liệu đề tài KX ĐMST', approval: { reviewerId: 'u-dc-khai', submittedAt: now, note: '' } }),
    task({ title: 'Bài viết 5 trang cho Hội thảo KHCN Cà Mau', projectId: 'p-camau', group: 'Hội nghị/Hội thảo', assignerId: 'u-dc-khai', assigneeId: 'u-thl-vu', priority: 'Cao', startDate: addDays(-1), dueDate: addDays(6), status: TaskStatus.NEW, progress: 0, description: 'Viết bài tham luận 5 trang, chuẩn hóa trích dẫn và số liệu minh chứng.', deliverable: 'Bài tham luận 5 trang' }),
    task({ title: 'Hoàn thiện phần kê khai Bằng khen Thủ tướng cho TS. Đinh Công Khải', projectId: 'p-annual', group: 'Quản lý vận hành', assignerId: 'u-lead-vien', assigneeId: 'u-thl-vu', priority: 'Cao', startDate: addDays(-5), dueDate: addDays(-1), status: TaskStatus.DONE, progress: 100, description: 'Chuẩn hóa format kê khai và rà soát minh chứng.', deliverable: 'Hồ sơ kê khai hoàn chỉnh', evidenceLink: 'https://drive.google.com/' }),
    task({ title: 'Chuẩn bị methodology, data bài NNL CLC vùng ĐBSCL', projectId: 'p-nnl', group: 'Nghiên cứu', assignerId: 'u-nk-duc', assigneeId: 'u-ntq-tram', priority: 'Trung bình', startDate: addDays(-1), dueDate: addDays(7), status: TaskStatus.IN_PROGRESS, progress: 40, description: 'Chuẩn bị dữ liệu nền, outline và bộ biến chính.', deliverable: 'Bộ methodology và data sơ bộ' }),
    task({ title: 'Upload website bài đã được BDH chỉnh sửa', projectId: 'p-logistics', group: 'Tư vấn', assignerId: 'u-lead-vien', assigneeId: 'u-v-son', priority: 'Cao', startDate: addDays(-1), dueDate: addDays(2), status: TaskStatus.NEW, progress: 0, description: 'Đăng bài đã được Ban điều hành chỉnh sửa lên website và gửi link xác nhận.', deliverable: 'Bài viết đã được upload website' }),
    task({ title: 'Tổng hợp hồ sơ tiến độ logistics Đồng Tháp', projectId: 'p-logistics', group: 'Tư vấn', assignerId: 'u-lead-vien', assigneeId: 'u-ntq-tram', priority: 'Cao', startDate: addDays(-3), dueDate: addDays(3), status: TaskStatus.ADJUSTMENT, progress: 0, description: 'Tổng hợp hồ sơ tiến độ, công văn gia hạn và chứng từ liên quan.', deliverable: 'Hồ sơ trình ký và công văn gia hạn', decline: { byId: 'u-ntq-tram', at: now, reason: 'Cần bổ sung mốc thời gian và phạm vi dữ liệu.', recommendation: 'Bổ sung danh mục hồ sơ và xác định đầu mối xác nhận.' } })
  ];

  return { version: 1, createdAt: now, users: hashedUsers, projects, tasks };
}

async function initDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    db = await seedDatabase();
    await persistDb();
    return;
  }
  db = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
  db.users = ensureArray(db.users);
  db.projects = ensureArray(db.projects);
  db.tasks = ensureArray(db.tasks);
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function text(res, status, body, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function badRequest(res, message = 'Dữ liệu gửi lên không hợp lệ.') {
  return json(res, 400, { error: message });
}

function forbidden(res, message = 'Bạn không có quyền thực hiện thao tác này.') {
  return json(res, 403, { error: message });
}

function notFound(res, message = 'Không tìm thấy dữ liệu yêu cầu.') {
  return json(res, 404, { error: message });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, item) => {
    const index = item.indexOf('=');
    if (index === -1) return acc;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function sessionFromRequest(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function getCurrentUser(req) {
  const session = sessionFromRequest(req);
  return session ? userById(session.userId) : null;
}

function setSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSession(req, res) {
  const session = sessionFromRequest(req);
  if (session) sessions.delete(session.token);
  const parts = [`${COOKIE_NAME}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function readJsonBody(req) {
  let size = 0;
  let raw = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Payload quá lớn.');
    raw += chunk;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('JSON không hợp lệ.');
  }
}

function projectPayload(project) {
  return {
    ...project,
    taskCount: db.tasks.filter((task) => task.projectId === project.id).length,
    owner: safeUser(userById(project.ownerId)),
    coLeads: ensureArray(project.coLeadIds).map((id) => safeUser(userById(id))).filter(Boolean),
    members: ensureArray(project.memberIds).map((id) => safeUser(userById(id))).filter(Boolean)
  };
}

function taskPayload(task) {
  const project = projectById(task.projectId);
  return {
    ...task,
    statusLabel: taskStatusLabel(task.status),
    assigner: safeUser(userById(task.assignerId)),
    assignee: safeUser(userById(task.assigneeId)),
    project: project ? { id: project.id, title: project.title, group: project.group } : null,
    canEditProject: false
  };
}

function assertRole(res, user, roles) {
  if (!user) {
    json(res, 401, { error: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.' });
    return false;
  }
  if (roles && !roles.includes(user.role)) {
    forbidden(res);
    return false;
  }
  return true;
}

function normalizeProjectInput(input) {
  const ownerId = asText(input.ownerId, 100);
  const coLeadIds = asIdArray(input.coLeadIds);
  const memberIds = asIdArray(input.memberIds);
  return {
    title: asText(input.title, 250),
    group: GROUPS.includes(input.group) ? input.group : 'Nghiên cứu',
    ownerId,
    coLeadIds: coLeadIds.filter((id) => id !== ownerId),
    memberIds: memberIds.filter((id) => id !== ownerId),
    province: asText(input.province, 150),
    commune: asText(input.commune, 150),
    startDate: asText(input.startDate, 20),
    endDate: asText(input.endDate, 20),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'Trung bình',
    description: asText(input.description, 5000),
    deliverable: asText(input.deliverable, 5000),
    evidenceLink: asText(input.evidenceLink, 1000)
  };
}

function validateProjectInput(value) {
  if (!value.title) return 'Tên dự án là bắt buộc.';
  if (!value.ownerId || !userById(value.ownerId)) return 'Chủ trì/điều phối không hợp lệ.';
  if (!validateUserReferences([...value.coLeadIds, ...value.memberIds])) return 'Có thành viên dự án không tồn tại.';
  if (value.startDate && !validDate(value.startDate)) return 'Ngày bắt đầu không hợp lệ.';
  if (value.endDate && !validDate(value.endDate)) return 'Thời hạn dự kiến không hợp lệ.';
  if (value.startDate && value.endDate && value.startDate > value.endDate) return 'Thời hạn dự kiến phải sau ngày bắt đầu.';
  return null;
}

function normalizeTaskInput(input) {
  return {
    title: asText(input.title, 250),
    projectId: asText(input.projectId, 100),
    group: GROUPS.includes(input.group) ? input.group : 'Nghiên cứu',
    assigneeId: asText(input.assigneeId, 100),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'Trung bình',
    startDate: asText(input.startDate, 20),
    dueDate: asText(input.dueDate, 20),
    description: asText(input.description, 5000),
    deliverable: asText(input.deliverable, 5000),
    evidenceLink: asText(input.evidenceLink, 1000)
  };
}

function validateTaskInput(value) {
  if (!value.title) return 'Tên đầu việc là bắt buộc.';
  if (!value.projectId || !projectById(value.projectId)) return 'Vui lòng chọn dự án hợp lệ.';
  if (!value.assigneeId || !userById(value.assigneeId)) return 'Người nhận việc không hợp lệ.';
  if (!validDate(value.startDate) || !validDate(value.dueDate)) return 'Ngày bắt đầu và deadline là bắt buộc.';
  if (value.startDate > value.dueDate) return 'Deadline phải sau hoặc trùng ngày bắt đầu.';
  return null;
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'POST' && pathname === '/api/auth/login') {
    try {
      const body = await readJsonBody(req);
      const user = userByUsername(body.username);
      if (!user || user.active === false || !(await verifyPassword(body.password || '', user.passwordHash))) {
        return json(res, 401, { error: 'Tên đăng nhập hoặc mật khẩu không chính xác.' });
      }
      setSession(res, user.id);
      return json(res, 200, { user: safeUser(user, true) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    clearSession(req, res);
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const user = getCurrentUser(req);
    if (!user) return json(res, 401, { error: 'Chưa đăng nhập.' });
    return json(res, 200, { user: safeUser(user, true) });
  }

  const user = getCurrentUser(req);
  if (!assertRole(res, user)) return;

  if (method === 'GET' && pathname === '/api/directory') {
    return json(res, 200, { users: db.users.filter((item) => item.active !== false).map((item) => safeUser(item, true)) });
  }

  if (method === 'GET' && pathname === '/api/users') {
    if (!assertRole(res, user, [Roles.ADMIN])) return;
    return json(res, 200, { users: db.users.map((item) => safeUser(item, true)) });
  }

  if (method === 'POST' && pathname === '/api/users') {
    if (!assertRole(res, user, [Roles.ADMIN])) return;
    try {
      const body = await readJsonBody(req);
      const username = asText(body.username, 80).toLowerCase();
      const password = asText(body.password, 200) || 'welcome123';
      const name = asText(body.name, 160);
      const role = Object.values(Roles).includes(body.role) ? body.role : Roles.COLLAB;
      if (!name || !username) return badRequest(res, 'Họ tên và tên đăng nhập là bắt buộc.');
      if (!/^[a-z0-9._-]+$/i.test(username)) return badRequest(res, 'Tên đăng nhập chỉ dùng chữ, số, dấu chấm, gạch dưới hoặc gạch ngang.');
      if (userByUsername(username)) return badRequest(res, 'Tên đăng nhập đã tồn tại.');
      const entity = {
        id: uuid('user'), username, name, role,
        passwordHash: await hashPassword(password),
        birthDate: asText(body.birthDate, 20), degree: asText(body.degree, 100), academicRank: asText(body.academicRank, 100),
        occupation: asText(body.occupation, 150), unit: asText(body.unit, 150), hometown: asText(body.hometown, 150),
        initials: initials(name), active: true, createdAt: nowIso()
      };
      db.users.push(entity);
      await persistDb();
      return json(res, 201, { user: safeUser(entity, true) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === 'PATCH') {
    if (!assertRole(res, user, [Roles.ADMIN])) return;
    const target = userById(decodeURIComponent(userMatch[1]));
    if (!target) return notFound(res, 'Không tìm thấy nhân sự.');
    try {
      const body = await readJsonBody(req);
      const allowed = ['name', 'birthDate', 'degree', 'academicRank', 'occupation', 'unit', 'hometown', 'role', 'active'];
      for (const key of allowed) {
        if (body[key] === undefined) continue;
        if (key === 'role') {
          if (!Object.values(Roles).includes(body.role)) return badRequest(res, 'Loại tài khoản không hợp lệ.');
          target.role = body.role;
        } else if (key === 'active') {
          target.active = Boolean(body.active);
        } else {
          target[key] = asText(body[key], 200);
        }
      }
      if (body.password) target.passwordHash = await hashPassword(asText(body.password, 200));
      target.initials = initials(target.name);
      await persistDb();
      return json(res, 200, { user: safeUser(target, true) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  if (method === 'GET' && pathname === '/api/projects') {
    const projects = db.projects.filter((project) => canViewProject(user, project)).map(projectPayload);
    return json(res, 200, { projects });
  }

  if (method === 'POST' && pathname === '/api/projects') {
    if (!isWorker(user)) return forbidden(res, 'Cộng tác viên không được tạo dự án.');
    try {
      const input = normalizeProjectInput(await readJsonBody(req));
      const error = validateProjectInput(input);
      if (error) return badRequest(res, error);
      // Chỉ người tạo hoặc chính chủ trì/đồng chủ trì mới có thể quản trị sau đó.
      if (![input.ownerId, ...input.coLeadIds].includes(user.id)) {
        return forbidden(res, 'Bạn chỉ có thể tạo dự án khi là Chủ trì hoặc Đồng chủ trì/Điều phối.');
      }
      const project = { id: uuid('project'), ...input, createdAt: nowIso(), updatedAt: nowIso() };
      db.projects.push(project);
      await persistDb();
      return json(res, 201, { project: projectPayload(project) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === 'GET') {
    const project = projectById(decodeURIComponent(projectMatch[1]));
    if (!project) return notFound(res, 'Không tìm thấy dự án.');
    if (!canViewProject(user, project)) return forbidden(res, 'Bạn không có quyền xem dự án này.');
    const payload = projectPayload(project);
    payload.tasks = db.tasks.filter((task) => task.projectId === project.id && canViewTask(user, task)).map(taskPayload);
    payload.permissions = { canEdit: canEditProject(user, project), canCreateTask: canEditProject(user, project) };
    return json(res, 200, { project: payload });
  }

  if (projectMatch && method === 'PATCH') {
    const project = projectById(decodeURIComponent(projectMatch[1]));
    if (!project) return notFound(res, 'Không tìm thấy dự án.');
    if (!canEditProject(user, project)) return forbidden(res, 'Bạn chỉ có thể cập nhật dự án mình chủ trì hoặc đồng chủ trì.');
    try {
      const input = normalizeProjectInput(await readJsonBody(req));
      const error = validateProjectInput(input);
      if (error) return badRequest(res, error);
      if (![input.ownerId, ...input.coLeadIds].includes(user.id)) {
        return forbidden(res, 'Sau khi cập nhật, bạn phải vẫn là Chủ trì hoặc Đồng chủ trì/Điều phối của dự án.');
      }
      Object.assign(project, input, { updatedAt: nowIso() });
      await persistDb();
      return json(res, 200, { project: projectPayload(project) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  if (method === 'GET' && pathname === '/api/tasks') {
    const tasks = db.tasks.filter((task) => canViewTask(user, task)).map(taskPayload);
    return json(res, 200, { tasks });
  }

  if (method === 'POST' && pathname === '/api/tasks') {
    if (!isWorker(user)) return forbidden(res, 'Cộng tác viên không được tạo hoặc giao công việc.');
    try {
      const input = normalizeTaskInput(await readJsonBody(req));
      const error = validateTaskInput(input);
      if (error) return badRequest(res, error);
      const project = projectById(input.projectId);
      if (!canEditProject(user, project)) return forbidden(res, 'Bạn chỉ được tạo việc trong dự án mình chủ trì hoặc đồng chủ trì.');
      if (![...project.memberIds, project.ownerId, ...project.coLeadIds].includes(input.assigneeId)) {
        return badRequest(res, 'Người nhận việc cần thuộc thành viên dự án.');
      }
      const task = {
        id: uuid('task'), ...input, assignerId: user.id, status: TaskStatus.NEW, progress: 0,
        decline: null, approval: null, originalTaskId: null, createdAt: nowIso(), updatedAt: nowIso(), activity: []
      };
      appendActivity(task, user.id, 'CREATED', 'Đã giao công việc mới.');
      db.tasks.push(task);
      await persistDb();
      return json(res, 201, { task: taskPayload(task) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === 'GET') {
    const task = taskById(decodeURIComponent(taskMatch[1]));
    if (!task) return notFound(res, 'Không tìm thấy công việc.');
    if (!canViewTask(user, task)) return forbidden(res);
    const payload = taskPayload(task);
    payload.permissions = {
      canEdit: canEditTask(user, task),
      canAccept: task.assigneeId === user.id && task.status === TaskStatus.NEW,
      canDecline: task.assigneeId === user.id && task.status === TaskStatus.NEW,
      canUpdateProgress: task.assigneeId === user.id && task.status === TaskStatus.IN_PROGRESS,
      canSubmit: task.assigneeId === user.id && task.status === TaskStatus.IN_PROGRESS && task.progress === 100,
      canReview: task.assignerId === user.id && task.status === TaskStatus.PENDING
    };
    return json(res, 200, { task: payload });
  }

  if (taskMatch && method === 'PATCH') {
    const task = taskById(decodeURIComponent(taskMatch[1]));
    if (!task) return notFound(res, 'Không tìm thấy công việc.');
    if (!canEditTask(user, task)) return forbidden(res, 'Chỉ người giao việc mới được điều chỉnh.');
    if (task.status !== TaskStatus.ADJUSTMENT) return badRequest(res, 'Chỉ có thể cập nhật công việc ở trạng thái Chờ điều chỉnh.');
    try {
      const input = normalizeTaskInput(await readJsonBody(req));
      const error = validateTaskInput(input);
      if (error) return badRequest(res, error);
      const project = projectById(input.projectId);
      if (!canEditProject(user, project)) return forbidden(res, 'Bạn chỉ được giao việc trong dự án mình phụ trách.');
      if (![...project.memberIds, project.ownerId, ...project.coLeadIds].includes(input.assigneeId)) {
        return badRequest(res, 'Người nhận việc cần thuộc thành viên dự án.');
      }
      Object.assign(task, input, { status: TaskStatus.NEW, progress: 0, decline: null, approval: null, updatedAt: nowIso() });
      appendActivity(task, user.id, 'ADJUSTED', 'Đã điều chỉnh và giao lại công việc.');
      await persistDb();
      return json(res, 200, { task: taskPayload(task) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  const actionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/(accept|decline|progress|submit|approve|reject-approval)$/);
  if (actionMatch && method === 'POST') {
    const task = taskById(decodeURIComponent(actionMatch[1]));
    const action = actionMatch[2];
    if (!task) return notFound(res, 'Không tìm thấy công việc.');
    if (!canViewTask(user, task)) return forbidden(res);
    try {
      const body = await readJsonBody(req);

      if (action === 'accept') {
        if (task.assigneeId !== user.id || task.status !== TaskStatus.NEW) return forbidden(res, 'Chỉ người nhận mới có thể nhận việc mới giao.');
        task.status = TaskStatus.IN_PROGRESS;
        task.progress = Math.max(task.progress, 1);
        task.updatedAt = nowIso();
        appendActivity(task, user.id, 'ACCEPTED', 'Đã nhận công việc.');
      }

      if (action === 'decline') {
        if (task.assigneeId !== user.id || task.status !== TaskStatus.NEW) return forbidden(res, 'Chỉ người nhận mới có thể từ chối việc mới giao.');
        const reason = asText(body.reason, 2000);
        const recommendation = asText(body.recommendation, 2000);
        if (!reason) return badRequest(res, 'Vui lòng ghi rõ lý do từ chối.');
        task.status = TaskStatus.ADJUSTMENT;
        task.progress = 0;
        task.decline = { byId: user.id, at: nowIso(), reason, recommendation };
        task.updatedAt = nowIso();
        appendActivity(task, user.id, 'DECLINED', `Từ chối: ${reason}`);
      }

      if (action === 'progress') {
        if (task.assigneeId !== user.id || task.status !== TaskStatus.IN_PROGRESS) return forbidden(res, 'Chỉ người đang làm việc mới có thể cập nhật tiến độ.');
        const progress = Number(body.progress);
        if (!Number.isFinite(progress) || progress < 0 || progress > 100) return badRequest(res, 'Tiến độ phải nằm trong khoảng 0–100%.');
        task.progress = Math.round(progress);
        task.evidenceLink = asText(body.evidenceLink, 1000) || task.evidenceLink;
        task.updatedAt = nowIso();
        appendActivity(task, user.id, 'PROGRESS_UPDATED', `Cập nhật tiến độ: ${task.progress}%.`);
      }

      if (action === 'submit') {
        if (task.assigneeId !== user.id || task.status !== TaskStatus.IN_PROGRESS || task.progress !== 100) {
          return forbidden(res, 'Chỉ có thể nộp duyệt khi công việc đang làm đạt 100%.');
        }
        task.status = TaskStatus.PENDING;
        task.approval = { reviewerId: task.assignerId, submittedAt: nowIso(), note: asText(body.note, 2000) };
        task.updatedAt = nowIso();
        appendActivity(task, user.id, 'SUBMITTED', 'Đã nộp công việc chờ duyệt.');
      }

      if (action === 'approve') {
        if (task.assignerId !== user.id || task.status !== TaskStatus.PENDING) return forbidden(res, 'Chỉ người giao việc mới có thể duyệt.');
        task.status = TaskStatus.DONE;
        task.approval = { ...(task.approval || {}), reviewerId: user.id, reviewedAt: nowIso(), decision: 'APPROVED', note: asText(body.note, 2000) };
        task.updatedAt = nowIso();
        appendActivity(task, user.id, 'APPROVED', 'Đã duyệt công việc.');
      }

      if (action === 'reject-approval') {
        if (task.assignerId !== user.id || task.status !== TaskStatus.PENDING) return forbidden(res, 'Chỉ người giao việc mới có thể không duyệt.');
        const reason = asText(body.reason, 2000);
        if (!reason) return badRequest(res, 'Vui lòng ghi rõ lý do không duyệt.');
        task.status = TaskStatus.REVIEW_REJECTED;
        task.approval = { ...(task.approval || {}), reviewerId: user.id, reviewedAt: nowIso(), decision: 'REJECTED', reason };
        task.updatedAt = nowIso();
        appendActivity(task, user.id, 'REVIEW_REJECTED', `Không duyệt: ${reason}`);
        const revised = {
          id: uuid('task'),
          title: `CHỈNH SỬA ${task.title}`,
          projectId: task.projectId,
          group: task.group,
          assignerId: task.assignerId,
          assigneeId: task.assigneeId,
          priority: task.priority,
          startDate: addDays(0),
          dueDate: task.dueDate < addDays(1) ? addDays(5) : task.dueDate,
          status: TaskStatus.NEW,
          progress: 0,
          description: `${task.description}\n\nYêu cầu chỉnh sửa sau phản hồi duyệt: ${reason}`.trim(),
          deliverable: task.deliverable,
          evidenceLink: '',
          decline: null,
          approval: null,
          originalTaskId: task.id,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          activity: []
        };
        appendActivity(revised, user.id, 'CREATED_FROM_REJECTION', `Tạo tự động từ việc không duyệt: ${task.title}`);
        db.tasks.push(revised);
      }

      await persistDb();
      return json(res, 200, { task: taskPayload(task) });
    } catch (error) {
      return badRequest(res, error.message);
    }
  }

  if (method === 'GET' && pathname === '/api/export/tasks.csv') {
    const rows = db.tasks.filter((task) => canViewTask(user, task));
    const header = ['ID', 'Tên công việc', 'Dự án', 'Nhóm việc', 'Người giao', 'Người nhận', 'Trạng thái', 'Tiến độ', 'Deadline', 'Đầu ra', 'Link minh chứng'];
    const escapeCsv = (value) => `"${String(value || '').replace(/"/g, '""')}"`;
    const csv = [header, ...rows.map((task) => [
      task.id,
      task.title,
      projectById(task.projectId)?.title || '',
      task.group,
      userById(task.assignerId)?.name || '',
      userById(task.assigneeId)?.name || '',
      taskStatusLabel(task.status),
      `${task.progress}%`,
      task.dueDate,
      task.deliverable,
      task.evidenceLink
    ])].map((row) => row.map(escapeCsv).join(',')).join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="irdrc-hub-tasks.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end(`\uFEFF${csv}`);
  }

  return notFound(res, 'Không tìm thấy API.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, url) {
  const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^([.][.][/\\])+/, '');
  const target = path.resolve(PUBLIC_DIR, `.${normalized}`);
  if (!target.startsWith(PUBLIC_DIR)) return forbidden(res, 'Đường dẫn không hợp lệ.');
  let filePath = target;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // Client-side fallback.
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  try {
    const body = await fsp.readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(body);
  } catch {
    notFound(res, 'Không tìm thấy tệp.');
  }
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'Máy chủ gặp lỗi nội bộ.' });
    else res.end();
  }
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}

async function main() {
  await initDb();
  setInterval(cleanupSessions, 1000 * 60 * 30).unref();
  const server = http.createServer(requestHandler);
  server.listen(PORT, () => {
    console.log(`IRDRC HUB running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error('Unable to start IRDRC HUB:', error);
  process.exit(1);
});
