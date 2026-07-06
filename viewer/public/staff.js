const state = {
  showArchived: false,
  search: '',
  objectName: '',
  periodPositionEmployeeId: null,
  staff: [],
  references: {
    objects: [],
    positions: [],
    periods: [],
  },
};

const elements = {
  status: document.getElementById('staff-status'),
  showArchived: document.getElementById('show-archived'),
  openCreate: document.getElementById('open-staff-create'),
  createDialog: document.getElementById('staff-create-dialog'),
  createForm: document.getElementById('staff-create-form'),
  closeCreate: document.getElementById('close-staff-create'),
  cancelCreate: document.getElementById('cancel-staff-create'),
  createName: document.getElementById('staff-create-name'),
  createPosition: document.getElementById('staff-create-position'),
  createPositionOptions: document.getElementById('staff-position-options'),
  periodPositionDialog: document.getElementById('staff-period-position-dialog'),
  periodPositionForm: document.getElementById('staff-period-position-form'),
  closePeriodPosition: document.getElementById('close-staff-period-position'),
  cancelPeriodPosition: document.getElementById('cancel-staff-period-position'),
  periodPositionName: document.getElementById('staff-period-position-name'),
  periodPositionValue: document.getElementById('staff-period-position-value'),
  periodPositionPeriod: document.getElementById('staff-period-position-period'),
  periodPositionStatus: document.getElementById('staff-period-position-status'),
  searchInput: document.getElementById('staff-search-input'),
  objectFilter: document.getElementById('staff-object-filter'),
  createStatus: document.getElementById('staff-create-status'),
  tableBody: document.getElementById('staff-table-body'),
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sortText(values) {
  return [...values].sort((left, right) => left.localeCompare(right, 'ru'));
}

function uniqueValues(values, selectedValue = '') {
  const unique = new Set(values.filter(Boolean));
  if (selectedValue) {
    unique.add(selectedValue);
  }
  return sortText(unique);
}

function buildSelectOptions(values, selectedValue = '', placeholder = 'Выберите значение') {
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`];
  for (const value of uniqueValues(values, selectedValue)) {
    options.push(`<option value="${escapeHtml(value)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(value)}</option>`);
  }
  return options.join('');
}

function buildDatalistOptions(values) {
  return uniqueValues(values)
    .map((value) => `<option value="${escapeHtml(value)}"></option>`)
    .join('');
}

function buildPeriodOptions(periods, selectedValue = '', placeholder = 'Выберите период') {
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`];
  for (const period of periods) {
    const code = String(period.code || '');
    const label = String(period.label || code);
    options.push(`<option value="${escapeHtml(code)}" ${code === selectedValue ? 'selected' : ''}>${escapeHtml(label)}</option>`);
  }
  return options.join('');
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

function getOpenPeriods() {
  return (state.references.periods || []).filter((period) => period.status === 'open');
}

function renderCreateFormOptions() {
  elements.createPositionOptions.innerHTML = buildDatalistOptions(state.references.positions);
}

function filteredStaff() {
  const query = state.search.trim().toLowerCase();
  return state.staff.filter((employee) => {
    const matchesSearch = !query || employee.fullName.toLowerCase().includes(query);
    const matchesObject = !state.objectName || employee.objectName === state.objectName;
    return matchesSearch && matchesObject;
  });
}

function syncObjectFilter() {
  if (!state.objectName) {
    return;
  }

  if (!state.staff.some((employee) => employee.objectName === state.objectName)) {
    state.objectName = '';
  }
}

function renderFilters() {
  elements.searchInput.value = state.search;
  elements.objectFilter.innerHTML = buildSelectOptions(
    state.staff.map((employee) => employee.objectName),
    state.objectName,
    'Все объекты'
  );
}

function resetCreateForm() {
  elements.createForm.reset();
  elements.createStatus.textContent = '';
  elements.createStatus.className = 'form-status';
}

function openCreateDialog() {
  if (elements.createDialog.hasAttribute('open')) {
    return;
  }

  resetCreateForm();
  renderCreateFormOptions();

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

function resetPeriodPositionForm() {
  state.periodPositionEmployeeId = null;
  elements.periodPositionForm.reset();
  elements.periodPositionStatus.textContent = '';
  elements.periodPositionStatus.className = 'form-status';
  elements.periodPositionName.value = '';
  elements.periodPositionValue.innerHTML = buildSelectOptions(state.references.positions, '', 'Выберите должность');
  elements.periodPositionPeriod.innerHTML = buildPeriodOptions(getOpenPeriods());
}

function closePeriodPositionDialog() {
  resetPeriodPositionForm();

  if (!elements.periodPositionDialog.hasAttribute('open')) {
    return;
  }

  if (typeof elements.periodPositionDialog.close === 'function') {
    elements.periodPositionDialog.close();
  } else {
    elements.periodPositionDialog.removeAttribute('open');
  }
}

function getRowValues(employeeId) {
  const inputs = [...elements.tableBody.querySelectorAll(`[data-employee-id="${employeeId}"][data-field]`)];
  const values = {};
  for (const input of inputs) {
    values[input.getAttribute('data-field')] = input.value;
  }
  const row = state.staff.find((item) => item.employeeId === employeeId);
  values.objectName = row ? row.objectName : '';
  return values;
}

function setRowMessage(employeeId, message, kind = '') {
  const node = document.getElementById(`row-message-${employeeId}`);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.className = `row-message ${kind}`.trim();
}

function openPeriodPositionDialog(employeeId) {
  const row = state.staff.find((item) => item.employeeId === employeeId);
  if (!row) {
    return;
  }

  const openPeriods = getOpenPeriods();
  if (!openPeriods.length) {
    setRowMessage(employeeId, 'Нет открытых KPI-периодов для смены должности.', 'is-error');
    return;
  }

  const values = getRowValues(employeeId);
  state.periodPositionEmployeeId = employeeId;
  elements.periodPositionName.value = row.fullName;
  elements.periodPositionValue.innerHTML = buildSelectOptions(
    state.references.positions,
    values.positionTitle || row.positionTitle || '',
    'Выберите должность'
  );
  elements.periodPositionPeriod.innerHTML = buildPeriodOptions(openPeriods, openPeriods[0]?.code || '');
  elements.periodPositionStatus.textContent = '';
  elements.periodPositionStatus.className = 'form-status';

  if (typeof elements.periodPositionDialog.showModal === 'function') {
    elements.periodPositionDialog.showModal();
  } else {
    elements.periodPositionDialog.setAttribute('open', 'open');
  }

  elements.periodPositionPeriod.focus();
}

function renderStaffStatus(note = '') {
  const filteredCount = filteredStaff().length;
  const countLabel = filteredCount === state.staff.length ? `${filteredCount}` : `${filteredCount} из ${state.staff.length}`;
  const suffix = state.showArchived ? ' · архив показан' : '';
  const extra = note ? ` · ${note}` : '';
  elements.status.textContent = `Сотрудников: ${countLabel}${suffix}${extra}`;
}

function renderTable() {
  const rows = filteredStaff();
  const hasOpenPeriods = getOpenPeriods().length > 0;

  if (!rows.length) {
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="4">
          <div class="empty-state">Сотрудники не найдены.</div>
        </td>
      </tr>
    `;
    return;
  }

  const positionValues = state.references.positions;

  elements.tableBody.innerHTML = rows
    .map((employee) => `
      <tr class="${employee.isActive ? '' : 'staff-row-archived'}">
        <td>
          <div class="employee-name">${escapeHtml(employee.fullName)}</div>
        </td>
        <td>
          <select
            class="control control-select staff-cell-input"
            data-field="positionTitle"
            data-employee-id="${employee.employeeId}"
            ${employee.isActive ? '' : 'disabled'}
          >
            ${buildSelectOptions(positionValues, employee.positionTitle, 'Выберите должность')}
          </select>
        </td>
        <td>
          <span class="status-pill ${rowStatusClass(employee.isActive)}">${rowStatusLabel(employee.isActive)}</span>
        </td>
        <td>
          <div class="table-actions">
            ${employee.isActive
              ? `
                <button class="action-button" type="button" data-action="save" data-employee-id="${employee.employeeId}">Сохранить</button>
                <button class="action-button secondary" type="button" data-action="change-period-position" data-employee-id="${employee.employeeId}" ${hasOpenPeriods ? '' : 'disabled'}>В период</button>
                <button class="action-button secondary" type="button" data-action="toggle-archive" data-employee-id="${employee.employeeId}">В архив</button>
              `
              : `
                <button class="action-button danger" type="button" data-action="delete" data-employee-id="${employee.employeeId}">Удалить</button>
                <button class="action-button secondary" type="button" data-action="toggle-archive" data-employee-id="${employee.employeeId}">Вернуть</button>
              `}
          </div>
          <div class="row-message" id="row-message-${employee.employeeId}"></div>
        </td>
      </tr>
    `)
    .join('');

  elements.tableBody.querySelectorAll('[data-action="save"]').forEach((button) => {
    button.addEventListener('click', () => {
      persistRow(Number(button.getAttribute('data-employee-id'))).catch(showError);
    });
  });

  elements.tableBody.querySelectorAll('[data-action="change-period-position"]').forEach((button) => {
    button.addEventListener('click', () => {
      openPeriodPositionDialog(Number(button.getAttribute('data-employee-id')));
    });
  });

  elements.tableBody.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => {
      deleteRow(Number(button.getAttribute('data-employee-id'))).catch(showError);
    });
  });

  elements.tableBody.querySelectorAll('[data-action="toggle-archive"]').forEach((button) => {
    button.addEventListener('click', () => {
      toggleArchive(Number(button.getAttribute('data-employee-id'))).catch(showError);
    });
  });
}

async function loadReferences() {
  const payload = await requestJson('/api/references');
  state.references = payload;
  renderCreateFormOptions();
}

async function loadStaff() {
  elements.status.textContent = 'Загрузка реестра...';
  const payload = await requestJson(`/api/staff?includeArchived=${state.showArchived ? '1' : '0'}`);
  state.staff = payload.staff;
  syncObjectFilter();
  renderFilters();
  renderTable();
  renderStaffStatus();
}

async function persistRow(employeeId, options = {}) {
  const {
    pendingMessage = 'Сохранение...',
    successMessage = 'Сохранено.',
  } = options;

  setRowMessage(employeeId, pendingMessage);
  const row = state.staff.find((item) => item.employeeId === employeeId);
  if (!row) {
    return;
  }

  try {
    const values = getRowValues(employeeId);
    await sendJson(`/api/staff/${employeeId}`, 'PATCH', {
      positionTitle: values.positionTitle,
      objectName: values.objectName,
      isActive: row.isActive,
      syncOpenPeriods: false,
    });

    setRowMessage(employeeId, successMessage, 'is-success');
    await loadStaff();
  } catch (error) {
    setRowMessage(employeeId, error.message, 'is-error');
    throw error;
  }
}

async function persistPeriodPositionChange() {
  const employeeId = Number(state.periodPositionEmployeeId || 0);
  const row = state.staff.find((item) => item.employeeId === employeeId);
  if (!employeeId || !row) {
    throw new Error('Сотрудник не выбран.');
  }

  const positionTitle = elements.periodPositionValue.value;
  const periodCode = elements.periodPositionPeriod.value;
  if (!positionTitle) {
    throw new Error('Выберите должность.');
  }
  if (!periodCode) {
    throw new Error('Выберите открытый период.');
  }

  elements.periodPositionStatus.textContent = 'Применение...';
  elements.periodPositionStatus.className = 'form-status';

  const period = getOpenPeriods().find((item) => item.code === periodCode);
  const periodLabel = period ? period.label : periodCode;

  try {
    await sendJson(`/api/staff/${employeeId}/period-position`, 'PATCH', {
      positionTitle,
      periodCode,
    });

    closePeriodPositionDialog();
    await loadStaff();
    renderStaffStatus(`должность в периоде ${periodLabel} обновлена для ${row.fullName}`);
  } catch (error) {
    elements.periodPositionStatus.textContent = error.message;
    elements.periodPositionStatus.className = 'form-status is-error';
    throw error;
  }
}

async function toggleArchive(employeeId) {
  const row = state.staff.find((item) => item.employeeId === employeeId);
  if (!row) {
    return;
  }

  setRowMessage(employeeId, row.isActive ? 'Отправка в архив...' : 'Возврат из архива...');

  try {
    const values = getRowValues(employeeId);

    await sendJson(`/api/staff/${employeeId}`, 'PATCH', {
      positionTitle: values.positionTitle,
      objectName: values.objectName,
      isActive: !row.isActive,
      syncOpenPeriods: false,
    });

    await loadStaff();
    renderStaffStatus(row.isActive ? `архивирован ${row.fullName}` : `возвращен ${row.fullName}`);
  } catch (error) {
    setRowMessage(employeeId, error.message, 'is-error');
    throw error;
  }
}

async function deleteRow(employeeId) {
  const row = state.staff.find((item) => item.employeeId === employeeId);
  if (!row) {
    return;
  }

  if (!window.confirm(`Удалить сотрудника "${row.fullName}"?`)) {
    return;
  }

  setRowMessage(employeeId, 'Удаление...');

  try {
    await sendJson(`/api/staff/${employeeId}`, 'DELETE');
    await loadStaff();
    renderStaffStatus(`удален ${row.fullName}`);
  } catch (error) {
    setRowMessage(employeeId, error.message, 'is-error');
    throw error;
  }
}

function showError(error) {
  console.error(error);
  elements.status.textContent = `Ошибка: ${error.message}`;
}

function attachDialogDismiss(dialogElement, onClose) {
  dialogElement.addEventListener('click', (event) => {
    const bounds = dialogElement.getBoundingClientRect();
    const clickedOutside = (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    );

    if (clickedOutside) {
      onClose();
    }
  });

  dialogElement.addEventListener('cancel', (event) => {
    event.preventDefault();
    onClose();
  });
}

function attachEvents() {
  elements.showArchived.addEventListener('change', () => {
    state.showArchived = elements.showArchived.checked;
    loadStaff().catch(showError);
  });

  elements.searchInput.addEventListener('input', () => {
    state.search = elements.searchInput.value;
    renderTable();
    renderStaffStatus();
  });

  elements.objectFilter.addEventListener('change', () => {
    state.objectName = elements.objectFilter.value;
    renderTable();
    renderStaffStatus();
  });

  elements.openCreate.addEventListener('click', openCreateDialog);
  elements.closeCreate.addEventListener('click', closeCreateDialog);
  elements.cancelCreate.addEventListener('click', closeCreateDialog);

  elements.closePeriodPosition.addEventListener('click', closePeriodPositionDialog);
  elements.cancelPeriodPosition.addEventListener('click', closePeriodPositionDialog);

  attachDialogDismiss(elements.createDialog, closeCreateDialog);
  attachDialogDismiss(elements.periodPositionDialog, closePeriodPositionDialog);

  elements.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.createStatus.textContent = 'Сохранение...';
    elements.createStatus.className = 'form-status';

    try {
      const createdName = elements.createName.value.trim();
      await sendJson('/api/staff', 'POST', {
        fullName: createdName,
        positionTitle: elements.createPosition.value,
      });

      await loadStaff();
      closeCreateDialog();
      renderStaffStatus(`добавлен ${createdName}`);
    } catch (error) {
      elements.createStatus.textContent = error.message;
      elements.createStatus.className = 'form-status is-error';
    }
  });

  elements.periodPositionForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await persistPeriodPositionChange().catch(() => {});
  });
}

async function boot() {
  try {
    attachEvents();
    await loadReferences();
    await loadStaff();
  } catch (error) {
    showError(error);
  }
}

boot();
