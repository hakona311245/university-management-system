'use strict';

const GROUPS = ['Nghiên cứu', 'Tư vấn', 'Quản lý vận hành', 'Tập huấn', 'Hội nghị/Hội thảo', 'Công bố quốc tế'];
const PRIORITIES = ['Cao', 'Trung bình', 'Thấp'];
const STATUS = {
  NEW: 'Mới giao',
  IN_PROGRESS: 'Đang làm',
  PENDING: 'Công việc chờ duyệt',
  DONE: 'Hoàn thành',
  ADJUSTMENT: 'Chờ điều chỉnh',
  REVIEW_REJECTED: 'Không duyệt'
};
const ROLES = {
  ADMIN: 'Admin',
  LEADER: 'Lãnh đạo Viện',
  STAFF: 'Nhân sự Viện',
  COLLAB: 'Cộng tác viên'
};

const state = {
  user: null,
  directory: [],
  projects: [],
  tasks: [],
  route: 'dashboard',
  dashboardFilters: { group: '', person: '' },
  projectFilters: { group: '', province: '' },
  assignFilters: { project: '', assignee: '', status: '' },
  taskFilters: { project: '', status: '' },
  modal: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (date) => date ? new Date(`${date}T00:00:00`).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(-2).map((x) => x[0]).join('').toUpperCase() || 'IR';
const isWorker = () => state.user && [ROLES.ADMIN, ROLES.LEADER, ROLES.STAFF].includes(state.user.role);
const isAdmin = () => state.user && state.user.role === ROLES.ADMIN;

async function api(path, options = {}) {
  const config = { method: 'GET', headers: {}, ...options };
  if (config.body && typeof config.body !== 'string') {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(path, config);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(payload?.error || 'Không thể thực hiện yêu cầu.');
  return payload;
}

function toast(message, type = '') {
  const root = $('#toastRoot');
  const node = document.createElement('div');
  node.className = `toast ${type}`.trim();
  node.textContent = message;
  root.append(node);
  setTimeout(() => node.remove(), 3300);
}

function roleClass(role) {
  return role === ROLES.ADMIN ? 'admin' : role === ROLES.LEADER ? 'leader' : role === ROLES.STAFF ? 'staff' : 'collab';
}

function rolePill(role) {
  return `<span class="pill ${roleClass(role)}">${esc(role)}</span>`;
}

function projectById(id) { return state.projects.find((project) => project.id === id); }
function userById(id) { return state.directory.find((user) => user.id === id); }
function userName(id) { return userById(id)?.name || 'Không xác định'; }
function statusPill(status) {
  const c = status === 'NEW' ? 'new' : status === 'IN_PROGRESS' ? 'progress' : status === 'PENDING' ? 'pending' : status === 'DONE' ? 'done' : status === 'ADJUSTMENT' ? 'adjustment' : 'rejected';
  return `<span class="pill ${c}">${esc(STATUS[status] || status)}</span>`;
}
function priorityPill(priority) {
  const c = priority === 'Cao' ? 'high' : priority === 'Trung bình' ? 'medium' : 'low';
  return `<span class="pill ${c}">${esc(priority)}</span>`;
}
function daysUntil(date) {
  if (!date) return 0;
  const start = new Date(`${today()}T00:00:00`);
  const end = new Date(`${date}T00:00:00`);
  return Math.ceil((end - start) / 86400000);
}
function isLate(task) { return !['DONE', 'REVIEW_REJECTED'].includes(task.status) && task.dueDate < today(); }
function canEditProject(project) { return !!project && isWorker() && (project.ownerId === state.user.id || (project.coLeadIds || []).includes(state.user.id)); }
function canCreateTaskInProject(project) { return canEditProject(project); }
function ownedProjects() { return state.projects.filter(canEditProject); }
function tasksForCurrentAssignee() { return state.tasks.filter((task) => task.assigneeId === state.user.id); }
function tasksForCurrentAssigner() { return state.tasks.filter((task) => task.assignerId === state.user.id); }

async function bootstrap() {
  $('#loginForm').addEventListener('submit', login);
  $('#logoutButton').addEventListener('click', logout);
  $('#printButton').addEventListener('click', () => window.print());
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    await loadData();
    showApp();
  } catch {
    showLogin();
  }
}

async function login(event) {
  event.preventDefault();
  const error = $('#loginError');
  error.hidden = true;
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }
    });
    state.user = data.user;
    await loadData();
    showApp();
    toast(`Đăng nhập thành công: ${state.user.name}`);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* no-op */ }
  state.user = null;
  state.directory = [];
  state.projects = [];
  state.tasks = [];
  state.route = 'dashboard';
  showLogin();
}

function showLogin() {
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  $('#loginForm').reset();
  $('#loginError').hidden = true;
  setTimeout(() => $('#loginUsername').focus(), 40);
}

function showApp() {
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  render();
}

async function loadData() {
  const [directory, projects, tasks] = await Promise.all([
    api('/api/directory'),
    api('/api/projects'),
    api('/api/tasks')
  ]);
  state.directory = directory.users;
  state.projects = projects.projects;
  state.tasks = tasks.tasks;
}

function pageMeta(route) {
  return {
    dashboard: ['Tổng quan', 'Theo dõi tiến độ dự án, công việc và sản phẩm đầu ra.'],
    personnel: ['Quản lý nhân sự', 'Admin thêm hồ sơ nhân sự và thiết lập loại tài khoản.'],
    'project-create': ['Tạo dự án', 'Khai báo dự án mới và quản lý danh sách dự án theo nhóm việc, địa phương.'],
    'project-coordination': ['Dự án điều phối', 'Theo dõi dự án bạn đang chủ trì hoặc đồng chủ trì/điều phối.'],
    'tasks-review': ['Công việc chờ duyệt', 'Duyệt hoặc không duyệt các công việc được giao bởi bạn.'],
    'tasks-assign': ['Giao việc', 'Tạo, giao và theo dõi danh sách đầu việc thuộc các dự án bạn phụ trách.'],
    'tasks-list': ['Danh sách công việc', 'Nhận việc, cập nhật tiến độ, nộp duyệt và theo dõi các đầu việc được giao cho bạn.'],
    'tasks-adjustment': ['Chờ điều chỉnh', 'Cập nhật các công việc bị từ chối nhận và giao lại cho nhân sự.'],
    products: ['Sản phẩm tuần', 'Theo dõi đầu ra, minh chứng và link hồ sơ theo công việc.'],
    evaluation: ['Đánh giá', 'Tổng hợp hiệu suất, tiến độ và cảnh báo theo nhân sự.'],
    people: ['Nhân sự', 'Tra cứu danh sách thành viên và tải công việc hiện tại.']
  }[route] || ['IRDRC HUB', 'Hệ thống quản lý dự án và công việc.'];
}

function render() {
  const [title, subtitle] = pageMeta(state.route);
  $('#pageTitle').textContent = title;
  $('#pageSubtitle').textContent = subtitle;
  $('#accountPill').innerHTML = `
    <div class="account-avatar">${esc(state.user.initials || initials(state.user.name))}</div>
    <div><strong>${esc(state.user.name)}</strong><span>${esc(state.user.role)}</span></div>`;
  renderNav();
  const root = $('#routeContent');
  const renders = {
    dashboard: renderDashboard,
    personnel: renderPersonnel,
    'project-create': renderProjectCreate,
    'project-coordination': renderProjectCoordination,
    'tasks-review': renderTasksReview,
    'tasks-assign': renderTasksAssign,
    'tasks-list': renderTasksList,
    'tasks-adjustment': renderTasksAdjustment,
    products: renderProducts,
    evaluation: renderEvaluation,
    people: renderPeople
  };
  root.innerHTML = renders[state.route] ? renders[state.route]() : renderDashboard();
  bindRouteEvents();
}

function navItem(route, label, icon, disabled = false, count = '') {
  return `<button class="nav-button ${state.route === route ? 'active' : ''} ${disabled ? 'nav-disabled' : ''}" data-route="${route}" ${disabled ? 'disabled' : ''}><span>${icon}</span><span>${esc(label)}</span>${count ? `<span class="nav-count">${esc(count)}</span>` : ''}</button>`;
}

function navGroup(label, icon, children, disabled = false) {
  const active = children.some((child) => child.route === state.route);
  return `<div class="nav-group ${disabled ? 'nav-disabled' : ''}">
    <button class="nav-parent ${active ? 'active' : ''}" ${disabled ? 'disabled' : ''}><span>${icon} ${esc(label)}</span><span>⌃</span></button>
    <div class="nav-children">${children.map((child) => `<button class="nav-child ${state.route === child.route ? 'active' : ''}" data-route="${child.route}" ${disabled ? 'disabled' : ''}>${esc(child.label)}${child.count ? `<span class="nav-count">${esc(child.count)}</span>` : ''}</button>`).join('')}</div>
  </div>`;
}

function renderNav() {
  const canWork = isWorker();
  const pendingCount = tasksForCurrentAssigner().filter((task) => task.status === 'PENDING').length;
  const adjustmentCount = tasksForCurrentAssigner().filter((task) => task.status === 'ADJUSTMENT').length;
  const nav = [
    navItem('dashboard', 'Tổng quan', '📊'),
    isAdmin() ? navItem('personnel', 'Quản lý nhân sự', '👥') : '',
    navGroup('Danh mục dự án', '📁', [
      { route: 'project-create', label: 'Tạo dự án' },
      { route: 'project-coordination', label: 'Dự án điều phối' }
    ], !canWork),
    navGroup('Công việc', '📝', [
      { route: 'tasks-review', label: 'Công việc chờ duyệt', count: pendingCount ? `(${pendingCount})` : '' },
      { route: 'tasks-assign', label: 'Giao việc' },
      { route: 'tasks-list', label: 'Danh sách công việc' },
      { route: 'tasks-adjustment', label: 'Chờ điều chỉnh', count: adjustmentCount ? `(${adjustmentCount})` : '' }
    ], false),
    navItem('products', 'Sản phẩm tuần', '📦'),
    navItem('evaluation', 'Đánh giá', '🏅', !canWork),
    navItem('people', 'Nhân sự', '👥')
  ].join('');
  $('#sidebarNav').innerHTML = nav;
  $$('#sidebarNav [data-route]').forEach((button) => button.addEventListener('click', () => {
    state.route = button.dataset.route;
    render();
  }));
}

function renderDashboard() {
  const tasks = filterDashboardTasks();
  const total = tasks.length;
  const inProgress = tasks.filter((task) => ['IN_PROGRESS', 'PENDING'].includes(task.status)).length;
  const done = tasks.filter((task) => task.status === 'DONE').length;
  const late = tasks.filter(isLate).length;
  const avg = total ? Math.round(tasks.reduce((sum, task) => sum + Number(task.progress || 0), 0) / total) : 0;
  const alerts = buildAlerts(tasks);
  return `
    <div class="card filter-panel">
      <div class="filter-copy"><strong>Lọc dữ liệu tổng quan</strong><span>Chọn loại công việc hoặc nhân sự trước khi xem các chỉ số và cảnh báo.</span></div>
      <div class="filter-actions">
        <div class="field"><label>Loại công việc</label><select id="dashGroupFilter">${optionList(['Tất cả nhóm việc', ...GROUPS], state.dashboardFilters.group, true)}</select></div>
        <div class="field"><label>Nhân sự</label><select id="dashPersonFilter">${optionList(['Tất cả nhân sự', ...state.directory.map((user) => user.name)], state.dashboardFilters.person, true)}</select></div>
        <button class="btn" id="dashReset" type="button">Xóa lọc</button>
      </div>
    </div>
    <div class="kpi-grid">
      ${kpi('Tổng việc', total, 'Toàn bộ đầu việc trong phạm vi đang xem')}
      ${kpi('Đang xử lý', inProgress, 'Bao gồm đang làm và chờ duyệt')}
      ${kpi('Hoàn thành', done, 'Đã được duyệt hoặc hoàn thành')}
      ${kpi('Quá hạn', late, 'Deadline trước ngày hôm nay')}
      ${kpi('Tiến độ TB', `${avg}%`, 'Tính theo phần trăm từng việc')}
    </div>
    <div class="section-title"><h2>Biểu đồ đánh giá chung</h2><p>Khối lượng, trạng thái, tiến độ và nhóm việc</p></div>
    <div class="dashboard-grid">
      <div class="card pad chart-card"><h3 class="card-title">Khối lượng công việc theo nhân sự</h3><div class="chart-wrap"><canvas id="workloadChart"></canvas></div></div>
      <div class="card pad chart-card"><h3 class="card-title">Cơ cấu trạng thái</h3><div class="chart-wrap"><canvas id="statusChart"></canvas></div></div>
      <div class="card pad chart-card"><h3 class="card-title">Tiến độ theo ngày trong tuần</h3><div class="chart-wrap"><canvas id="trendChart"></canvas></div></div>
      <div class="card pad chart-card"><h3 class="card-title">Tỷ trọng theo nhóm việc</h3><div class="chart-wrap"><canvas id="groupChart"></canvas></div></div>
    </div>
    <div class="section-title"><h2>Vùng cảnh báo cần cải thiện</h2><p>Đặt sau phần biểu đồ tiến độ để lãnh đạo rà soát hành động</p></div>
    <div class="alert-grid">${alerts.map(alertCard).join('') || '<div class="empty">Chưa có cảnh báo trong phạm vi lọc.</div>'}</div>
    <div class="section-title"><h2>Lịch tuần dạng timeline</h2><p>Hiển thị công việc theo khoảng thời gian thực hiện</p></div>
    <div class="timeline">${renderTimeline(tasks)}</div>`;
}

function optionList(values, selected, firstIsLabel = false) {
  return values.map((value, index) => {
    const actual = firstIsLabel && index === 0 ? '' : value;
    return `<option value="${esc(actual)}" ${actual === selected ? 'selected' : ''}>${esc(value)}</option>`;
  }).join('');
}
function kpi(label, value, note) { return `<div class="card kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div><div class="kpi-note">${esc(note)}</div></div>`; }
function filterDashboardTasks() {
  return state.tasks.filter((task) => {
    const groupOk = !state.dashboardFilters.group || task.group === state.dashboardFilters.group;
    const personOk = !state.dashboardFilters.person || task.assignee?.name === state.dashboardFilters.person || task.assigner?.name === state.dashboardFilters.person;
    return groupOk && personOk;
  });
}
function buildAlerts(tasks) {
  const users = state.directory.filter((user) => tasks.some((task) => task.assigneeId === user.id || task.assignerId === user.id));
  return users.slice(0, 5).map((user) => {
    const assigned = tasks.filter((task) => task.assigneeId === user.id);
    const late = assigned.filter(isLate).length;
    const pending = tasks.filter((task) => task.assignerId === user.id && task.status === 'PENDING').length;
    const missing = assigned.filter((task) => task.deliverable && !task.evidenceLink && task.status === 'DONE').length;
    let type = '';
    let issue = 'Khối lượng công việc đang trong ngưỡng theo dõi.';
    let action = 'Duy trì cập nhật tiến độ, đầu ra và link minh chứng.';
    if (late) { type = 'danger'; issue = `${late} công việc quá hạn cần xử lý ngay.`; action = 'Rà soát lại deadline, nguồn lực và phản hồi cho người giao việc.'; }
    else if (pending) { type = 'warning'; issue = `${pending} công việc đang chờ duyệt.`; action = 'Chủ động duyệt hoặc phản hồi rõ yêu cầu chỉnh sửa.'; }
    else if (missing) { type = 'warning'; issue = `${missing} đầu ra hoàn thành thiếu link minh chứng.`; action = 'Bổ sung đường link Drive/OneDrive/hồ sơ nội bộ.'; }
    return { user, type, issue, action };
  });
}
function alertCard(alert) { return `<div class="alert-card ${alert.type}"><strong>${esc(alert.user.name)}</strong><p><b>Vấn đề:</b> ${esc(alert.issue)}<br><b>Hành động:</b> ${esc(alert.action)}</p></div>`; }
function renderTimeline(tasks) {
  const dates = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + index - 2); return date.toISOString().slice(0, 10);
  });
  return dates.map((date) => {
    const dayTasks = tasks.filter((task) => task.startDate <= date && task.dueDate >= date).slice(0, 5);
    return `<div class="day-card"><h4>${fmtDate(date)}</h4>${dayTasks.length ? dayTasks.map((task) => `<div class="day-item"><b>${esc(task.assignee?.name || '')}</b>: ${esc(task.title)}</div>`).join('') : '<div class="muted" style="font-size:12px">Không có việc</div>'}</div>`;
  }).join('');
}

function renderPersonnel() {
  if (!isAdmin()) return lockMessage('Chỉ tài khoản Admin được quản lý hồ sơ nhân sự và phân quyền.');
  return `
    <div class="two-col">
      <div class="card pad">
        <h2 class="card-title">Thêm nhân sự</h2>
        <p class="card-subtitle" style="margin-top:5px">Admin tạo hồ sơ và set loại tài khoản cho hệ thống.</p>
        <form id="personForm" style="margin-top:16px">
          <div class="form-grid">
            <div class="field span-2"><label>Họ và tên</label><input name="name" required placeholder="VD: Nguyễn Văn A" /></div>
            <div class="field"><label>Tên đăng nhập</label><input name="username" required placeholder="vd.nguyenvana" /></div>
            <div class="field"><label>Mật khẩu khởi tạo</label><input name="password" placeholder="Mặc định: welcome123" /></div>
            <div class="field"><label>Loại tài khoản</label><select name="role">${Object.values(ROLES).map((role) => `<option>${esc(role)}</option>`).join('')}</select></div>
            <div class="field"><label>Ngày tháng năm sinh</label><input name="birthDate" type="date" /></div>
            <div class="field"><label>Học vị</label><input name="degree" placeholder="VD: Thạc sĩ" /></div>
            <div class="field"><label>Học hàm</label><input name="academicRank" placeholder="VD: PGS." /></div>
            <div class="field span-2"><label>Nghề nghiệp</label><input name="occupation" placeholder="VD: Nghiên cứu viên" /></div>
            <div class="field span-2"><label>Đơn vị công tác</label><input name="unit" placeholder="VD: IRDRC - UEH" /></div>
            <div class="field span-2"><label>Quê quán</label><input name="hometown" placeholder="VD: Đồng Tháp" /></div>
          </div>
          <div class="form-footer"><button class="btn btn-primary" type="submit">Thêm nhân sự</button></div>
        </form>
      </div>
      <div class="card pad">
        <h2 class="card-title">Danh sách tài khoản</h2>
        <p class="card-subtitle" style="margin-top:5px">Cập nhật quyền trực tiếp cho từng hồ sơ.</p>
        <div class="compact-list" style="margin-top:16px;max-height:690px">${state.directory.map((user) => `
          <div class="list-row">
            <div style="display:flex;gap:10px;min-width:0"><div class="account-avatar">${esc(user.initials || initials(user.name))}</div><div><strong>${esc(user.name)}</strong><div class="list-meta">${rolePill(user.role)} · ${esc(user.unit || 'Chưa cập nhật đơn vị')}</div><div class="list-meta">${esc(user.username)}</div></div></div>
            <button class="btn btn-small" data-action="edit-user" data-id="${esc(user.id)}">Cập nhật</button>
          </div>`).join('')}</div>
      </div>
    </div>`;
}

function renderProjectCreate() {
  if (!isWorker()) return lockMessage('Cộng tác viên chỉ được nhận việc; không có quyền tạo hoặc quản trị dự án.');
  const filtered = state.projects.filter((project) => {
    return (!state.projectFilters.group || project.group === state.projectFilters.group) && (!state.projectFilters.province || project.province === state.projectFilters.province);
  });
  const provinces = [...new Set(state.projects.map((project) => project.province).filter(Boolean))];
  return `
    <div class="two-col">
      <div class="card pad">
        <h2 class="card-title">Form tạo dự án</h2>
        <form id="projectForm" style="margin-top:16px">
          ${projectFormFields({ ownerId: state.user.id, coLeadIds: [], memberIds: [] })}
          <div class="form-footer"><button class="btn" type="reset">Xóa form</button><button class="btn btn-primary" type="submit">Tạo dự án</button></div>
        </form>
      </div>
      <div class="card pad">
        <div class="section-title" style="margin-top:0"><h2>Danh sách dự án</h2><p>${filtered.length}/${state.projects.length} dự án</p></div>
        <div class="list-toolbar">
          <div class="field"><label>Nhóm việc</label><select id="projectGroupFilter">${optionList(['Tất cả nhóm việc', ...GROUPS], state.projectFilters.group, true)}</select></div>
          <div class="field"><label>Tỉnh</label><select id="projectProvinceFilter">${optionList(['Tất cả tỉnh', ...provinces], state.projectFilters.province, true)}</select></div>
          <div></div><button class="btn" id="projectFilterReset" type="button">Xóa lọc</button>
        </div>
        <div class="compact-list">${filtered.length ? filtered.map(projectRow).join('') : '<div class="empty">Không có dự án phù hợp bộ lọc.</div>'}</div>
      </div>
    </div>`;
}

function projectFormFields(project) {
  const editableOwners = state.directory.filter((user) => user.role !== ROLES.COLLAB);
  const memberIds = new Set(project.memberIds || []);
  return `<div class="form-grid">
    <div class="field span-2"><label>Tên dự án</label><input name="title" required value="${esc(project.title || '')}" placeholder="VD: Đề tài KX Đổi mới sáng tạo vùng ĐBSCL" /></div>
    <div class="field"><label>Chủ trì / Điều phối</label><select name="ownerId">${editableOwners.map((user) => `<option value="${esc(user.id)}" ${user.id === project.ownerId ? 'selected' : ''}>${esc(user.name)} — ${esc(user.role)}</option>`).join('')}</select></div>
    <div class="field"><label>Nhóm việc</label><select name="group">${GROUPS.map((group) => `<option ${group === project.group ? 'selected' : ''}>${esc(group)}</option>`).join('')}</select></div>
    <div class="field span-2"><label>Đồng chủ trì / Điều phối</label><select name="coLeadIds" multiple size="4">${editableOwners.map((user) => `<option value="${esc(user.id)}" ${(project.coLeadIds || []).includes(user.id) ? 'selected' : ''}>${esc(user.name)} — ${esc(user.role)}</option>`).join('')}</select><p class="field-note">Giữ Ctrl/Cmd để chọn nhiều người khi cần.</p></div>
    <div class="field span-2"><label>Thành viên tham gia</label>${memberPicker(memberIds)}</div>
    <div class="field"><label>Ưu tiên</label><select name="priority">${PRIORITIES.map((priority) => `<option ${priority === project.priority ? 'selected' : ''}>${esc(priority)}</option>`).join('')}</select></div>
    <div class="field"><label>Ngày bắt đầu</label><input name="startDate" type="date" value="${esc(project.startDate || today())}" required /></div>
    <div class="field"><label>Thời hạn dự kiến</label><input name="endDate" type="date" value="${esc(project.endDate || '')}" required /></div>
    <div class="field"><label>Địa phương — Tỉnh</label><input name="province" value="${esc(project.province || '')}" placeholder="VD: Đồng Tháp" /></div>
    <div class="field span-2"><label>Địa phương — Xã</label><input name="commune" value="${esc(project.commune || '')}" placeholder="VD: Xã Phước Vĩnh Tây" /></div>
    <div class="field span-2"><label>Đường link hồ sơ dự án</label><input name="evidenceLink" value="${esc(project.evidenceLink || '')}" placeholder="Dán link Google Drive, OneDrive, hồ sơ nội bộ..." /></div>
    <div class="field span-4"><label>Mô tả / phạm vi dự án</label><textarea name="description" placeholder="Mục tiêu, phạm vi công việc, yêu cầu phối hợp, đối tác liên quan...">${esc(project.description || '')}</textarea></div>
    <div class="field span-4"><label>Sản phẩm đầu ra dự kiến</label><textarea name="deliverable" placeholder="VD: báo cáo nghiên cứu, đề án tư vấn, bộ dữ liệu, bài công bố, tài liệu tập huấn...">${esc(project.deliverable || '')}</textarea></div>
  </div>`;
}

function memberPicker(selected) {
  return `<div class="member-picker">
    <input class="member-search" type="search" placeholder="Nhập tên thành viên để tìm kiếm..." />
    <div class="member-options">${state.directory.map((user) => `<label class="member-option" data-member-name="${esc(user.name.toLowerCase())}"><input class="member-checkbox" type="checkbox" value="${esc(user.id)}" ${selected.has(user.id) ? 'checked' : ''} /><span>${esc(user.name)} — ${esc(user.role)}</span></label>`).join('')}</div>
    <p class="field-note">Có thể tìm kiếm và chọn nhiều thành viên cho một dự án.</p>
  </div>`;
}

function projectRow(project) {
  return `<button class="list-row is-clickable" data-action="open-project" data-id="${esc(project.id)}"><span><strong>${esc(project.title)}</strong><span class="list-meta">${priorityPill(project.priority)} <span class="pill progress">${esc(project.group)}</span> · ${esc(project.province || 'Chưa xác định tỉnh')} · ${project.taskCount || 0} đầu việc</span></span><span class="list-chevron">›</span></button>`;
}

function renderProjectCoordination() {
  if (!isWorker()) return lockMessage('Cộng tác viên không có quyền điều phối dự án.');
  const projects = state.projects.filter(canEditProject);
  return `<div class="grid grid-2">
    <div class="card pad"><div class="info-banner"><strong>Dự án điều phối</strong><br />Các dự án bạn là Chủ trì/Điều phối hoặc Đồng chủ trì/Điều phối. Nhấp vào từng dự án để xem chi tiết và tạo nhiều công việc liên kết.</div>
    <div class="kpi-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:14px">${kpi('Dự án phụ trách', projects.length, 'Chủ trì hoặc đồng chủ trì')}${kpi('Đầu việc liên kết', projects.reduce((sum, project) => sum + (project.taskCount || 0), 0), 'Tổng công việc thuộc dự án')}</div>
    <div class="compact-list">${projects.length ? projects.map(projectRow).join('') : '<div class="empty">Bạn chưa được phân công điều phối dự án nào.</div>'}</div></div>
    <div class="card pad"><h2 class="card-title">Quyền điều phối</h2><div class="detail-block"><h4>1. Xem thông tin dự án</h4><p>Tra cứu chủ trì, đồng chủ trì, thành viên, địa phương, đầu ra và các đầu việc liên kết.</p></div><div class="detail-block"><h4>2. Cập nhật dự án</h4><p>Điều chỉnh thông tin khi bạn là Chủ trì hoặc Đồng chủ trì/Điều phối.</p></div><div class="detail-block"><h4>3. Tạo công việc liên kết</h4><p>Tạo nhiều đầu việc ngay trong cửa sổ chi tiết dự án. Việc mới luôn được gửi đến đúng nhân sự ở trạng thái Mới giao.</p></div></div>
  </div>`;
}

function renderTasksAssign() {
  if (!isWorker()) return lockMessage('Cộng tác viên không được tạo hoặc giao công việc.');
  const projects = ownedProjects();
  const assigned = tasksForCurrentAssigner().filter((task) => {
    return (!state.assignFilters.project || task.projectId === state.assignFilters.project) && (!state.assignFilters.assignee || task.assigneeId === state.assignFilters.assignee) && (!state.assignFilters.status || task.status === state.assignFilters.status);
  });
  return `<div class="two-col">
    <div class="card pad">
      <h2 class="card-title">Form giao việc</h2>
      ${projects.length ? `<form id="taskForm" style="margin-top:16px">${taskFormFields(projects[0])}<div class="form-footer"><button class="btn" type="reset">Xóa form</button><button class="btn btn-primary" type="submit">Giao việc</button></div></form>` : '<div class="warning-banner" style="margin-top:14px">Bạn cần là Chủ trì hoặc Đồng chủ trì của ít nhất một dự án trước khi giao việc.</div>'}
    </div>
    <div class="card pad">
      <div class="section-title" style="margin-top:0"><h2>Danh sách công việc</h2><p>${assigned.length}/${tasksForCurrentAssigner().length} việc</p></div>
      <p class="card-subtitle" style="margin:0 0 12px">Lọc nhanh và nhấp vào từng đầu việc để xem toàn bộ thông tin giao việc.</p>
      <div class="list-toolbar">
        <div class="field"><label>Dự án</label><select id="assignProjectFilter">${projectOptionList(state.assignFilters.project, true, state.projects)}</select></div>
        <div class="field"><label>Người nhận</label><select id="assignAssigneeFilter">${userOptionList(state.assignFilters.assignee, true)}</select></div>
        <div class="field"><label>Trạng thái</label><select id="assignStatusFilter">${statusOptionList(state.assignFilters.status, true)}</select></div>
        <button class="btn" id="assignFilterReset" type="button">Xóa lọc</button>
      </div>
      <div class="compact-list">${assigned.length ? assigned.map(taskRow).join('') : '<div class="empty">Không có công việc phù hợp bộ lọc.</div>'}</div>
    </div>
  </div>`;
}

function taskFormFields(defaultProject) {
  const project = defaultProject || ownedProjects()[0];
  const members = project ? taskEligibleMembers(project) : [];
  return `<div class="form-grid">
    <div class="field span-2"><label>Tên đầu việc</label><input name="title" required placeholder="VD: Hoàn thiện báo cáo công việc đề tài KX" /></div>
    <div class="field"><label>Người nhận</label><select name="assigneeId" id="taskAssignee">${members.map((user) => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Người giao</label><input class="readonly-input" value="${esc(state.user.name)}" disabled /></div>
    <div class="field"><label>Nhóm việc</label><select name="group">${GROUPS.map((group) => `<option ${group === project?.group ? 'selected' : ''}>${esc(group)}</option>`).join('')}</select></div>
    <div class="field"><label>Thuộc dự án</label><select name="projectId" id="taskProject">${ownedProjects().map((item) => `<option value="${esc(item.id)}" ${item.id === project?.id ? 'selected' : ''}>${esc(item.title)}</option>`).join('')}</select></div>
    <div class="field"><label>Ưu tiên</label><select name="priority">${PRIORITIES.map((priority) => `<option ${priority === 'Cao' ? 'selected' : ''}>${esc(priority)}</option>`).join('')}</select></div>
    <div class="field"><label>Ngày bắt đầu</label><input name="startDate" type="date" value="${today()}" required /></div>
    <div class="field"><label>Deadline</label><input name="dueDate" type="date" value="${addDaysLocal(3)}" required /></div>
    <div class="field span-4"><label>Mô tả yêu cầu</label><textarea name="description" placeholder="Nội dung, chuẩn đầu ra, lưu ý phối hợp..."></textarea></div>
    <div class="field span-4"><label>Sản phẩm đầu ra cần nộp</label><textarea name="deliverable" placeholder="VD: file báo cáo Word, bộ dữ liệu Excel, bài viết, bộ slide..."></textarea></div>
    <div class="field span-4"><label>Đường link minh chứng / sản phẩm đầu ra</label><input name="evidenceLink" placeholder="Dán link Google Drive, OneDrive, thư mục nội bộ, email hoặc website..." /></div>
  </div>`;
}

function taskEligibleMembers(project) {
  return [...new Set([project.ownerId, ...(project.coLeadIds || []), ...(project.memberIds || [])])].map(userById).filter(Boolean);
}
function addDaysLocal(days) { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }
function projectOptionList(selected, label = false, projects = state.projects) { return `${label ? '<option value="">Tất cả dự án</option>' : ''}${projects.map((project) => `<option value="${esc(project.id)}" ${project.id === selected ? 'selected' : ''}>${esc(project.title)}</option>`).join('')}`; }
function userOptionList(selected, label = false) { return `${label ? '<option value="">Tất cả nhân sự</option>' : ''}${state.directory.map((user) => `<option value="${esc(user.id)}" ${user.id === selected ? 'selected' : ''}>${esc(user.name)}</option>`).join('')}`; }
function statusOptionList(selected, label = false) { return `${label ? '<option value="">Tất cả trạng thái</option>' : ''}${Object.entries(STATUS).map(([value, labelText]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${esc(labelText)}</option>`).join('')}`; }
function taskRow(task) {
  return `<button class="list-row is-clickable" data-action="open-task" data-id="${esc(task.id)}"><span><strong>${esc(task.title)}</strong><span class="list-meta">${esc(task.assignee?.name || userName(task.assigneeId))} · DL ${fmtDate(task.dueDate)} ${statusPill(task.status)} ${isLate(task) ? '<span class="pill rejected">Quá hạn</span>' : ''}</span></span><span class="list-chevron">›</span></button>`;
}

function renderTasksList() {
  const tasks = tasksForCurrentAssignee().filter((task) => (!state.taskFilters.project || task.projectId === state.taskFilters.project) && (!state.taskFilters.status || task.status === state.taskFilters.status));
  const lanes = [
    ['NEW', 'Mới giao'],
    ['IN_PROGRESS', 'Đang làm'],
    ['PENDING', 'Chờ duyệt'],
    ['DONE', 'Hoàn thành']
  ];
  return `<div class="card pad">
    <div class="section-title" style="margin-top:0"><h2>Danh sách công việc</h2><p>Chỉ công việc được giao cho ${esc(state.user.name)}</p></div>
    <div class="info-banner">Việc <b>Mới giao</b> chỉ được xem chi tiết, nhận việc hoặc từ chối. Sau khi <b>Nhận việc</b>, bạn mới được cập nhật tiến độ. Nút <b>Nộp duyệt</b> chỉ xuất hiện khi tiến độ đạt 100%.</div>
    <div class="list-toolbar" style="grid-template-columns:1fr 1fr auto">
      <div class="field"><label>Dự án</label><select id="myProjectFilter">${projectOptionList(state.taskFilters.project, true)}</select></div>
      <div class="field"><label>Trạng thái</label><select id="myStatusFilter">${statusOptionList(state.taskFilters.status, true)}</select></div>
      <button class="btn" id="myFilterReset" type="button">Xóa lọc</button>
    </div>
    <div class="kanban">${lanes.map(([status, label]) => `<div class="lane"><h3>${label}<span>${tasks.filter((task) => task.status === status).length}</span></h3>${tasks.filter((task) => task.status === status).map(myTaskCard).join('') || '<div class="empty">Trống</div>'}</div>`).join('')}</div>
  </div>`;
}

function myTaskCard(task) {
  const actions = [];
  if (task.status === 'NEW') {
    actions.push(`<button class="btn btn-small" data-action="open-task" data-id="${esc(task.id)}">Chi tiết</button>`);
    actions.push(`<button class="btn btn-small btn-primary" data-action="accept-task" data-id="${esc(task.id)}">Nhận việc</button>`);
    actions.push(`<button class="btn btn-small" data-action="decline-task" data-id="${esc(task.id)}">Từ chối</button>`);
  } else {
    actions.push(`<button class="btn btn-small" data-action="open-task" data-id="${esc(task.id)}">Chi tiết</button>`);
    if (task.status === 'IN_PROGRESS') {
      actions.push(`<button class="btn btn-small" data-action="progress-task" data-id="${esc(task.id)}">Cập nhật</button>`);
      if (task.progress === 100) actions.push(`<button class="btn btn-small btn-primary" data-action="submit-task" data-id="${esc(task.id)}">Nộp duyệt</button>`);
    }
  }
  return `<div class="task-card"><h4>${esc(task.title)}</h4><p>${esc(task.project?.title || projectById(task.projectId)?.title || '')}</p><div class="list-meta">${priorityPill(task.priority)} ${statusPill(task.status)}</div><div class="task-card-footer"><span class="muted" style="font-size:12px">DL: ${fmtDate(task.dueDate)}</span><b>${task.progress}%</b></div><div class="progress-line"><div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, task.progress))}%"></div></div></div><div class="task-card-actions">${actions.join('')}</div></div>`;
}

function renderTasksReview() {
  if (!isWorker()) return lockMessage('Cộng tác viên không được duyệt công việc.');
  const tasks = tasksForCurrentAssigner().filter((task) => task.status === 'PENDING');
  return `<div class="two-col">
    <div class="card pad"><div class="info-banner"><strong>Nguyên tắc duyệt</strong><br />Người duyệt được cố định là người giao việc. Khi không duyệt, cần nêu rõ lý do; hệ thống sẽ tạo công việc mới <b>CHỈNH SỬA [tên việc cũ]</b> cho đúng người nhận.</div><div class="kpi-grid" style="grid-template-columns:1fr"><div class="card kpi"><div class="kpi-label">Công việc chờ duyệt</div><div class="kpi-value">${tasks.length}</div><div class="kpi-note">Thuộc các đầu việc bạn đã giao</div></div></div></div>
    <div class="card pad"><div class="section-title" style="margin-top:0"><h2>Danh sách chờ duyệt</h2><p>Nhấp để xem thông tin đầy đủ</p></div><div class="compact-list">${tasks.length ? tasks.map(taskRow).join('') : '<div class="empty">Không có công việc nào chờ bạn duyệt.</div>'}</div></div>
  </div>`;
}

function renderTasksAdjustment() {
  if (!isWorker()) return lockMessage('Cộng tác viên không được điều chỉnh công việc.');
  const tasks = tasksForCurrentAssigner().filter((task) => task.status === 'ADJUSTMENT');
  return `<div class="two-col">
    <div class="card pad"><div class="danger-banner"><strong>Công việc chờ điều chỉnh</strong><br />Các việc này đã bị người nhận từ chối. Bạn cần mở chi tiết, xem lý do và khuyến nghị, sau đó cập nhật lại trường dữ liệu để giao lại.</div><div class="kpi-grid" style="grid-template-columns:1fr"><div class="card kpi"><div class="kpi-label">Chờ điều chỉnh</div><div class="kpi-value">${tasks.length}</div><div class="kpi-note">Cần phản hồi và giao lại cho nhân sự</div></div></div></div>
    <div class="card pad"><div class="section-title" style="margin-top:0"><h2>Danh sách điều chỉnh</h2><p>Nhấp vào việc để cập nhật</p></div><div class="compact-list">${tasks.length ? tasks.map(taskRow).join('') : '<div class="empty">Không có công việc nào chờ điều chỉnh.</div>'}</div></div>
  </div>`;
}

function renderProducts() {
  const tasks = state.tasks.filter((task) => task.deliverable);
  return `<div class="section-title" style="margin-top:0"><h2>Sản phẩm tuần phải có</h2><p>Đầu ra, trạng thái, người phụ trách và link minh chứng</p></div>
    <div class="product-grid">${tasks.length ? tasks.map((task) => `<article class="product-card"><h3>${esc(task.deliverable)}</h3><p><b>${esc(task.assignee?.name || userName(task.assigneeId))}</b><br>${esc(task.project?.title || projectById(task.projectId)?.title || '')}<br>${statusPill(task.status)}<br>${task.evidenceLink ? `<a href="${esc(task.evidenceLink)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;color:#0c746b;font-weight:800">Mở minh chứng ↗</a>` : '<span style="display:inline-block;margin-top:8px">Chưa gắn link minh chứng</span>'}</p></article>`).join('') : '<div class="empty">Chưa có sản phẩm đầu ra.</div>'}</div>
    <div class="section-title"><h2>Ma trận sản phẩm theo người phụ trách</h2><p>Kiểm tra đủ file, deadline và minh chứng</p></div>
    <div class="card pad"><div class="table-wrap"><table><thead><tr><th>Sản phẩm</th><th>Người phụ trách</th><th>Dự án</th><th>Deadline</th><th>Trạng thái</th><th>Minh chứng</th></tr></thead><tbody>${tasks.map((task) => `<tr><td><b>${esc(task.deliverable)}</b></td><td>${esc(task.assignee?.name || userName(task.assigneeId))}</td><td>${esc(task.project?.title || '')}</td><td>${fmtDate(task.dueDate)}</td><td>${statusPill(task.status)}</td><td>${task.evidenceLink ? `<a href="${esc(task.evidenceLink)}" target="_blank" rel="noopener" style="color:#0f766e;font-weight:800">Mở link ↗</a>` : '<span class="muted">Chưa có</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function renderEvaluation() {
  if (!isWorker()) return lockMessage('Cộng tác viên không có quyền xem đánh giá tổng hợp.');
  const people = state.directory.filter((user) => state.tasks.some((task) => task.assigneeId === user.id));
  const scored = people.map((person) => scorePerson(person));
  const avgScore = scored.length ? Math.round(scored.reduce((sum, item) => sum + item.score, 0) / scored.length) : 0;
  return `<div class="kpi-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">${kpi('Nhân sự có tải cao', scored.filter((x) => x.total >= 5).length, 'Từ 5 việc trở lên')}${kpi('Thiếu minh chứng', state.tasks.filter((task) => task.status === 'DONE' && task.deliverable && !task.evidenceLink).length, 'Đầu ra chưa gắn link')}${kpi('Cần lãnh đạo duyệt', state.tasks.filter((task) => task.status === 'PENDING').length, 'Toàn bộ phạm vi xem')}${kpi('Điểm hiệu suất TB', avgScore, 'Thang 100')}</div>
    <div class="section-title"><h2>Xếp hạng hiệu suất nhân sự</h2><p>Minh họa theo tiến độ, quá hạn, hoàn thành và tải việc</p></div>
    <div class="people-grid">${scored.map((row) => `<article class="person-card"><div class="account-avatar">${esc(row.person.initials || initials(row.person.name))}</div><h3>${esc(row.person.name)}</h3><p>${esc(row.person.role)}</p><div class="score">${row.score}</div><p>${row.total} việc · ${row.done} hoàn thành · ${row.late} quá hạn</p></article>`).join('')}</div>
    <div class="section-title"><h2>Bảng đánh giá chi tiết</h2><p>Công thức minh họa, cần tinh chỉnh khi áp dụng KPI chính thức</p></div>
    <div class="card pad"><div class="table-wrap"><table><thead><tr><th>Nhân sự</th><th>Tổng việc</th><th>Hoàn thành</th><th>Quá hạn</th><th>Tiến độ TB</th><th>Điểm</th><th>Nhận định</th></tr></thead><tbody>${scored.map((row) => `<tr><td><b>${esc(row.person.name)}</b></td><td>${row.total}</td><td>${row.done}</td><td>${row.late}</td><td>${row.progress}%</td><td><b>${row.score}</b></td><td>${row.late ? 'Cần xử lý deadline và phản hồi sớm hơn.' : row.score >= 80 ? 'Hiệu suất ổn định, có thể giao việc trọng tâm.' : 'Cần tăng tốc và chuẩn hóa đầu ra.'}</td></tr>`).join('')}</tbody></table></div></div>`;
}

function scorePerson(person) {
  const tasks = state.tasks.filter((task) => task.assigneeId === person.id);
  if (!tasks.length) return { person, score: 70, total: 0, done: 0, late: 0, progress: 0 };
  const done = tasks.filter((task) => task.status === 'DONE').length;
  const late = tasks.filter(isLate).length;
  const progress = Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length);
  const score = Math.max(0, Math.min(100, Math.round(55 + (done / tasks.length) * 25 + progress * .25 - late * 9 - Math.max(0, tasks.length - 5) * 3)));
  return { person, score, total: tasks.length, done, late, progress };
}

function renderPeople() {
  return `<div class="section-title" style="margin-top:0"><h2>Hồ sơ công việc theo nhân sự</h2><p>Thành viên và tải công việc trong phạm vi truy cập</p></div><div class="people-grid">${state.directory.map((user) => {
    const own = state.tasks.filter((task) => task.assigneeId === user.id);
    return `<article class="person-card"><div class="account-avatar">${esc(user.initials || initials(user.name))}</div><h3>${esc(user.name)}</h3><p>${esc(user.role)}</p><p style="margin-top:8px">${esc(user.occupation || 'Chưa cập nhật nghề nghiệp')}</p><div class="score">${own.length}</div><p>công việc được giao</p></article>`;
  }).join('')}</div>`;
}

function lockMessage(message) {
  return `<div class="card pad"><div class="warning-banner"><strong>Quyền truy cập bị giới hạn</strong><br />${esc(message)}</div></div>`;
}

function bindRouteEvents() {
  // Generic clickable actions
  $$('[data-action]').forEach((node) => node.addEventListener('click', handleAction));

  // Search input of member pickers
  $$('.member-search').forEach((input) => input.addEventListener('input', () => {
    const term = input.value.toLowerCase().trim();
    $$('.member-option', input.closest('.member-picker')).forEach((option) => {
      option.hidden = !!term && !option.dataset.memberName.includes(term);
    });
  }));

  if (state.route === 'dashboard') {
    $('#dashGroupFilter').addEventListener('change', (event) => { state.dashboardFilters.group = event.target.value; render(); });
    $('#dashPersonFilter').addEventListener('change', (event) => { state.dashboardFilters.person = event.target.value; render(); });
    $('#dashReset').addEventListener('click', () => { state.dashboardFilters = { group: '', person: '' }; render(); });
    requestAnimationFrame(drawDashboardCharts);
  }
  if (state.route === 'personnel') $('#personForm')?.addEventListener('submit', createPersonnel);
  if (state.route === 'project-create') {
    $('#projectForm')?.addEventListener('submit', createProject);
    $('#projectGroupFilter').addEventListener('change', (event) => { state.projectFilters.group = event.target.value; render(); });
    $('#projectProvinceFilter').addEventListener('change', (event) => { state.projectFilters.province = event.target.value; render(); });
    $('#projectFilterReset').addEventListener('click', () => { state.projectFilters = { group: '', province: '' }; render(); });
  }
  if (state.route === 'tasks-assign') {
    $('#taskForm')?.addEventListener('submit', createTask);
    $('#taskProject')?.addEventListener('change', updateTaskAssigneeChoices);
    $('#assignProjectFilter').addEventListener('change', (event) => { state.assignFilters.project = event.target.value; render(); });
    $('#assignAssigneeFilter').addEventListener('change', (event) => { state.assignFilters.assignee = event.target.value; render(); });
    $('#assignStatusFilter').addEventListener('change', (event) => { state.assignFilters.status = event.target.value; render(); });
    $('#assignFilterReset').addEventListener('click', () => { state.assignFilters = { project: '', assignee: '', status: '' }; render(); });
  }
  if (state.route === 'tasks-list') {
    $('#myProjectFilter').addEventListener('change', (event) => { state.taskFilters.project = event.target.value; render(); });
    $('#myStatusFilter').addEventListener('change', (event) => { state.taskFilters.status = event.target.value; render(); });
    $('#myFilterReset').addEventListener('click', () => { state.taskFilters = { project: '', status: '' }; render(); });
  }
}

async function handleAction(event) {
  const { action, id } = event.currentTarget.dataset;
  if (action === 'open-project') return openProject(id);
  if (action === 'open-task') return openTask(id);
  if (action === 'accept-task') return acceptTask(id);
  if (action === 'decline-task') return openDeclineTask(id);
  if (action === 'progress-task') return openProgressTask(id);
  if (action === 'submit-task') return openSubmitTask(id);
  if (action === 'edit-user') return openUserEdit(id);
}

async function createPersonnel(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api('/api/users', { method: 'POST', body: Object.fromEntries(form.entries()) });
    await loadData(); render(); toast('Đã thêm nhân sự và tạo tài khoản.');
  } catch (error) { toast(error.message, 'error'); }
}

async function createProject(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const coLeadIds = $$('[name="coLeadIds"] option:checked', event.currentTarget).map((option) => option.value);
  const memberIds = $$('.member-checkbox:checked', event.currentTarget).map((checkbox) => checkbox.value);
  const payload = Object.fromEntries(form.entries());
  payload.coLeadIds = coLeadIds;
  payload.memberIds = memberIds;
  try {
    await api('/api/projects', { method: 'POST', body: payload });
    await loadData(); render(); toast('Đã tạo dự án mới.');
  } catch (error) { toast(error.message, 'error'); }
}

async function createTask(event) {
  event.preventDefault();
  const form = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api('/api/tasks', { method: 'POST', body: form });
    await loadData(); render(); toast('Đã giao công việc mới ở trạng thái Mới giao.');
  } catch (error) { toast(error.message, 'error'); }
}

function updateTaskAssigneeChoices(event) {
  const project = projectById(event.target.value);
  const select = $('#taskAssignee');
  select.innerHTML = taskEligibleMembers(project).map((user) => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join('');
}

function openModal(content, size = '') {
  closeModal();
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" data-modal-close><div class="modal ${size}" role="dialog" aria-modal="true">${content}</div></div>`;
  $('.modal-backdrop').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeModal(); });
  $$('.modal-close').forEach((button) => button.addEventListener('click', closeModal));
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

async function openProject(id) {
  try {
    const { project } = await api(`/api/projects/${encodeURIComponent(id)}`);
    const members = project.members || [];
    openModal(`
      <div class="modal-header"><div><h2>${esc(project.title)}</h2><p>Thông tin đầy đủ về dự án, nhân sự tham gia, địa phương, đầu ra và các đầu việc liên kết.</p></div><button class="modal-close" type="button">×</button></div>
      <div class="detail-grid">
        ${detailField('Nhóm việc', `<span class="pill progress">${esc(project.group)}</span>`)}
        ${detailField('Chủ trì / Điều phối', esc(project.owner?.name || userName(project.ownerId)))}
        ${detailField('Thành viên tham gia', `<button class="btn btn-small" id="openMembers">Xem ${members.length} thành viên</button>`)}
        ${detailField('Địa phương', esc([project.province, project.commune].filter(Boolean).join(' · ') || 'Chưa cập nhật'))}
        ${detailField('Thời gian thực hiện', `${fmtDate(project.startDate)} → ${fmtDate(project.endDate)}`)}
        ${detailField('Ưu tiên', priorityPill(project.priority))}
        ${detailField('Đầu việc liên kết', `${project.tasks?.length || 0} việc`)}
        ${detailField('Link hồ sơ dự án', project.evidenceLink ? `<a href="${esc(project.evidenceLink)}" target="_blank" rel="noopener" style="color:#0f766e;font-weight:800">Mở link ↗</a>` : 'Chưa gắn link hồ sơ')}
      </div>
      <div class="detail-block"><h4>Mô tả / phạm vi dự án</h4><p>${esc(project.description || 'Chưa cập nhật')}</p></div>
      <div class="detail-block"><h4>Sản phẩm đầu ra dự kiến</h4><p>${esc(project.deliverable || 'Chưa cập nhật')}</p></div>
      <div class="detail-block"><h4>Đầu việc liên kết</h4><div class="compact-list" style="margin-top:9px;max-height:210px">${project.tasks?.length ? project.tasks.map(taskRow).join('') : '<div class="empty">Chưa có công việc liên kết.</div>'}</div>${project.permissions?.canCreateTask ? `<div class="modal-actions"><button class="btn btn-primary" id="createLinkedTask">+ Tạo công việc</button></div>` : ''}</div>
      <div class="modal-actions">${project.permissions?.canEdit ? `<button class="btn" id="editProject">Chỉnh sửa / Cập nhật</button>` : ''}<button class="btn" type="button" id="closeProjectModal">Đóng</button></div>
    `, 'large');
    $('#closeProjectModal').addEventListener('click', closeModal);
    $('#openMembers').addEventListener('click', () => openMembers(project));
    $('#editProject')?.addEventListener('click', () => openProjectEdit(project));
    $('#createLinkedTask')?.addEventListener('click', () => openLinkedTaskCreate(project));
    $$('.modal [data-action="open-task"]').forEach((button) => button.addEventListener('click', () => openTask(button.dataset.id)));
  } catch (error) { toast(error.message, 'error'); }
}

function detailField(label, content) { return `<div class="detail-field"><span class="detail-label">${esc(label)}</span><div class="detail-value">${content}</div></div>`; }

function openMembers(project) {
  const members = project.members || [];
  openModal(`<div class="modal-header"><div><h2>Thành viên tham gia</h2><p>${esc(project.title)} · ${members.length} thành viên</p></div><button class="modal-close" type="button">×</button></div><div class="member-popup-list">${members.map((member) => `<div class="member-popup-row"><span class="member-dot"></span><div><b>${esc(member.name)}</b><div class="muted" style="font-size:12px">${esc(member.role)} · ${esc(member.occupation || 'Chưa cập nhật')}</div></div></div>`).join('') || '<div class="empty">Chưa có thành viên tham gia.</div>'}</div><div class="modal-actions"><button class="btn" type="button" id="membersBack">Đóng</button></div>`, 'small');
  $('#membersBack').addEventListener('click', closeModal);
}

function openProjectEdit(project) {
  openModal(`<div class="modal-header"><div><h2>Cập nhật dự án</h2><p>Chỉnh sửa dữ liệu dự án trong cửa sổ riêng.</p></div><button class="modal-close" type="button">×</button></div><form id="projectEditForm" style="margin-top:15px">${projectFormFields(project)}<div class="modal-actions"><button class="btn" type="button" id="cancelProjectEdit">Hủy</button><button class="btn btn-primary" type="submit">Lưu cập nhật</button></div></form>`, 'large');
  bindMemberSearch($('.modal'));
  $('#cancelProjectEdit').addEventListener('click', closeModal);
  $('#projectEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.coLeadIds = $$('[name="coLeadIds"] option:checked', event.currentTarget).map((option) => option.value);
    payload.memberIds = $$('.member-checkbox:checked', event.currentTarget).map((checkbox) => checkbox.value);
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: payload });
      await loadData(); closeModal(); render(); toast('Đã cập nhật dự án.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function openLinkedTaskCreate(project) {
  openModal(`<div class="modal-header"><div><h2>Tạo công việc liên kết</h2><p>Dự án: <b>${esc(project.title)}</b>. Có thể tạo liên tiếp nhiều công việc; việc mới sẽ gửi đến người nhận ở trạng thái Mới giao.</p></div><button class="modal-close" type="button">×</button></div><form id="linkedTaskForm" style="margin-top:15px">${linkedTaskFormFields(project)}<div class="modal-actions"><button class="btn" type="reset">Xóa form</button><button class="btn btn-primary" type="submit">Tạo công việc</button></div></form>`, 'large');
  $('#linkedTaskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api('/api/tasks', { method: 'POST', body: payload });
      await loadData();
      event.currentTarget.reset();
      toast('Đã tạo công việc liên kết và gửi đến nhân sự nhận việc.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function linkedTaskFormFields(project, task = {}) {
  const members = taskEligibleMembers(project);
  return `<div class="info-banner">Công việc tự động thuộc dự án <b>${esc(project.title)}</b> và người giao là tài khoản bạn đang đăng nhập.</div><div class="form-grid">
    <div class="field span-2"><label>Tên đầu việc</label><input name="title" required value="${esc(task.title || '')}" placeholder="VD: Hoàn thiện phần dữ liệu" /></div>
    <div class="field"><label>Người nhận</label><select name="assigneeId">${members.map((user) => `<option value="${esc(user.id)}" ${user.id === task.assigneeId ? 'selected' : ''}>${esc(user.name)}</option>`).join('')}</select></div>
    <div class="field"><label>Nhóm việc</label><select name="group">${GROUPS.map((group) => `<option ${group === (task.group || project.group) ? 'selected' : ''}>${esc(group)}</option>`).join('')}</select></div>
    <input type="hidden" name="projectId" value="${esc(project.id)}" />
    <div class="field"><label>Ưu tiên</label><select name="priority">${PRIORITIES.map((priority) => `<option ${priority === (task.priority || 'Trung bình') ? 'selected' : ''}>${esc(priority)}</option>`).join('')}</select></div>
    <div class="field"><label>Ngày bắt đầu</label><input name="startDate" type="date" required value="${esc(task.startDate || today())}" /></div>
    <div class="field"><label>Deadline</label><input name="dueDate" type="date" required value="${esc(task.dueDate || addDaysLocal(3))}" /></div>
    <div class="field span-4"><label>Mô tả yêu cầu</label><textarea name="description">${esc(task.description || '')}</textarea></div>
    <div class="field span-4"><label>Sản phẩm đầu ra cần nộp</label><textarea name="deliverable">${esc(task.deliverable || '')}</textarea></div>
    <div class="field span-4"><label>Đường link minh chứng / sản phẩm đầu ra</label><input name="evidenceLink" value="${esc(task.evidenceLink || '')}" /></div>
  </div>`;
}

async function openTask(id) {
  try {
    const { task } = await api(`/api/tasks/${encodeURIComponent(id)}`);
    const activity = (task.activity || []).slice().reverse();
    openModal(`<div class="modal-header"><div><h2>${esc(task.title)}</h2><p>${esc(task.project?.title || '')} · ${statusPill(task.status)}</p></div><button class="modal-close" type="button">×</button></div>
      <div class="detail-grid">
        ${detailField('Người giao', esc(task.assigner?.name || userName(task.assignerId)))}
        ${detailField('Người nhận', esc(task.assignee?.name || userName(task.assigneeId)))}
        ${detailField('Nhóm việc', esc(task.group))}
        ${detailField('Ngày bắt đầu', fmtDate(task.startDate))}
        ${detailField('Deadline', `${fmtDate(task.dueDate)}${isLate(task) ? ' · Quá hạn' : ''}`)}
        ${detailField('Ưu tiên', priorityPill(task.priority))}
      </div>
      <div class="progress-line"><div class="progress-track"><div class="progress-fill" style="width:${task.progress}%"></div></div><b>${task.progress}%</b></div>
      <div class="detail-block"><h4>Mô tả yêu cầu</h4><p>${esc(task.description || 'Chưa cập nhật')}</p></div>
      <div class="detail-block"><h4>Sản phẩm đầu ra cần nộp</h4><p>${esc(task.deliverable || 'Chưa cập nhật')}</p></div>
      <div class="detail-block"><h4>Đường link minh chứng</h4><p>${task.evidenceLink ? `<a href="${esc(task.evidenceLink)}" target="_blank" rel="noopener" style="color:#0f766e;font-weight:800">${esc(task.evidenceLink)} ↗</a>` : 'Chưa gắn link minh chứng'}</p></div>
      ${task.decline ? `<div class="detail-block" style="border-color:#f6c0b9;background:#fff8f7"><h4>Lý do từ chối nhận việc</h4><p><b>Lý do:</b> ${esc(task.decline.reason)}\n<b>Khuyến nghị:</b> ${esc(task.decline.recommendation || 'Không có')}</p></div>` : ''}
      ${task.approval?.decision === 'REJECTED' ? `<div class="detail-block" style="border-color:#f6c0b9;background:#fff8f7"><h4>Phản hồi không duyệt</h4><p>${esc(task.approval.reason)}</p></div>` : ''}
      <div class="detail-block"><h4>Lịch sử thao tác</h4><p>${activity.length ? activity.map((item) => `${fmtDate(item.at.slice(0,10))} · ${esc(userName(item.actorId))}: ${esc(item.note || item.type)}`).join('\n') : 'Chưa có lịch sử thao tác.'}</p></div>
      <div class="modal-actions" id="taskDetailActions">${taskActions(task)}</div>`, 'large');
    bindTaskModalActions(task);
  } catch (error) { toast(error.message, 'error'); }
}

function taskActions(task) {
  const actions = [`<button class="btn" type="button" id="closeTaskModal">Đóng</button>`];
  if (task.permissions?.canAccept) actions.unshift(`<button class="btn btn-primary" type="button" id="acceptTaskModal">Nhận việc</button>`);
  if (task.permissions?.canDecline) actions.unshift(`<button class="btn" type="button" id="declineTaskModal">Từ chối</button>`);
  if (task.permissions?.canUpdateProgress) actions.unshift(`<button class="btn" type="button" id="progressTaskModal">Cập nhật tiến độ</button>`);
  if (task.permissions?.canSubmit) actions.unshift(`<button class="btn btn-primary" type="button" id="submitTaskModal">Nộp duyệt</button>`);
  if (task.permissions?.canReview) {
    actions.unshift(`<button class="btn btn-danger" type="button" id="rejectTaskModal">Không duyệt</button>`);
    actions.unshift(`<button class="btn btn-primary" type="button" id="approveTaskModal">Duyệt</button>`);
  }
  if (task.permissions?.canEdit && task.status === 'ADJUSTMENT') actions.unshift(`<button class="btn btn-primary" type="button" id="adjustTaskModal">Cập nhật & giao lại</button>`);
  return actions.join('');
}

function bindTaskModalActions(task) {
  $('#closeTaskModal').addEventListener('click', closeModal);
  $('#acceptTaskModal')?.addEventListener('click', () => acceptTask(task.id));
  $('#declineTaskModal')?.addEventListener('click', () => openDeclineTask(task.id));
  $('#progressTaskModal')?.addEventListener('click', () => openProgressTask(task.id));
  $('#submitTaskModal')?.addEventListener('click', () => openSubmitTask(task.id));
  $('#approveTaskModal')?.addEventListener('click', () => approveTask(task.id));
  $('#rejectTaskModal')?.addEventListener('click', () => openRejectApproval(task.id));
  $('#adjustTaskModal')?.addEventListener('click', () => openTaskAdjustment(task));
}

async function acceptTask(id) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/accept`, { method: 'POST', body: {} });
    await loadData(); closeModal(); render(); toast('Đã nhận việc. Bạn có thể cập nhật tiến độ.');
  } catch (error) { toast(error.message, 'error'); }
}

function openDeclineTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  openModal(`<div class="modal-header"><div><h2>Từ chối nhận việc</h2><p>${esc(task?.title || '')}</p></div><button class="modal-close" type="button">×</button></div><form id="declineForm" style="margin-top:15px"><div class="field"><label>Lý do từ chối <span style="color:#c6291c">*</span></label><textarea name="reason" required placeholder="Nêu rõ lý do bạn chưa thể nhận công việc..."></textarea></div><div class="field" style="margin-top:12px"><label>Khuyến nghị</label><textarea name="recommendation" placeholder="Đề xuất điều chỉnh deadline, phạm vi, đầu ra, nguồn lực..."></textarea></div><div class="modal-actions"><button class="btn" type="button" id="declineCancel">Hủy</button><button class="btn btn-danger" type="submit">Xác nhận từ chối</button></div></form>`, 'small');
  $('#declineCancel').addEventListener('click', closeModal);
  $('#declineForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}/decline`, { method: 'POST', body: data });
      await loadData(); closeModal(); render(); toast('Công việc đã chuyển sang Chờ điều chỉnh.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function openProgressTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  openModal(`<div class="modal-header"><div><h2>Cập nhật tiến độ</h2><p>${esc(task?.title || '')}</p></div><button class="modal-close" type="button">×</button></div><form id="progressForm" style="margin-top:16px"><div class="field"><label>Tiến độ hoàn thành</label><input id="progressRange" name="progress" type="range" min="0" max="100" value="${task?.progress || 0}" /><div style="display:flex;justify-content:space-between;margin-top:7px"><span class="muted">0%</span><b id="progressValue">${task?.progress || 0}%</b><span class="muted">100%</span></div></div><div class="field" style="margin-top:13px"><label>Link minh chứng</label><input name="evidenceLink" value="${esc(task?.evidenceLink || '')}" placeholder="Dán link minh chứng nếu có" /></div><p class="modal-note">Khi tiến độ đạt 100%, công việc vẫn ở trạng thái Đang làm. Bạn cần bấm Nộp duyệt để chuyển cho người giao việc duyệt.</p><div class="modal-actions"><button class="btn" type="button" id="progressCancel">Hủy</button><button class="btn btn-primary" type="submit">Lưu tiến độ</button></div></form>`, 'small');
  $('#progressCancel').addEventListener('click', closeModal);
  $('#progressRange').addEventListener('input', (event) => $('#progressValue').textContent = `${event.target.value}%`);
  $('#progressForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    data.progress = Number(data.progress);
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}/progress`, { method: 'POST', body: data });
      await loadData(); closeModal(); render(); toast('Đã cập nhật tiến độ công việc.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function openSubmitTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  const reviewer = task?.assigner?.name || userName(task?.assignerId);
  openModal(`<div class="modal-header"><div><h2>Nộp duyệt công việc</h2><p>${esc(task?.title || '')}</p></div><button class="modal-close" type="button">×</button></div><div class="info-banner" style="margin-top:15px">Người duyệt được cố định là <b>${esc(reviewer)}</b> — người giao việc ban đầu.</div><form id="submitForm"><div class="field"><label>Ghi chú khi nộp duyệt</label><textarea name="note" placeholder="Tóm tắt kết quả, link đầu ra hoặc các lưu ý cho người duyệt..."></textarea></div><div class="modal-actions"><button class="btn" type="button" id="submitCancel">Hủy</button><button class="btn btn-primary" type="submit">Xác nhận nộp duyệt</button></div></form>`, 'small');
  $('#submitCancel').addEventListener('click', closeModal);
  $('#submitForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}/submit`, { method: 'POST', body: data });
      await loadData(); closeModal(); render(); toast(`Đã nộp duyệt cho ${reviewer}.`);
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function approveTask(id) {
  try {
    await api(`/api/tasks/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { note: 'Đã duyệt trên IRDRC HUB.' } });
    await loadData(); closeModal(); render(); toast('Đã duyệt công việc.');
  } catch (error) { toast(error.message, 'error'); }
}

function openRejectApproval(id) {
  const task = state.tasks.find((item) => item.id === id);
  openModal(`<div class="modal-header"><div><h2>Không duyệt công việc</h2><p>${esc(task?.title || '')}</p></div><button class="modal-close" type="button">×</button></div><form id="rejectApprovalForm" style="margin-top:15px"><div class="danger-banner">Sau khi không duyệt, hệ thống giữ lại công việc cũ để lưu vết và tự tạo việc mới <b>CHỈNH SỬA ${esc(task?.title || '')}</b> cho đúng nhân sự nhận việc.</div><div class="field" style="margin-top:12px"><label>Lý do không duyệt <span style="color:#c6291c">*</span></label><textarea name="reason" required placeholder="Nêu rõ nội dung cần chỉnh sửa..."></textarea></div><div class="modal-actions"><button class="btn" type="button" id="rejectApprovalCancel">Hủy</button><button class="btn btn-danger" type="submit">Xác nhận không duyệt</button></div></form>`, 'small');
  $('#rejectApprovalCancel').addEventListener('click', closeModal);
  $('#rejectApprovalForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}/reject-approval`, { method: 'POST', body: data });
      await loadData(); closeModal(); render(); toast('Đã không duyệt và tạo công việc chỉnh sửa mới.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function openTaskAdjustment(task) {
  const project = projectById(task.projectId);
  openModal(`<div class="modal-header"><div><h2>Điều chỉnh công việc</h2><p>Người giao cập nhật lại dữ liệu trước khi giao lại cho nhân sự.</p></div><button class="modal-close" type="button">×</button></div><div class="danger-banner" style="margin-top:14px"><b>Lý do từ chối:</b> ${esc(task.decline?.reason || 'Chưa có thông tin')}<br><b>Khuyến nghị:</b> ${esc(task.decline?.recommendation || 'Không có')}</div><form id="adjustTaskForm" style="margin-top:14px">${linkedTaskFormFields(project, task)}<div class="modal-actions"><button class="btn" type="button" id="adjustCancel">Hủy</button><button class="btn btn-primary" type="submit">Lưu và giao lại</button></div></form>`, 'large');
  $('#adjustCancel').addEventListener('click', closeModal);
  $('#adjustTaskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: payload });
      await loadData(); closeModal(); render(); toast('Đã điều chỉnh và giao lại công việc ở trạng thái Mới giao.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function openUserEdit(id) {
  const user = userById(id);
  if (!user || !isAdmin()) return;
  openModal(`<div class="modal-header"><div><h2>Cập nhật nhân sự</h2><p>${esc(user.name)}</p></div><button class="modal-close" type="button">×</button></div><form id="userEditForm" style="margin-top:15px"><div class="form-grid"><div class="field span-2"><label>Họ và tên</label><input name="name" value="${esc(user.name)}" required /></div><div class="field"><label>Loại tài khoản</label><select name="role">${Object.values(ROLES).map((role) => `<option ${role === user.role ? 'selected' : ''}>${esc(role)}</option>`).join('')}</select></div><div class="field"><label>Mật khẩu mới</label><input name="password" type="password" placeholder="Để trống nếu không đổi" /></div><div class="field"><label>Ngày sinh</label><input name="birthDate" type="date" value="${esc(user.birthDate || '')}" /></div><div class="field"><label>Học vị</label><input name="degree" value="${esc(user.degree || '')}" /></div><div class="field"><label>Học hàm</label><input name="academicRank" value="${esc(user.academicRank || '')}" /></div><div class="field"><label>Nghề nghiệp</label><input name="occupation" value="${esc(user.occupation || '')}" /></div><div class="field span-2"><label>Đơn vị công tác</label><input name="unit" value="${esc(user.unit || '')}" /></div><div class="field span-2"><label>Quê quán</label><input name="hometown" value="${esc(user.hometown || '')}" /></div></div><div class="modal-actions"><button class="btn" type="button" id="userEditCancel">Hủy</button><button class="btn btn-primary" type="submit">Lưu cập nhật</button></div></form>`, 'large');
  $('#userEditCancel').addEventListener('click', closeModal);
  $('#userEditForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      await api(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
      await loadData(); closeModal(); render(); toast('Đã cập nhật hồ sơ nhân sự.');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function bindMemberSearch(root) {
  $$('.member-search', root).forEach((input) => input.addEventListener('input', () => {
    const term = input.value.toLowerCase().trim();
    $$('.member-option', input.closest('.member-picker')).forEach((option) => { option.hidden = !!term && !option.dataset.memberName.includes(term); });
  }));
}

// Lightweight canvas charts — no external charting dependency.
function drawDashboardCharts() {
  const tasks = filterDashboardTasks();
  const assignedNames = state.directory.map((user) => user.name);
  const workload = assignedNames.map((name) => tasks.filter((task) => task.assignee?.name === name).length);
  drawBars('workloadChart', assignedNames.map((name) => name.split(' ').slice(-1)[0]), workload, '#0f7d75');
  const statusLabels = ['Mới giao', 'Đang làm', 'Chờ duyệt', 'Hoàn thành', 'Chờ điều chỉnh'];
  const statusValues = [
    tasks.filter((task) => task.status === 'NEW').length,
    tasks.filter((task) => task.status === 'IN_PROGRESS').length,
    tasks.filter((task) => task.status === 'PENDING').length,
    tasks.filter((task) => task.status === 'DONE').length,
    tasks.filter((task) => task.status === 'ADJUSTMENT').length
  ];
  drawDonut('statusChart', statusLabels, statusValues);
  const days = Array.from({ length: 5 }, (_, index) => addDaysLocal(index - 2));
  const values = days.map((day) => {
    const active = tasks.filter((task) => task.startDate <= day && task.dueDate >= day);
    return active.length ? Math.round(active.reduce((sum, task) => sum + task.progress, 0) / active.length) : 0;
  });
  drawLine('trendChart', days.map((day) => fmtDate(day).slice(0, 5)), values);
  const groupValues = GROUPS.map((group) => tasks.filter((task) => task.group === group).length);
  drawBars('groupChart', GROUPS.map((group) => group.slice(0, 10)), groupValues, '#1767d1');
}
function setCanvas(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 220;
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}
function drawBars(id, labels, values, color) {
  const canvas = $(`#${id}`); const c = setCanvas(canvas); if (!c) return;
  const { ctx, width, height } = c; const p = { l: 34, r: 12, t: 18, b: 38 }; const max = Math.max(1, ...values);
  ctx.font = '12px Barlow'; ctx.textAlign = 'center';
  ctx.strokeStyle = '#e3e9ef'; ctx.beginPath(); ctx.moveTo(p.l, height - p.b); ctx.lineTo(width - p.r, height - p.b); ctx.stroke();
  const step = (width - p.l - p.r) / Math.max(values.length, 1); const bw = Math.max(10, step * .55);
  values.forEach((value, index) => {
    const x = p.l + step * index + (step - bw) / 2;
    const bh = (height - p.t - p.b) * (value / max); const y = height - p.b - bh;
    ctx.fillStyle = color; roundedRect(ctx, x, y, bw, bh, 7, true);
    ctx.fillStyle = '#1d2c43'; ctx.font = '700 12px Barlow'; ctx.fillText(value, x + bw / 2, y - 7);
    ctx.fillStyle = '#69788f'; ctx.font = '11px Barlow'; ctx.fillText(labels[index], x + bw / 2, height - 13);
  });
}
function drawLine(id, labels, values) {
  const canvas = $(`#${id}`); const c = setCanvas(canvas); if (!c) return;
  const { ctx, width, height } = c; const p = { l: 34, r: 16, t: 20, b: 36 }; const max = Math.max(100, ...values); const step = (width - p.l - p.r) / Math.max(values.length - 1, 1);
  ctx.strokeStyle = '#e3e9ef'; ctx.beginPath(); ctx.moveTo(p.l, height - p.b); ctx.lineTo(width - p.r, height - p.b); ctx.stroke();
  ctx.strokeStyle = '#0f7d75'; ctx.lineWidth = 3; ctx.beginPath();
  values.forEach((value, index) => { const x = p.l + step * index; const y = height - p.b - (height - p.t - p.b) * value / max; if (!index) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
  values.forEach((value, index) => { const x = p.l + step * index; const y = height - p.b - (height - p.t - p.b) * value / max; ctx.fillStyle = '#18aaa0'; ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#1d2c43'; ctx.font = '700 11px Barlow'; ctx.textAlign = 'center'; ctx.fillText(`${value}%`, x, y - 9); ctx.fillStyle = '#69788f'; ctx.font = '11px Barlow'; ctx.fillText(labels[index], x, height - 12); });
}
function drawDonut(id, labels, values) {
  const canvas = $(`#${id}`); const c = setCanvas(canvas); if (!c) return;
  const { ctx, width, height } = c; const total = values.reduce((sum, value) => sum + value, 0) || 1; const colors = ['#9aa7b8', '#1767d1', '#7d4fc7', '#128350', '#c6291c']; const cx = width * .38, cy = height * .48, r = Math.min(width, height) * .28; let start = -Math.PI / 2;
  values.forEach((value, index) => { const angle = value / total * Math.PI * 2; ctx.beginPath(); ctx.arc(cx, cy, r, start, start + angle); ctx.arc(cx, cy, r * .58, start + angle, start, true); ctx.closePath(); ctx.fillStyle = colors[index]; ctx.fill(); start += angle; });
  ctx.textAlign = 'center'; ctx.fillStyle = '#1d2c43'; ctx.font = '900 29px Barlow'; ctx.fillText(total, cx, cy + 7); ctx.fillStyle = '#69788f'; ctx.font = '12px Barlow'; ctx.fillText('đầu việc', cx, cy + 28);
  ctx.textAlign = 'left'; labels.forEach((label, index) => { const y = 34 + index * 28; ctx.fillStyle = colors[index]; ctx.fillRect(width * .70, y - 10, 11, 11); ctx.fillStyle = '#4a596c'; ctx.font = '11px Barlow'; ctx.fillText(`${label}: ${values[index]}`, width * .70 + 17, y); });
}
function roundedRect(ctx, x, y, w, h, r, fill) { if (h < 0) { y += h; h = -h; } ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); if (fill) ctx.fill(); }

window.addEventListener('resize', () => { if (state.route === 'dashboard') requestAnimationFrame(drawDashboardCharts); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

bootstrap();
