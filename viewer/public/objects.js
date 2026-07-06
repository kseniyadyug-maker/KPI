const state = {
  showArchived: false,
  search: '',
  objects: [],
  managerEmployees: [],
};

const elements = {
  status: document.getElementById('objects-status'),
  showArchived: document.getElementById('show-archived-objects'),
  searchInput: document.getElementById('objects-search-input'),
  tableBody: document.getElementById('objects-table-body'),
  openCreate: document.getElementById('open-object-create'),
  createDialog: document.getElementById('object-create-dialog'),
  createForm: document.getElementById('object-create-form'),
  closeCreate: document.getElementById('close-object-create'),
  cancelCreate: document.getElementById('cancel-object-create'),
  createName: document.getElementById('object-create-name'),
  createManager: document.getElementById('object-create-manager'),
  createStatus: document.getElementById('object-create-status'),
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const payloadBody = await response.json().catch(() => ({}));
    throw new Error(payloadBody.error || `HTTP ${response.status}`);
  }

  return response.json();
}

function rowStatusLabel(isActive) {
  return isActive ? 'Активный' : 'Архив';
}

function rowStatusClass(isActive) {
  return isActive ? 'status-done' : 'status-failed';
}

function canManageObjects() {
  return Boolean(window.kpiAuth?.permissions?.canManageDirectories);
}

function applyObjectPermissions() {
  if (elements.openCreate) {
    elements.openCreate.hidden = !canManageObjects();
  }

  renderTable();
}

function parseManagerSelectValue(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return {
      managerEmployeeId: '',
      managerUserId: '',
      managerName: '',
    };
  }

  if (normalizedValue.startsWith('employee:')) {
    return {
      managerEmployeeId: normalizedValue.slice('employee:'.length),
      managerUserId: '',
      managerName: '',
    };
  }

  if (normalizedValue.startsWith('legacy:')) {
    return {
      managerEmployeeId: '',
      managerUserId: '',
      managerName: normalizedValue.slice('legacy:'.length),
    };
  }

  return {
    managerEmployeeId: '',
    managerUserId: normalizedValue,
    managerName: '',
  };
}

function normalizeManagerLookupKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const surname = parts[0].toLowerCase();
    const initials = parts
      .slice(1)
      .join('')
      .replace(/[^\p{L}]/gu, '')
      .slice(0, 2)
      .toLowerCase();

    if (initials) {
      return `${surname}|${initials}`;
    }
  }

  return normalized.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function findManagerEmployeeByName(managerName) {
  const normalizedManagerName = String(managerName || '').trim();
  if (!normalizedManagerName) {
    return null;
  }

  const exactMatch = state.managerEmployees.find((employee) => employee.fullName === normalizedManagerName);
  if (exactMatch) {
    return exactMatch;
  }

  const managerLookupKey = normalizeManagerLookupKey(normalizedManagerName);
  if (!managerLookupKey) {
    return null;
  }

  const matches = state.managerEmployees.filter((employee) => (
    normalizeManagerLookupKey(employee.fullName) === managerLookupKey
  ));
  return matches.length === 1 ? matches[0] : null;
}

function buildManagerOptions(_selectedManagerUserId = '', selectedManagerName = '') {
  const normalizedSelectedManagerName = String(selectedManagerName || '').trim();
  const options = ['<option value="">Не назначен</option>'];
  const selectedEmployee = findManagerEmployeeByName(normalizedSelectedManagerName);
  const selectedEmployeeId = selectedEmployee ? String(selectedEmployee.employeeId) : '';

  if (normalizedSelectedManagerName && !selectedEmployeeId) {
    options.push(
      `<option value="legacy:${escapeHtml(normalizedSelectedManagerName)}" selected>${escapeHtml(normalizedSelectedManagerName)} (вне списка)</option>`
    );
  }

  for (const employee of state.managerEmployees) {
    const value = `employee:${employee.employeeId}`;
    const label = employee.positionTitle
      ? `${employee.fullName} — ${employee.positionTitle}`
      : employee.fullName;
    const isSelected = selectedEmployeeId && String(employee.employeeId) === selectedEmployeeId;
    options.push(`<option value="${escapeHtml(value)}" ${isSelected ? 'selected' : ''}>${escapeHtml(label)}</option>`);
  }

  return options.join('');
}

function renderCreateManagerOptions(selectedManagerUserId = '', selectedManagerName = '') {
  if (!elements.createManager) {
    return;
  }

  elements.createManager.innerHTML = buildManagerOptions(selectedManagerUserId, selectedManagerName);
  elements.createManager.disabled = false;
}

function filteredObjects() {
  const query = state.search.trim().toLowerCase();
  return state.objects.filter((object) => !query || `${object.objectName} ${object.managerName || ''}`.toLowerCase().includes(query));
}

function resetCreateForm() {
  elements.createForm.reset();
  renderCreateManagerOptions('', '');
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

  elements.createName.focus();
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

function renderObjectsStatus(note = '') {
  const filteredCount = filteredObjects().length;
  const countLabel = filteredCount === state.objects.length ? `${filteredCount}` : `${filteredCount} из ${state.objects.length}`;
  const suffix = state.showArchived ? ' · архив показан' : '';
  const extra = note ? ` · ${note}` : '';
  elements.status.textContent = `Объектов: ${countLabel}${suffix}${extra}`;
}

function setRowMessage(objectId, message, kind = '') {
  const node = document.getElementById(`object-row-message-${objectId}`);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.className = `row-message ${kind}`.trim();
}

function getRowValues(objectId) {
  const nameInput = elements.tableBody.querySelector(`[data-object-id="${objectId}"][data-field="objectName"]`);
  const managerInput = elements.tableBody.querySelector(`[data-object-id="${objectId}"][data-field="managerName"]`);
  const managerSelection = parseManagerSelectValue(managerInput ? managerInput.value : '');
  return {
    objectName: nameInput ? nameInput.value : '',
    managerEmployeeId: managerSelection.managerEmployeeId,
    managerUserId: managerSelection.managerUserId,
    managerName: managerSelection.managerName,
  };
}

function renderTable() {
  const rows = filteredObjects();
  const canManage = canManageObjects();

  if (!rows.length) {
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="4">
          <div class="empty-state">Объекты не найдены.</div>
        </td>
      </tr>
    `;
    return;
  }

  elements.tableBody.innerHTML = rows
    .map((object) => `
      <tr class="${object.isActive ? '' : 'staff-row-archived'}">
        <td>
          <input
            class="control staff-cell-input"
            type="text"
            data-field="objectName"
            data-object-id="${object.objectId}"
            value="${escapeHtml(object.objectName)}"
            ${canManage && object.isActive ? '' : 'disabled'}
          >
        </td>
        <td>
          <select
            class="control control-select staff-cell-input"
            data-field="managerName"
            data-object-id="${object.objectId}"
            ${canManage && object.isActive ? '' : 'disabled'}
          >${buildManagerOptions(object.managerUserId, object.managerName || '')}</select>
        </td>
        <td>
          <span class="status-pill ${rowStatusClass(object.isActive)}">${rowStatusLabel(object.isActive)}</span>
        </td>
        <td>
          <div class="table-actions">
            ${!canManage
              ? '<div class="employee-pos">Только просмотр</div>'
              : object.isActive
              ? `
                <button class="action-button" type="button" data-action="save" data-object-id="${object.objectId}">Сохранить</button>
                <button class="action-button secondary" type="button" data-action="toggle-archive" data-object-id="${object.objectId}">В архив</button>
              `
              : `
                <button class="action-button danger" type="button" data-action="delete" data-object-id="${object.objectId}">Удалить</button>
                <button class="action-button secondary" type="button" data-action="toggle-archive" data-object-id="${object.objectId}">Вернуть</button>
              `}
          </div>
          <div class="row-message" id="object-row-message-${object.objectId}"></div>
        </td>
      </tr>
    `)
    .join('');

  if (!canManage) {
    return;
  }

  elements.tableBody.querySelectorAll('[data-action="save"]').forEach((button) => {
    button.addEventListener('click', () => {
      persistRow(Number(button.getAttribute('data-object-id'))).catch(showError);
    });
  });

  elements.tableBody.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => {
      deleteRow(Number(button.getAttribute('data-object-id'))).catch(showError);
    });
  });

  elements.tableBody.querySelectorAll('[data-action="toggle-archive"]').forEach((button) => {
    button.addEventListener('click', () => {
      toggleArchive(Number(button.getAttribute('data-object-id'))).catch(showError);
    });
  });
}

async function loadObjects() {
  elements.status.textContent = 'Загрузка справочника...';
  const payload = await requestJson(`/api/objects?includeArchived=${state.showArchived ? '1' : '0'}`);
  state.objects = Array.isArray(payload.objects) ? payload.objects : [];
  renderTable();
  renderObjectsStatus();
}

async function loadManagerEmployees() {
  const payload = await requestJson('/api/references');
  state.managerEmployees = Array.isArray(payload.employees)
    ? payload.employees.map((employee) => ({
      employeeId: employee.employeeId,
      fullName: employee.fullName,
      positionTitle: employee.positionTitle,
    }))
    : [];
  renderCreateManagerOptions('', '');
}

async function persistRow(objectId, options = {}) {
  const {
    pendingMessage = 'Сохранение...',
    successMessage = 'Сохранено.',
  } = options;

  setRowMessage(objectId, pendingMessage);

  try {
    const values = getRowValues(objectId);
    await sendJson(`/api/objects/${objectId}`, 'PATCH', {
      objectName: values.objectName,
      managerEmployeeId: values.managerEmployeeId,
      managerUserId: values.managerUserId,
      managerName: values.managerName,
    });
    await loadObjects();
    setRowMessage(objectId, successMessage, 'is-success');
  } catch (error) {
    setRowMessage(objectId, error.message, 'is-error');
    throw error;
  }
}

async function toggleArchive(objectId) {
  const row = state.objects.find((item) => item.objectId === objectId);
  if (!row) {
    return;
  }

  setRowMessage(objectId, row.isActive ? 'Перенос в архив...' : 'Возврат из архива...');

  try {
    const values = getRowValues(objectId);
    await sendJson(`/api/objects/${objectId}`, 'PATCH', {
      objectName: values.objectName || row.objectName,
      managerEmployeeId: values.managerEmployeeId,
      managerUserId: values.managerUserId,
      managerName: values.managerName,
      isActive: !row.isActive,
    });

    await loadObjects();
    renderObjectsStatus(row.isActive ? `архивирован ${row.objectName}` : `возвращен ${row.objectName}`);
  } catch (error) {
    setRowMessage(objectId, error.message, 'is-error');
    throw error;
  }
}

async function deleteRow(objectId) {
  const row = state.objects.find((item) => item.objectId === objectId);
  if (!row) {
    return;
  }

  if (!window.confirm(`Удалить объект "${row.objectName}"?`)) {
    return;
  }

  setRowMessage(objectId, 'Удаление...');

  try {
    await sendJson(`/api/objects/${objectId}`, 'DELETE');
    await loadObjects();
    renderObjectsStatus(`удален ${row.objectName}`);
  } catch (error) {
    setRowMessage(objectId, error.message, 'is-error');
    throw error;
  }
}

function showError(error) {
  console.error(error);
  elements.status.textContent = `Ошибка: ${error.message}`;
}

function attachEvents() {
  window.addEventListener('kpi-auth-ready', applyObjectPermissions);

  elements.showArchived.addEventListener('change', () => {
    state.showArchived = elements.showArchived.checked;
    loadObjects().catch(showError);
  });

  elements.searchInput.addEventListener('input', () => {
    state.search = elements.searchInput.value;
    renderTable();
    renderObjectsStatus();
  });

  elements.openCreate.addEventListener('click', openCreateDialog);
  elements.closeCreate.addEventListener('click', closeCreateDialog);
  elements.cancelCreate.addEventListener('click', closeCreateDialog);

  elements.createDialog.addEventListener('click', (event) => {
    const bounds = elements.createDialog.getBoundingClientRect();
    const clickedOutside = (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );

    if (clickedOutside) {
      closeCreateDialog();
    }
  });

  elements.createDialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCreateDialog();
  });

  elements.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.createStatus.textContent = 'Сохранение...';
    elements.createStatus.className = 'form-status';

    try {
      const createdName = elements.createName.value.trim();
      const createdManager = parseManagerSelectValue(elements.createManager.value);
      await sendJson('/api/objects', 'POST', {
        objectName: createdName,
        managerEmployeeId: createdManager.managerEmployeeId,
        managerUserId: createdManager.managerUserId,
        managerName: createdManager.managerName,
      });

      await loadObjects();
      closeCreateDialog();
      renderObjectsStatus(`добавлен ${createdName}`);
    } catch (error) {
      elements.createStatus.textContent = error.message;
      elements.createStatus.className = 'form-status is-error';
    }
  });
}

async function boot() {
  try {
    attachEvents();
    applyObjectPermissions();
    await loadManagerEmployees();
    await loadObjects();
  } catch (error) {
    showError(error);
  }
}

boot();
