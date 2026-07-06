const ROLE_OPTIONS = [
  { value: 'admin', label: 'Администратор' },
  { value: 'boss', label: 'Boss' },
  { value: 'manager', label: 'Руководитель' },
];

const state = {
  users: [],
  search: '',
};

const elements = {
  status: document.getElementById('users-status'),
  searchInput: document.getElementById('users-search-input'),
  tableBody: document.getElementById('users-table-body'),
  openCreate: document.getElementById('open-user-create'),
  createDialog: document.getElementById('user-create-dialog'),
  createForm: document.getElementById('user-create-form'),
  closeCreate: document.getElementById('close-user-create'),
  cancelCreate: document.getElementById('cancel-user-create'),
  createLogin: document.getElementById('user-create-login'),
  createPassword: document.getElementById('user-create-password'),
  createDisplayName: document.getElementById('user-create-display-name'),
  createShortName: document.getElementById('user-create-short-name'),
  createRole: document.getElementById('user-create-role'),
  createActive: document.getElementById('user-create-active'),
  createStatus: document.getElementById('user-create-status'),
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function buildRoleOptions(selectedValue = '') {
  return ROLE_OPTIONS
    .map((role) => (
      `<option value="${escapeHtml(role.value)}" ${role.value === selectedValue ? 'selected' : ''}>${escapeHtml(role.label)}</option>`
    ))
    .join('');
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return response.json();
}

async function sendJson(url, method, payload) {
  const options = {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  };

  if (payload !== undefined) {
    options.body = JSON.stringify(payload);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const payloadBody = await response.json().catch(() => ({}));
    throw new Error(payloadBody.error || `HTTP ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

function rowStatusLabel(isActive) {
  return isActive ? 'Активен' : 'Отключен';
}

function rowStatusClass(isActive) {
  return isActive ? 'status-done' : 'status-failed';
}

function filteredUsers() {
  const query = state.search.trim().toLowerCase();
  return state.users.filter((user) => {
    if (!query) {
      return true;
    }

    return `${user.login} ${user.displayName} ${user.employeeShortName} ${user.roleLabel}`
      .toLowerCase()
      .includes(query);
  });
}

function renderStatus(note = '') {
  const filteredCount = filteredUsers().length;
  const countLabel = filteredCount === state.users.length ? `${filteredCount}` : `${filteredCount} из ${state.users.length}`;
  elements.status.textContent = note ? `Пользователей: ${countLabel} · ${note}` : `Пользователей: ${countLabel}`;
}

function setRowMessage(userId, message, kind = '') {
  const node = document.getElementById(`user-row-message-${userId}`);
  if (!node) {
    return;
  }

  node.textContent = message;
  node.className = `row-message ${kind}`.trim();
}

function getCurrentUserId() {
  return Number(window.kpiAuth?.user?.id || 0);
}

function getRowValues(userId) {
  const getNode = (field) => elements.tableBody.querySelector(`[data-user-id="${userId}"][data-field="${field}"]`);
  return {
    login: getNode('login')?.value || '',
    displayName: getNode('displayName')?.value || '',
    employeeShortName: getNode('employeeShortName')?.value || '',
    roleCode: getNode('roleCode')?.value || '',
    isActive: Boolean(getNode('isActive')?.checked),
    password: getNode('password')?.value || '',
  };
}

function renderTable() {
  const rows = filteredUsers();
  if (!rows.length) {
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">Пользователи не найдены.</div>
        </td>
      </tr>
    `;
    return;
  }

  const currentUserId = getCurrentUserId();
  elements.tableBody.innerHTML = rows.map((user) => {
    const isCurrentUser = Number(user.userId) === currentUserId;
    return `
      <tr>
        <td>
          <input
            class="control staff-cell-input"
            type="text"
            data-user-id="${user.userId}"
            data-field="login"
            value="${escapeHtml(user.login)}"
            autocomplete="off"
          >
        </td>
        <td>
          <input
            class="control staff-cell-input"
            type="text"
            data-user-id="${user.userId}"
            data-field="displayName"
            value="${escapeHtml(user.displayName)}"
          >
          <div style="height: 8px;"></div>
          <input
            class="control staff-cell-input"
            type="text"
            data-user-id="${user.userId}"
            data-field="employeeShortName"
            value="${escapeHtml(user.employeeShortName)}"
          >
          <div class="employee-pos">Создан: ${escapeHtml(formatDateTime(user.createdAt))}</div>
          <div class="employee-pos">Последний вход: ${escapeHtml(formatDateTime(user.lastLoginAt))}</div>
        </td>
        <td>
          <select
            class="control control-select staff-cell-input"
            data-user-id="${user.userId}"
            data-field="roleCode"
          >${buildRoleOptions(user.roleCode)}</select>
        </td>
        <td>
          <label class="toggle-line">
            <input
              type="checkbox"
              data-user-id="${user.userId}"
              data-field="isActive"
              ${user.isActive ? 'checked' : ''}
              ${isCurrentUser ? 'disabled' : ''}
            >
            <span>${isCurrentUser ? 'Текущий пользователь' : 'Активен'}</span>
          </label>
          <div class="employee-pos">
            <span class="status-pill ${rowStatusClass(user.isActive)}">${rowStatusLabel(user.isActive)}</span>
          </div>
        </td>
        <td>
          <input
            class="control staff-cell-input"
            type="password"
            data-user-id="${user.userId}"
            data-field="password"
            placeholder="Оставьте пустым"
            autocomplete="new-password"
          >
        </td>
        <td>
          <div class="table-actions">
            <button class="action-button" type="button" data-action="save" data-user-id="${user.userId}">Сохранить</button>
            <button
              class="action-button ${isCurrentUser ? 'secondary' : 'danger'}"
              type="button"
              data-action="delete"
              data-user-id="${user.userId}"
              ${isCurrentUser ? 'disabled' : ''}
            >
              Удалить
            </button>
          </div>
          <div class="row-message" id="user-row-message-${user.userId}"></div>
        </td>
      </tr>
    `;
  }).join('');

  elements.tableBody.querySelectorAll('[data-action="save"]').forEach((button) => {
    button.addEventListener('click', () => {
      persistRow(Number(button.getAttribute('data-user-id'))).catch(showError);
    });
  });

  elements.tableBody.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => {
      deleteRow(Number(button.getAttribute('data-user-id'))).catch(showError);
    });
  });
}

async function loadUsers() {
  elements.status.textContent = 'Загрузка пользователей...';
  const payload = await requestJson('/api/users');
  state.users = Array.isArray(payload.users) ? payload.users : [];
  renderTable();
  renderStatus();
}

async function persistRow(userId) {
  setRowMessage(userId, 'Сохранение...');
  try {
    await sendJson(`/api/users/${userId}`, 'PATCH', getRowValues(userId));
    await loadUsers();
    setRowMessage(userId, 'Сохранено.', 'is-success');
  } catch (error) {
    setRowMessage(userId, error.message, 'is-error');
    throw error;
  }
}

async function deleteRow(userId) {
  const user = state.users.find((item) => item.userId === userId);
  if (!user) {
    return;
  }

  if (!window.confirm(`Удалить пользователя "${user.login}"?`)) {
    return;
  }

  setRowMessage(userId, 'Удаление...');
  try {
    await sendJson(`/api/users/${userId}`, 'DELETE');
    await loadUsers();
    renderStatus(`удален ${user.login}`);
  } catch (error) {
    setRowMessage(userId, error.message, 'is-error');
    throw error;
  }
}

function resetCreateForm() {
  elements.createForm.reset();
  elements.createRole.innerHTML = buildRoleOptions('manager');
  elements.createActive.checked = true;
  elements.createStatus.textContent = '';
  elements.createStatus.className = 'form-status';
}

function openCreateDialog() {
  if (elements.createDialog.hasAttribute('open')) {
    return;
  }

  resetCreateForm();
  if (typeof elements.createDialog.showModal === 'function') {
    elements.createDialog.showModal();
  } else {
    elements.createDialog.setAttribute('open', 'open');
  }

  elements.createLogin.focus();
}

function closeCreateDialog() {
  resetCreateForm();
  if (!elements.createDialog.hasAttribute('open')) {
    return;
  }

  if (typeof elements.createDialog.close === 'function') {
    elements.createDialog.close();
  } else {
    elements.createDialog.removeAttribute('open');
  }
}

function setCreateStatus(message, kind = '') {
  elements.createStatus.textContent = message;
  elements.createStatus.className = `form-status ${kind}`.trim();
}

async function submitCreateForm(event) {
  event.preventDefault();
  setCreateStatus('Создание...');

  try {
    await sendJson('/api/users', 'POST', {
      login: elements.createLogin.value,
      password: elements.createPassword.value,
      displayName: elements.createDisplayName.value,
      employeeShortName: elements.createShortName.value,
      roleCode: elements.createRole.value,
      isActive: elements.createActive.checked,
    });
    closeCreateDialog();
    await loadUsers();
    renderStatus('пользователь добавлен');
  } catch (error) {
    setCreateStatus(error.message, 'is-error');
    throw error;
  }
}

function showError(error) {
  console.error(error);
  renderStatus(`ошибка: ${error.message}`);
}

function attachEvents() {
  elements.searchInput.addEventListener('input', () => {
    state.search = elements.searchInput.value;
    renderTable();
    renderStatus();
  });

  elements.openCreate.addEventListener('click', openCreateDialog);
  elements.closeCreate.addEventListener('click', closeCreateDialog);
  elements.cancelCreate.addEventListener('click', closeCreateDialog);

  elements.createDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCreateDialog();
  });

  elements.createForm.addEventListener('submit', (event) => {
    submitCreateForm(event).catch(showError);
  });
}

async function boot() {
  try {
    attachEvents();
    resetCreateForm();
    await loadUsers();
  } catch (error) {
    showError(error);
  }
}

boot();
