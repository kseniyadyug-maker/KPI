const SELECTED_PERIOD_STORAGE_KEY = 'kpi.selectedPeriod';
const PROJECT_MANAGER_POSITION_TITLE = 'Руководитель проекта';
const PROJECT_MANAGER_IMPORT_METRICS = [
  {
    key: 'cashIn',
    name: 'Исполнение Плана поступления ДС',
    shortLabel: 'Поступление ДС',
  },
  {
    key: 'cashOut',
    name: 'Исполнение Плана расходования ДС',
    shortLabel: 'Расходование ДС',
  },
  {
    key: 'work',
    name: 'Исполнение Плана выполнения СМР, руб.',
    shortLabel: 'Выполнение СМР',
  },
];
const PROJECT_MANAGER_IMPORT_METRIC_NAMES = new Set(
  PROJECT_MANAGER_IMPORT_METRICS.map((metric) => metric.name)
);

const state = {
  dashboard: null,
  selectedPeriod: '',
  selectedEmployeeId: null,
  currentDetail: null,
  search: '',
  status: '',
  objectId: '',
  references: {
    objects: [],
    employees: [],
  },
  createEmployeeMatchedId: null,
};

const elements = {
  periodSelect: document.getElementById('period-select'),
  summaryCards: document.getElementById('summary-cards'),
  objectGrid: document.getElementById('object-grid'),
  objectFilter: document.getElementById('object-filter'),
  statusFilter: document.getElementById('status-filter'),
  searchInput: document.getElementById('search-input'),
  employeesBody: document.getElementById('employees-body'),
  employeeDetail: document.getElementById('employee-detail'),
  employeeWorkspace: document.getElementById('employee-workspace'),
  resetObjectsButton: document.getElementById('reset-objects-button'),
  resetEmployeesButton: document.getElementById('reset-employees-button'),
  printReportButton: document.getElementById('print-report-button'),
  openPeriodCopyButton: document.getElementById('open-kpi-period-copy'),
  periodCopyDialog: document.getElementById('kpi-period-copy-dialog'),
  periodCopyForm: document.getElementById('kpi-period-copy-form'),
  closePeriodCopyButton: document.getElementById('close-kpi-period-copy'),
  cancelPeriodCopyButton: document.getElementById('cancel-kpi-period-copy'),
  periodCopySourceSelect: document.getElementById('kpi-copy-source-period'),
  periodCopyTargetSelect: document.getElementById('kpi-copy-target-period'),
  periodCopySubmit: document.getElementById('submit-kpi-period-copy'),
  periodCopyStatus: document.getElementById('kpi-period-copy-status'),
  openCreateEmployeeButton: document.getElementById('open-kpi-employee-create'),
  createEmployeeDialog: document.getElementById('kpi-employee-create-dialog'),
  createEmployeeForm: document.getElementById('kpi-employee-create-form'),
  closeCreateEmployeeButton: document.getElementById('close-kpi-employee-create'),
  cancelCreateEmployeeButton: document.getElementById('cancel-kpi-employee-create'),
  createEmployeeInput: document.getElementById('kpi-create-employee-input'),
  createEmployeeOptions: document.getElementById('kpi-create-employee-options'),
  createObjectSelect: document.getElementById('kpi-create-object-select'),
  createEmployeeSubmit: document.getElementById('submit-kpi-employee-create'),
  createEmployeeStatus: document.getElementById('kpi-employee-create-status'),
};

function isProjectManagerDetail(detail) {
  return Boolean(detail && (detail.isProjectManager || detail.positionTitle === PROJECT_MANAGER_POSITION_TITLE));
}

function formatMeasureNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '—';
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
  }).format(Number(value)).replace(/[\u00A0\u202F]/g, ' ');
}

function roundPercentValue(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }

  return Math.round(Number(value));
}

function formatPercent(value) {
  const roundedValue = roundPercentValue(value);
  if (roundedValue === null) {
    return '-';
  }
  return `${roundedValue}%`;
}

function formatPercentInputNumber(value) {
  const roundedValue = roundPercentValue(value);
  if (roundedValue === null) {
    return '';
  }

  return String(roundedValue);
}

function getStoredPeriodCode() {
  try {
    return String(window.localStorage.getItem(SELECTED_PERIOD_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function storeSelectedPeriodCode(periodCode) {
  try {
    if (periodCode) {
      window.localStorage.setItem(SELECTED_PERIOD_STORAGE_KEY, String(periodCode));
      return;
    }

    window.localStorage.removeItem(SELECTED_PERIOD_STORAGE_KEY);
  } catch {
    // Ignore storage errors and keep app functional.
  }
}

function formatDeviationPercent(totalPercent) {
  const roundedPercent = roundPercentValue(totalPercent);
  if (roundedPercent === null) {
    return '-';
  }

  const deviation = roundedPercent - 40;
  const prefix = deviation > 0 ? '+' : '';
  return `${prefix}${deviation}%`;
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatCompactNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return Number(value).toFixed(3).replace(/\.?0+$/, '');
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

function getRequestStatusLabel(status) {
  return status === 'approved' ? 'Согласовано' : 'Черновик';
}

function getAuthPermissions() {
  return window.kpiAuth?.permissions || {};
}

function hasAuthPermission(permissionName) {
  return Boolean(permissionName && getAuthPermissions()[permissionName]);
}

function getCurrentDetailPermissions() {
  return state.currentDetail?.permissions || {};
}

function canCurrentDetailBeEdited() {
  return Boolean(getCurrentDetailPermissions().canEdit);
}

function canCurrentDetailBeApproved() {
  return Boolean(getCurrentDetailPermissions().canApprove);
}

function statusClass(status) {
  if (status === 'Выполнено') {
    return 'status-done';
  }
  if (status === 'Частично') {
    return 'status-partial';
  }
  return 'status-failed';
}

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

function buildSelectOptions(items, selectedValue = '', placeholder = 'Выберите значение') {
  const options = [`<option value="">${escapeHtml(placeholder)}</option>`];
  for (const item of items) {
    const value = String(item.value ?? '');
    options.push(
      `<option value="${escapeHtml(value)}" ${value === String(selectedValue) ? 'selected' : ''}>${escapeHtml(item.label)}</option>`
    );
  }
  return options.join('');
}

function buildDatalistOptions(items) {
  return items
    .map((item) => {
      const value = String(item.value ?? '');
      const label = String(item.label ?? '');
      return `<option value="${escapeHtml(value)}" label="${escapeHtml(label)}"></option>`;
    })
    .join('');
}

function setPeriodCopyStatus(message, kind = '') {
  if (!elements.periodCopyStatus) {
    return;
  }

  elements.periodCopyStatus.textContent = message;
  elements.periodCopyStatus.className = `form-status ${kind}`.trim();
}

function setCreateEmployeeStatus(message, kind = '') {
  if (!elements.createEmployeeStatus) {
    return;
  }

  elements.createEmployeeStatus.textContent = message;
  elements.createEmployeeStatus.className = `form-status ${kind}`.trim();
}

function applyRolePermissions() {
  if (elements.openCreateEmployeeButton) {
    elements.openCreateEmployeeButton.hidden = !hasAuthPermission('canAssignObject');
  }
  if (elements.openPeriodCopyButton) {
    elements.openPeriodCopyButton.hidden = !hasAuthPermission('canCopyPeriodData');
  }
  if (elements.printReportButton) {
    elements.printReportButton.hidden = !hasAuthPermission('canPrint');
  }
}

function resetCreateEmployeeForm() {
  if (!elements.createEmployeeForm) {
    return;
  }

  elements.createEmployeeForm.reset();
  state.createEmployeeMatchedId = null;
  setCreateEmployeeStatus('');
  if (elements.createEmployeeSubmit) {
    elements.createEmployeeSubmit.disabled = false;
  }
}

function resetPeriodCopyForm() {
  if (!elements.periodCopyForm) {
    return;
  }

  elements.periodCopyForm.reset();
  setPeriodCopyStatus('');
  if (elements.periodCopySubmit) {
    elements.periodCopySubmit.disabled = false;
  }
}

function getDashboardPeriods() {
  return state.dashboard?.periods || [];
}

function getPeriodLabelByCode(periodCode) {
  const period = getDashboardPeriods().find((item) => item.code === periodCode);
  return period ? period.label : periodCode;
}

function formatPeriodOptionLabel(period) {
  if (period.status === 'open') {
    return `${period.label} · открыто`;
  }
  if (period.status === 'closed') {
    return `${period.label} · закрыто`;
  }
  return `${period.label} · архив`;
}

function getAlternatePeriodCode(excludedCode, preferredCode = '') {
  const periods = getDashboardPeriods();
  if (preferredCode && preferredCode !== excludedCode && periods.some((period) => period.code === preferredCode)) {
    return preferredCode;
  }

  const fallbackPeriod = periods.find((period) => period.code !== excludedCode);
  return fallbackPeriod ? fallbackPeriod.code : '';
}

function updatePeriodCopySubmitState() {
  if (!elements.periodCopySubmit || !elements.periodCopySourceSelect || !elements.periodCopyTargetSelect) {
    return;
  }

  const sourcePeriodCode = elements.periodCopySourceSelect.value;
  const targetPeriodCode = elements.periodCopyTargetSelect.value;
  const canSubmit =
    getDashboardPeriods().length > 1 &&
    Boolean(sourcePeriodCode) &&
    Boolean(targetPeriodCode) &&
    sourcePeriodCode !== targetPeriodCode;

  elements.periodCopySubmit.disabled = !canSubmit;
}

function syncPeriodCopyStatus() {
  if (!elements.periodCopySourceSelect || !elements.periodCopyTargetSelect) {
    return;
  }

  if (getDashboardPeriods().length < 2) {
    setPeriodCopyStatus('Для копирования нужно минимум два периода.', 'is-error');
    return;
  }

  const sourcePeriodCode = elements.periodCopySourceSelect.value;
  const targetPeriodCode = elements.periodCopyTargetSelect.value;
  if (!sourcePeriodCode || !targetPeriodCode) {
    setPeriodCopyStatus('');
    return;
  }

  if (sourcePeriodCode === targetPeriodCode) {
    setPeriodCopyStatus('Периоды источника и назначения должны отличаться.', 'is-error');
    return;
  }

  setPeriodCopyStatus(
    `Будут скопированы все KPI-данные из периода "${getPeriodLabelByCode(sourcePeriodCode)}" в период "${getPeriodLabelByCode(targetPeriodCode)}". Существующие данные в целевом периоде будут перезаписаны, согласование будет сброшено.`
  );
}

function renderPeriodCopyOptions(sourcePeriodCode = state.selectedPeriod, targetPeriodCode = '') {
  if (!elements.periodCopySourceSelect || !elements.periodCopyTargetSelect) {
    return;
  }

  const periods = getDashboardPeriods();
  const selectedSourceCode = periods.some((period) => period.code === sourcePeriodCode)
    ? sourcePeriodCode
    : (periods[0] ? periods[0].code : '');
  const selectedTargetCode = getAlternatePeriodCode(selectedSourceCode, targetPeriodCode);
  const periodOptions = periods.map((period) => ({
    value: period.code,
    label: formatPeriodOptionLabel(period),
  }));

  elements.periodCopySourceSelect.innerHTML = buildSelectOptions(periodOptions, selectedSourceCode, 'Выберите период');
  elements.periodCopyTargetSelect.innerHTML = buildSelectOptions(periodOptions, selectedTargetCode, 'Выберите период');

  syncPeriodCopyStatus();
  updatePeriodCopySubmitState();
}

async function openPeriodCopyDialog() {
  if (!elements.periodCopyDialog) {
    return;
  }

  if (!hasAuthPermission('canCopyPeriodData')) {
    window.alert('Доступ ограничен');
    return;
  }

  resetPeriodCopyForm();
  renderPeriodCopyOptions(state.selectedPeriod, getAlternatePeriodCode(state.selectedPeriod));

  if (typeof elements.periodCopyDialog.showModal === 'function') {
    elements.periodCopyDialog.showModal();
  } else {
    elements.periodCopyDialog.setAttribute('open', 'open');
  }
}

function closePeriodCopyDialog() {
  if (!elements.periodCopyDialog || !elements.periodCopyDialog.hasAttribute('open')) {
    resetPeriodCopyForm();
    return;
  }

  resetPeriodCopyForm();

  if (typeof elements.periodCopyDialog.close === 'function') {
    elements.periodCopyDialog.close();
  } else {
    elements.periodCopyDialog.removeAttribute('open');
  }
}

function getReferenceCreateEmployees() {
  return state.references.employees || [];
}

function getCreateEmployeePeriodRecord(employeeId) {
  if (!employeeId) {
    return null;
  }

  return (state.dashboard?.employees || []).find((employee) => Number(employee.employeeId) === Number(employeeId)) || null;
}

function findCreateEmployeeByName(fullName) {
  const normalizedQuery = String(fullName ?? '').trim().toLowerCase();
  if (!normalizedQuery) {
    return null;
  }

  return getReferenceCreateEmployees().find((employee) => employee.fullName.trim().toLowerCase() === normalizedQuery) || null;
}

function getReferenceObjectName(objectId) {
  if (!objectId) {
    return '';
  }

  const matchedObject = (state.references.objects || []).find((objectItem) => Number(objectItem.objectId) === Number(objectId));
  return matchedObject?.objectName || '';
}

function syncCreateEmployeeStatus() {
  const selectedEmployee = findCreateEmployeeByName(elements.createEmployeeInput?.value || '');
  if (!selectedEmployee) {
    setCreateEmployeeStatus('');
    return;
  }

  const periodRecord = getCreateEmployeePeriodRecord(selectedEmployee.employeeId);
  if (!periodRecord) {
    setCreateEmployeeStatus('Будет создана запись KPI за выбранный период, а выбранный объект сохранится у сотрудника.');
    return;
  }

  const selectedObjectId = Number(elements.createObjectSelect?.value || 0);
  const currentObjectName = periodRecord.objectName || getReferenceObjectName(periodRecord.objectId);
  const selectedObjectName = getReferenceObjectName(selectedObjectId);
  if (selectedObjectId && Number(periodRecord.objectId) !== selectedObjectId) {
    setCreateEmployeeStatus(
      `У сотрудника уже есть запись KPI за выбранный период на объекте "${currentObjectName}". После сохранения объект будет изменен на "${selectedObjectName}" в записи периода и в карточке сотрудника.`
    );
    return;
  }

  setCreateEmployeeStatus(`Сотрудник уже добавлен в KPI выбранного периода на объект "${currentObjectName}".`);
}

function updateCreateEmployeeSubmitState() {
  if (!elements.createEmployeeSubmit || !elements.createObjectSelect) {
    return;
  }

  const selectedEmployee = findCreateEmployeeByName(elements.createEmployeeInput?.value || '');
  const hasObjects = (state.references.objects || []).length > 0;
  const hasObjectSelection = Boolean(Number(elements.createObjectSelect.value || 0));
  const canSubmit = Boolean(selectedEmployee) && hasObjects && hasObjectSelection;
  elements.createEmployeeSubmit.disabled = !canSubmit;
}

function syncCreateEmployeeObject() {
  if (!elements.createEmployeeInput || !elements.createObjectSelect) {
    return;
  }

  const matchedEmployee = findCreateEmployeeByName(elements.createEmployeeInput.value);
  if (!matchedEmployee) {
    state.createEmployeeMatchedId = null;
    updateCreateEmployeeSubmitState();
    return;
  }

  const matchedEmployeeId = Number(matchedEmployee.employeeId);
  const employeeChanged = state.createEmployeeMatchedId !== matchedEmployeeId;
  state.createEmployeeMatchedId = matchedEmployeeId;

  if (employeeChanged) {
    const periodRecord = getCreateEmployeePeriodRecord(matchedEmployee.employeeId);
    const preferredObjectId = periodRecord?.objectId || matchedEmployee.objectId;
    if (preferredObjectId) {
      elements.createObjectSelect.value = String(preferredObjectId);
    }
  }

  syncCreateEmployeeStatus();
  updateCreateEmployeeSubmitState();
}

function renderCreateEmployeeOptions() {
  if (!elements.createEmployeeInput || !elements.createEmployeeOptions || !elements.createObjectSelect) {
    return;
  }

  const referenceEmployees = getReferenceCreateEmployees();
  const objects = state.references.objects || [];
  const preferredObjectId = state.objectId || (objects[0] ? String(objects[0].objectId) : '');

  elements.createEmployeeOptions.innerHTML = buildDatalistOptions(
    referenceEmployees.map((employee) => ({
      value: employee.fullName,
      label: employee.positionTitle ? `${employee.fullName} — ${employee.positionTitle}` : employee.fullName,
    }))
  );

  elements.createEmployeeInput.value = '';

  elements.createObjectSelect.innerHTML = buildSelectOptions(
    objects.map((objectItem) => ({
      value: objectItem.objectId,
      label: objectItem.objectName,
    })),
    preferredObjectId,
    'Выберите объект'
  );

  const hasReferenceEmployees = referenceEmployees.length > 0;
  const hasObjects = objects.length > 0;

  elements.createEmployeeInput.disabled = !hasReferenceEmployees;
  elements.createObjectSelect.disabled = !hasObjects;

  if (!hasReferenceEmployees) {
    setCreateEmployeeStatus('В справочнике сотрудников нет активных записей.', 'is-error');
    return;
  }

  if (!hasObjects) {
    setCreateEmployeeStatus('Нет доступных объектов для выбора.', 'is-error');
    return;
  }

  setCreateEmployeeStatus('');
  updateCreateEmployeeSubmitState();
}

async function loadCreateEmployeeReferences() {
  const payload = await requestJson('/api/references');
  state.references = {
    objects: Array.isArray(payload.objects) ? payload.objects : [],
    employees: Array.isArray(payload.employees) ? payload.employees : [],
  };
}

async function openCreateEmployeeDialog() {
  if (!elements.createEmployeeDialog) {
    return;
  }

  if (!hasAuthPermission('canCreateKpiRecord') && !hasAuthPermission('canAssignObject')) {
    window.alert('Доступ ограничен');
    return;
  }

  try {
    await loadCreateEmployeeReferences();
    resetCreateEmployeeForm();
    renderCreateEmployeeOptions();

    if (typeof elements.createEmployeeDialog.showModal === 'function') {
      elements.createEmployeeDialog.showModal();
    } else {
      elements.createEmployeeDialog.setAttribute('open', 'open');
    }

    if (elements.createEmployeeInput) {
      elements.createEmployeeInput.focus();
    }
  } catch (error) {
    console.error(error);
    window.alert(error.message);
  }
}

function closeCreateEmployeeDialog() {
  if (!elements.createEmployeeDialog || !elements.createEmployeeDialog.hasAttribute('open')) {
    resetCreateEmployeeForm();
    return;
  }

  resetCreateEmployeeForm();

  if (typeof elements.createEmployeeDialog.close === 'function') {
    elements.createEmployeeDialog.close();
  } else {
    elements.createEmployeeDialog.removeAttribute('open');
  }
}

async function submitCreateEmployeeForm(event) {
  event.preventDefault();

  if (!hasAuthPermission('canCreateKpiRecord') && !hasAuthPermission('canAssignObject')) {
    setCreateEmployeeStatus('Доступ ограничен', 'is-error');
    return;
  }

  const selectedEmployee = findCreateEmployeeByName(elements.createEmployeeInput?.value || '');
  const employeeId = Number(selectedEmployee?.employeeId || 0);
  const objectId = Number(elements.createObjectSelect?.value || 0);

  if (!employeeId) {
    setCreateEmployeeStatus('Выберите сотрудника из справочника.', 'is-error');
    return;
  }

  if (!objectId) {
    setCreateEmployeeStatus('Выберите объект из справочника.', 'is-error');
    return;
  }

  try {
    setCreateEmployeeStatus('Сохранение...');
    if (elements.createEmployeeSubmit) {
      elements.createEmployeeSubmit.disabled = true;
    }

    const result = await sendJson('/api/employee-records', 'POST', {
      periodCode: state.selectedPeriod,
      employeeId,
      objectId,
    });

    state.objectId = String(objectId);
    closeCreateEmployeeDialog();
    await loadDashboard(state.selectedPeriod);
    await loadEmployeeDetail(Number(result.employeeId));
  } catch (error) {
    setCreateEmployeeStatus(error.message, 'is-error');
    if (elements.createEmployeeSubmit) {
      elements.createEmployeeSubmit.disabled = false;
    }
  }
}

async function submitPeriodCopyForm(event) {
  event.preventDefault();

  if (!hasAuthPermission('canCopyPeriodData')) {
    setPeriodCopyStatus('Доступ ограничен', 'is-error');
    return;
  }

  const sourcePeriodCode = elements.periodCopySourceSelect?.value || '';
  const targetPeriodCode = elements.periodCopyTargetSelect?.value || '';

  if (!sourcePeriodCode || !targetPeriodCode) {
    setPeriodCopyStatus('Выберите оба периода.', 'is-error');
    return;
  }

  if (sourcePeriodCode === targetPeriodCode) {
    setPeriodCopyStatus('Периоды источника и назначения должны отличаться.', 'is-error');
    return;
  }

  try {
    setPeriodCopyStatus('Копирование...');
    if (elements.periodCopySubmit) {
      elements.periodCopySubmit.disabled = true;
    }

    const result = await sendJson('/api/kpi-periods/copy', 'POST', {
      sourcePeriodCode,
      targetPeriodCode,
    });

    state.objectId = '';
    state.selectedEmployeeId = null;
    state.currentDetail = null;
    closePeriodCopyDialog();
    await loadDashboard(targetPeriodCode);
    window.alert(
      `Копирование завершено.\nСотрудников: ${result.totalEmployees}\nСоздано записей: ${result.createdCount}\nОбновлено записей: ${result.updatedCount}\nСкопировано значений KPI: ${result.metricValuesCopied}\nСкопировано строк export: ${result.projectManagerImportRowsCopied || 0}`
    );
  } catch (error) {
    setPeriodCopyStatus(error.message, 'is-error');
    if (elements.periodCopySubmit) {
      elements.periodCopySubmit.disabled = false;
    }
  }
}

function formatInputNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  return Number(value).toFixed(3).replace(/\.?0+$/, '');
}

function renderPeriodSelect(periods, selectedPeriod) {
  elements.periodSelect.innerHTML = periods
    .map((period) => `
      <option value="${escapeHtml(period.code)}" ${period.code === selectedPeriod ? 'selected' : ''}>
        ${escapeHtml(period.label)}${period.status === 'open' ? ' · открыто' : ''}
      </option>
    `)
    .join('');
}

function renderSummaryCards(summary) {
  const cards = [
    {
      label: 'Сотрудники',
      value: summary.employeesCount,
      sub: `Согласовано: ${summary.approvedCount}`,
    },
    {
      label: 'Средний итог',
      value: formatPercent(summary.avgTotalPercent),
      sub: `Блок А: ${formatPercent(summary.avgBlockAPercent)}`,
    },
    {
      label: 'Средний блок Б',
      value: formatPercent(summary.avgBlockBPercent),
      sub: `Выполнено: ${summary.doneCount}`,
    },
    {
      label: 'Частично / Не выполнено',
      value: `${summary.partialCount} / ${summary.failedCount}`,
      sub: 'По статусам периода',
    },
  ];

  elements.summaryCards.innerHTML = cards
    .map((card) => `
      <article class="summary-card">
        <div class="summary-card-label">${escapeHtml(card.label)}</div>
        <div class="summary-card-value">${escapeHtml(card.value)}</div>
        <div class="summary-card-sub">${escapeHtml(card.sub)}</div>
      </article>
    `)
    .join('');
}

function emptySummary() {
  return {
    employeesCount: 0,
    doneCount: 0,
    partialCount: 0,
    failedCount: 0,
    approvedCount: 0,
    avgBlockAPercent: 0,
    avgBlockBPercent: 0,
    avgTotalPercent: 0,
    totalBonusRub: 0,
  };
}

function summarizeEmployees(employees) {
  if (!employees.length) {
    return emptySummary();
  }

  const summary = employees.reduce(
    (accumulator, employee) => {
      accumulator.employeesCount += 1;
      accumulator.approvedCount += employee.isApproved ? 1 : 0;
      accumulator.avgBlockAPercent += Number(employee.blockAPercent) || 0;
      accumulator.avgBlockBPercent += Number(employee.blockBPercent) || 0;
      accumulator.avgTotalPercent += Number(employee.finalTotalPercent) || 0;
      accumulator.totalBonusRub += Number(employee.bonusRub) || 0;

      if (employee.status === 'Выполнено') {
        accumulator.doneCount += 1;
      } else if (employee.status === 'Частично') {
        accumulator.partialCount += 1;
      } else {
        accumulator.failedCount += 1;
      }

      return accumulator;
    },
    emptySummary()
  );

  summary.avgBlockAPercent /= summary.employeesCount;
  summary.avgBlockBPercent /= summary.employeesCount;
  summary.avgTotalPercent /= summary.employeesCount;

  return summary;
}

function getBaseEmployeesForSummary() {
  if (!state.dashboard) {
    return [];
  }

  if (!state.objectId) {
    return state.dashboard.employees;
  }

  return state.dashboard.employees.filter((employee) => String(employee.objectId) === state.objectId);
}

function getScopedSummary() {
  if (!state.dashboard) {
    return emptySummary();
  }

  const employees = getBaseEmployeesForSummary();

  if (state.selectedEmployeeId) {
    const selectedEmployee = employees.find((employee) => employee.employeeId === state.selectedEmployeeId);
    if (selectedEmployee) {
      return summarizeEmployees([selectedEmployee]);
    }
  }

  if (!state.objectId) {
    return state.dashboard.summary || summarizeEmployees(employees);
  }

  return summarizeEmployees(employees);
}

function renderDashboardSummary() {
  renderSummaryCards(getScopedSummary());
}

function getSelectedPeriodLabel() {
  return getPeriodLabelByCode(state.selectedPeriod);
}

function formatPrintDate(date = new Date()) {
  return new Intl.DateTimeFormat('ru-RU').format(date);
}

function getPrintableEmployees() {
  return filteredEmployees();
}

function getObjectGroupsForPrint(employees) {
  const groups = [];
  const groupMap = new Map();

  for (const employee of employees) {
    const key = String(employee.objectId || employee.objectName);
    if (!groupMap.has(key)) {
      const group = {
        objectId: employee.objectId,
        objectName: employee.objectName,
        employees: [],
      };
      groupMap.set(key, group);
      groups.push(group);
    }
    groupMap.get(key).employees.push(employee);
  }

  return groups;
}

function getPrintScopeLabel(objectGroups) {
  if (!objectGroups.length) {
    return 'Нет данных';
  }
  if (objectGroups.length === 1) {
    return objectGroups[0].objectName;
  }
  return 'Выборка по текущим фильтрам';
}

function getDetailGroup(detail, groupCode) {
  return detail.groups.find((group) => group.code === groupCode) || null;
}

function collectMetricCatalog(details, groupCode) {
  const metrics = [];
  const seen = new Set();

  for (const detail of details) {
    const group = getDetailGroup(detail, groupCode);
    for (const metric of group?.metrics || []) {
      if (seen.has(metric.metricId)) {
        continue;
      }
      seen.add(metric.metricId);
      metrics.push({
        metricId: metric.metricId,
        name: metric.name,
      });
    }
  }

  return metrics;
}

function buildMetricLookup(detail, groupCode) {
  const group = getDetailGroup(detail, groupCode);
  const metricMap = new Map();
  for (const metric of group?.metrics || []) {
    metricMap.set(metric.metricId, metric);
  }
  return metricMap;
}

function formatMetricRawForPrint(metric) {
  if (!metric || metric.rawValue === null || metric.rawValue === undefined || Number.isNaN(Number(metric.rawValue))) {
    return '—';
  }

  const normalizedNorm = String(metric.normText || '').toLowerCase();
  if (metric.inputType === 'score') {
    return formatCompactNumber(metric.rawValue);
  }
  if (normalizedNorm.includes('дн')) {
    return `${formatCompactNumber(metric.rawValue)} дн`;
  }
  return formatPercent(metric.rawValue);
}

function formatStatusForPrint(status) {
  if (status === 'Выполнено') {
    return '✓ Выполнено';
  }
  return status;
}

function formatMetricHeaderForPrint(name) {
  const source = String(name || '').trim();
  if (!source) {
    return '—';
  }

  const replacements = [
    [/Исполнение Графика производства СМР/gi, 'График СМР'],
    [/Исполнение Плана поступления ДС/gi, 'План поступл. ДС'],
    [/Заявки\s*\/\s*ТМЦ\s*\/\s*Документооборот/gi, 'Заявки / ТМЦ / документооб.'],
    [/должностной инструкции/gi, 'должн. инстр.'],
    [/техники безопасности/gi, 'ТБ'],
    [/документооборот/gi, 'документооб.'],
    [/исполнительская/gi, 'исполн.'],
    [/ответственности/gi, 'ответств.'],
    [/производства/gi, 'произв.'],
    [/планирование/gi, 'планир.'],
    [/Своевременное/gi, 'Своевр.'],
    [/Выполнение/gi, 'Вып.'],
    [/Исполнение/gi, 'Исп.'],
    [/Соблюдение/gi, 'Собл.'],
    [/Культура/gi, 'Культ.'],
    [/Контроль/gi, 'Контр.'],
    [/руководителя/gi, 'рук.'],
    [/дисциплина/gi, 'дисц.'],
  ];

  const compact = replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source).replace(/\s{2,}/g, ' ').trim();

  if (compact.length <= 28) {
    return compact;
  }

  return `${compact.slice(0, 27).trim()}…`;
}

async function loadPrintableDetails(employees) {
  return Promise.all(
    employees.map((employee) => {
      if (
        state.currentDetail &&
        state.currentDetail.employeeId === employee.employeeId &&
        state.currentDetail.periodCode === state.selectedPeriod
      ) {
        return Promise.resolve(state.currentDetail);
      }

      return requestJson(`/api/employees/${employee.employeeId}?period=${encodeURIComponent(state.selectedPeriod)}`);
    })
  );
}

function buildOverviewTableHtml(objectGroups) {
  let counter = 0;

  const rows = objectGroups
    .map((group) => {
      const summary = summarizeEmployees(group.employees);
      const employeeRows = group.employees
        .map((employee) => {
          counter += 1;
          return `
            <tr>
              <td class="print-cell-index">${counter}</td>
              <td>
                <div class="print-employee-name">${escapeHtml(employee.fullName)}</div>
                <div class="print-employee-meta">${escapeHtml(employee.positionTitle)}</div>
              </td>
              <td>${formatPercent(employee.blockAPercent)}</td>
              <td>${formatPercent(employee.blockBPercent)}</td>
              <td class="is-strong">${formatPercent(employee.finalTotalPercent)}</td>
              <td>${formatDeviationPercent(employee.finalTotalPercent)}</td>
              <td class="is-success">${escapeHtml(formatStatusForPrint(employee.status))}</td>
            </tr>
          `;
        })
        .join('');

      return `
        <tr class="print-group-row">
          <td colspan="7">${escapeHtml(group.objectName)} — ${group.employees.length} сотр.</td>
        </tr>
        ${employeeRows}
        <tr class="print-average-row">
          <td colspan="2">Среднее по ${escapeHtml(group.objectName)}</td>
          <td>${formatPercent(summary.avgBlockAPercent)}</td>
          <td>${formatPercent(summary.avgBlockBPercent)}</td>
          <td>${formatPercent(summary.avgTotalPercent)}</td>
          <td>${formatDeviationPercent(summary.avgTotalPercent)}</td>
          <td></td>
        </tr>
      `;
    })
    .join('');

  return `
    <table class="print-report-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Сотрудник / должность</th>
          <th>Блок A (8%)</th>
          <th>Блок Б (32%)</th>
          <th>Итого KPI</th>
          <th>Отклонение +/-</th>
          <th>Статус</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildMetricsSummaryTableHtml(objectGroups, details) {
  const detailsByEmployeeId = new Map(details.map((detail) => [detail.employeeId, detail]));
  const blockAMetrics = collectMetricCatalog(details, 'block_a');
  const blockBMetrics = collectMetricCatalog(details, 'block_b');

  const body = objectGroups
    .map((group) => {
      const summary = summarizeEmployees(group.employees);
      const rows = group.employees
        .map((employee) => {
          const detail = detailsByEmployeeId.get(employee.employeeId);
          const blockAMap = buildMetricLookup(detail, 'block_a');
          const blockBMap = buildMetricLookup(detail, 'block_b');
          const blockAValues = blockAMetrics
            .map((metric) => `<td>${escapeHtml(formatMetricRawForPrint(blockAMap.get(metric.metricId)))}</td>`)
            .join('');
          const blockBValues = blockBMetrics
            .map((metric) => `<td>${escapeHtml(formatMetricRawForPrint(blockBMap.get(metric.metricId)))}</td>`)
            .join('');

          return `
            <tr>
              <td>
                <div class="print-employee-name">${escapeHtml(employee.fullName)}${detail?.isApproved ? '<span class="print-approved-mark">✓</span>' : ''}</div>
                <div class="print-employee-meta">${escapeHtml(employee.positionTitle)}</div>
              </td>
              ${blockAValues}
              ${blockBValues}
              <td>${formatPercent(employee.blockAPercent)}</td>
              <td>${formatPercent(employee.blockBPercent)}</td>
              <td class="is-strong">${formatPercent(employee.finalTotalPercent)}</td>
            </tr>
          `;
        })
        .join('');

      return `
        <tr class="print-group-row">
          <td colspan="${1 + blockAMetrics.length + blockBMetrics.length + 3}">${escapeHtml(group.objectName)} — ${group.employees.length} сотр.</td>
        </tr>
        ${rows}
        <tr class="print-average-row">
          <td>Итого / Среднее</td>
          ${'<td></td>'.repeat(blockAMetrics.length + blockBMetrics.length)}
          <td>${formatPercent(summary.avgBlockAPercent)}</td>
          <td>${formatPercent(summary.avgBlockBPercent)}</td>
          <td>${formatPercent(summary.avgTotalPercent)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table class="print-report-table print-wide-table">
      <thead>
        <tr>
          <th rowspan="2">Сотрудник</th>
          <th colspan="${Math.max(blockAMetrics.length, 1)}" class="is-block-a">Блок A — индивид. показатели (8%)</th>
          <th colspan="${Math.max(blockBMetrics.length, 1)}" class="is-block-b">Блок Б — KPI (32%)</th>
          <th rowspan="2">Итого A</th>
          <th rowspan="2">Итого Б</th>
          <th rowspan="2">Итого %</th>
        </tr>
        <tr>
          ${blockAMetrics.map((metric) => `<th class="print-metric-head">${escapeHtml(formatMetricHeaderForPrint(metric.name))}</th>`).join('') || '<th>—</th>'}
          ${blockBMetrics.map((metric) => `<th class="print-metric-head">${escapeHtml(formatMetricHeaderForPrint(metric.name))}</th>`).join('') || '<th>—</th>'}
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function buildEmployeePagesHtml(details) {
  return details
    .map((detail) => {
      const blockA = getDetailGroup(detail, 'block_a');
      const blockB = getDetailGroup(detail, 'block_b');
      const blockARows = (blockA?.metrics || [])
        .map((metric) => `
          <tr>
            <td>${escapeHtml(metric.name)}</td>
            <td>${formatPercent(Number(metric.weight) * 100)}</td>
            <td>${escapeHtml(formatMetricRawForPrint(metric))}</td>
            <td>${formatPercent(metric.calculatedPercent)}</td>
            <td>${formatPercent(metric.effectivePercent)}</td>
          </tr>
        `)
        .join('');
      const blockBRows = (blockB?.metrics || [])
        .map((metric) => `
          <tr>
            <td>${escapeHtml(metric.name)}</td>
            <td>${formatPercent(Number(metric.weight) * 100)}</td>
            <td>${escapeHtml(metric.normText || '—')}</td>
            <td>${escapeHtml(formatMetricRawForPrint(metric))}</td>
            <td>${formatPercent(metric.calculatedPercent)}</td>
            <td>${formatPercent(metric.effectivePercent)}</td>
          </tr>
        `)
        .join('');

      return `
        <section class="print-page">
          <div class="print-page-line"></div>
          <header class="print-employee-header">
            <div>
              <h1>${escapeHtml(detail.fullName)}</h1>
              <div class="print-page-meta">${escapeHtml(detail.positionTitle)} В· ${escapeHtml(detail.object.name)} В· ${escapeHtml(detail.periodLabel)}</div>
            </div>
            <div class="print-page-side">
              <div class="print-page-status">${escapeHtml(formatStatusForPrint(detail.status))}</div>
              <div class="print-page-meta">Дата печати: ${escapeHtml(formatPrintDate())}</div>
            </div>
          </header>

          <div class="print-detail-grid">
            <section class="print-detail-card">
              <h2>Блок A — Индивидуальные показатели (8%)</h2>
              <table class="print-report-table print-detail-table print-detail-table-a">
                <colgroup>
                  <col class="print-col-title-a" />
                  <col class="print-col-weight-a" />
                  <col class="print-col-score-a" />
                  <col class="print-col-calc-a" />
                  <col class="print-col-agreed-a" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Критерий</th>
                    <th>Вес</th>
                    <th>Оценка</th>
                    <th>Расч.%</th>
                    <th>Согл.%</th>
                  </tr>
                </thead>
                <tbody>${blockARows}</tbody>
              </table>
              <div class="print-detail-total">Итого Блок A: <strong>${formatPercent(detail.blockAPercent)}</strong></div>
            </section>

            <section class="print-detail-card">
              <h2>Блок Б — Ключевые показатели KPI (32%)</h2>
              <table class="print-report-table print-detail-table print-detail-table-b">
                <colgroup>
                  <col class="print-col-title-b" />
                  <col class="print-col-weight-b" />
                  <col class="print-col-norm-b" />
                  <col class="print-col-fact-b" />
                  <col class="print-col-calc-b" />
                  <col class="print-col-agreed-b" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Показатель</th>
                    <th>Вес</th>
                    <th>Норма</th>
                    <th>Факт</th>
                    <th>Расч.%</th>
                    <th>Согл.%</th>
                  </tr>
                </thead>
                <tbody>${blockBRows}</tbody>
              </table>
              <div class="print-detail-total">Итого Блок Б: <strong>${formatPercent(detail.blockBPercent)}</strong></div>
            </section>
          </div>

          <section class="print-premium-card">
            <h2>Итоговый расчёт премии</h2>
            <div class="print-premium-grid">
              <div class="print-premium-item">
                <span>Блок A</span>
                <strong>${formatPercent(detail.blockAPercent)}</strong>
              </div>
              <div class="print-premium-item">
                <span>Блок Б</span>
                <strong>${formatPercent(detail.blockBPercent)}</strong>
              </div>
              <div class="print-premium-item is-total">
                <span>Итого премии</span>
                <strong>${formatPercent(detail.finalTotalPercent)}</strong>
              </div>
            </div>
          </section>

          <section class="print-signatures">
            <div class="print-sign-line">Руководитель (подпись / дата)</div>
            <div class="print-sign-line">Ознакомлен(а): ${escapeHtml(detail.fullName)} (подпись / дата)</div>
            <div class="print-sign-line">Комментарий</div>
          </section>
        </section>
      `;
    })
    .join('');
}

function buildPrintReportHtml(employees, details) {
  const periodLabel = getSelectedPeriodLabel();
  const printedAt = formatPrintDate();
  const objectGroups = getObjectGroupsForPrint(employees);
  const scopeLabel = getPrintScopeLabel(objectGroups);
  const summary = summarizeEmployees(employees);
  const overviewTable = buildOverviewTableHtml(objectGroups);
  const metricsTable = buildMetricsSummaryTableHtml(objectGroups, details);
  const employeePages = buildEmployeePagesHtml(details);
  const stylesheetUrl = `${window.location.origin}/print-report.css`;

  return `
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Печать KPI</title>
      <link rel="stylesheet" href="${stylesheetUrl}">
    </head>
    <body>
      <section class="print-page">
        <div class="print-page-line"></div>
        <header class="print-report-header">
          <div>
            <h1>Сводная ведомость KPI · ${escapeHtml(periodLabel)}</h1>
            <div class="print-page-meta">${escapeHtml(scopeLabel)} · Дата печати: ${escapeHtml(printedAt)}</div>
          </div>
          <div class="print-report-header-stats">
            <div>Сотрудников: <strong>${summary.employeesCount}</strong></div>
          <div>Выполнено: <strong>${summary.doneCount}</strong> / Частично: <strong>${summary.partialCount}</strong></div>
          <div>Ср. премия: <strong>${escapeHtml(formatPercent(summary.avgTotalPercent))}</strong></div>
          </div>
        </header>
        ${overviewTable}
      </section>

      <section class="print-page is-wide">
        <div class="print-page-line"></div>
        <header class="print-report-header">
          <div>
            <h1>Сводная таблица KPI (все показатели)</h1>
            <div class="print-page-meta">${escapeHtml(periodLabel)} В· ${escapeHtml(scopeLabel)}</div>
          </div>
          <div class="print-report-header-stats">
            <div>Дата печати: ${escapeHtml(printedAt)}</div>
          </div>
        </header>
        ${metricsTable}
      </section>

      ${employeePages}

      <script>
        window.addEventListener('load', () => {
          setTimeout(() => window.print(), 300);
        });
      </script>
    </body>
    </html>
  `;
}

async function printCurrentKpiReport() {
  if (!state.dashboard) {
    return;
  }

  const employees = getPrintableEmployees();
  if (!employees.length) {
    window.alert('Нет данных для печати по текущему фильтру.');
    return;
  }

  try {
    if (elements.printReportButton) {
      elements.printReportButton.disabled = true;
      elements.printReportButton.textContent = 'Подготовка...';
    }

    const details = await loadPrintableDetails(employees);
    const reportHtml = buildPrintReportHtml(employees, details);
    const printWindow = window.open('', '_blank');

    if (!printWindow) {
      throw new Error('Браузер заблокировал окно печати. Разрешите всплывающее окно для localhost.');
    }

    printWindow.document.open();
    printWindow.document.write(reportHtml);
    printWindow.document.close();
  } catch (error) {
    window.alert(error.message);
  } finally {
    if (elements.printReportButton) {
      elements.printReportButton.disabled = false;
      elements.printReportButton.textContent = 'Печать';
    }
  }
}

function syncObjectFilter(objects) {
  if (!state.objectId) {
    return;
  }

  if (!objects.some((item) => String(item.objectId) === state.objectId)) {
    state.objectId = '';
  }
}

function getVisibleObjects(objects) {
  if (!state.objectId) {
    return objects;
  }

  return objects.filter((item) => String(item.objectId) === state.objectId);
}

function renderResetObjectsButton() {
  elements.resetObjectsButton.hidden = !state.objectId;
}

function renderEmployeeWorkspace() {
  const isDetailMode = Boolean(state.selectedEmployeeId);
  elements.employeeWorkspace.classList.toggle('is-detail-mode', isDetailMode);
  document.body.classList.toggle('detail-focus-mode', isDetailMode);
}

function renderObjectScopedDashboard() {
  const objects = state.dashboard?.objects || [];
  renderResetObjectsButton();
  renderObjectFilter(objects);
  renderObjects(objects);
  renderEmployees();
  syncEmployeeDetailVisibility();
}

async function refreshDashboardAndDetail() {
  const selectedEmployeeId = state.selectedEmployeeId;
  const periodCode = state.selectedPeriod || '';
  const [dashboard, detail] = await Promise.all([
    requestJson(`/api/dashboard?period=${encodeURIComponent(periodCode)}`),
    selectedEmployeeId
      ? requestJson(`/api/employees/${selectedEmployeeId}?period=${encodeURIComponent(periodCode)}`)
      : Promise.resolve(null),
  ]);

  state.dashboard = dashboard;
  state.selectedPeriod = dashboard.selectedPeriod;
  syncObjectFilter(dashboard.objects);
  renderPeriodSelect(dashboard.periods, dashboard.selectedPeriod);
  renderObjectScopedDashboard();

  if (detail && state.selectedEmployeeId === selectedEmployeeId) {
    state.currentDetail = detail;
    renderEmployeeDetail(detail);
  }
}

function renderObjects(objects) {
  const visibleObjects = getVisibleObjects(objects);

  if (!visibleObjects.length) {
    elements.objectGrid.innerHTML = '<div class="empty-state">По выбранному периоду нет объектов.</div>';
    return;
  }

  elements.objectGrid.innerHTML = visibleObjects
    .map((item) => `
      <button
        class="object-card object-card-button ${String(item.objectId) === state.objectId ? 'is-active' : ''}"
        type="button"
        data-object-id="${item.objectId}"
      >
        <h3>${escapeHtml(item.objectName)}</h3>
      </button>
    `)
    .join('');

  elements.objectGrid.querySelectorAll('[data-object-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.objectId = button.getAttribute('data-object-id') || '';
      state.selectedEmployeeId = null;
      renderObjectScopedDashboard();
    });
  });
}

function renderObjectFilter(objects) {
  if (!elements.objectFilter) {
    return;
  }

  const options = ['<option value="">Все объекты</option>'];
  for (const item of objects) {
    options.push(
      `<option value="${item.objectId}" ${String(item.objectId) === state.objectId ? 'selected' : ''}>${escapeHtml(item.objectName)}</option>`
    );
  }
  elements.objectFilter.innerHTML = options.join('');
}

function filteredEmployees() {
  if (!state.dashboard) {
    return [];
  }

  const query = state.search.trim().toLowerCase();
  return state.dashboard.employees.filter((employee) => {
    const matchesSearch =
      !query ||
      `${employee.fullName} ${employee.objectName} ${employee.positionTitle}`.toLowerCase().includes(query);
    const matchesStatus = !state.status || employee.status === state.status;
    const matchesObject = !state.objectId || String(employee.objectId) === state.objectId;
    return matchesSearch && matchesStatus && matchesObject;
  });
}

function renderEmployees() {
  const employees = filteredEmployees();

  if (!employees.length) {
    elements.employeesBody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">Нет сотрудников под текущий фильтр.</div>
        </td>
      </tr>
    `;
    return;
  }

  elements.employeesBody.innerHTML = employees
    .map((employee) => `
      <tr class="employee-row ${employee.employeeId === state.selectedEmployeeId ? 'is-active' : ''}" data-employee-id="${employee.employeeId}">
        <td>
          <div class="employee-name">${escapeHtml(employee.fullName)}</div>
          <div class="employee-pos">${escapeHtml(employee.positionTitle)}</div>
        </td>
        <td>
          <div>${escapeHtml(employee.objectName)}</div>
          <div class="employee-pos">${escapeHtml(employee.managerName || 'без руководителя')}</div>
        </td>
        <td><span class="metric-pill">${formatPercent(employee.blockAPercent)}</span></td>
        <td><span class="metric-pill">${formatPercent(employee.blockBPercent)}</span></td>
        <td>
          <div class="employee-name">${formatPercent(employee.finalTotalPercent)}</div>
          <div class="employee-pos">${formatCurrency(employee.bonusRub)}</div>
        </td>
        <td><span class="status-pill ${statusClass(employee.status)}">${escapeHtml(employee.status)}</span></td>
        <td>
          <span class="approval-pill ${employee.isApproved ? 'is-approved' : ''}">
            ${employee.isApproved ? 'Согласовано' : 'Черновик'}
          </span>
        </td>
      </tr>
    `)
    .join('');

  elements.employeesBody.querySelectorAll('[data-employee-id]').forEach((row) => {
    row.addEventListener('click', () => {
      loadEmployeeDetail(Number(row.getAttribute('data-employee-id'))).catch(showLoadError);
    });
  });
}

function renderDetailPlaceholder(title, copy) {
  elements.employeeDetail.classList.remove('is-project-manager-detail');
  elements.employeeDetail.innerHTML = `
    <div class="detail-empty">
      <p class="detail-empty-title">${escapeHtml(title)}</p>
      <p class="detail-empty-copy">${escapeHtml(copy)}</p>
    </div>
  `;
}

function syncEmployeeDetailVisibility() {
  const employees = filteredEmployees();

  if (!employees.length) {
    state.selectedEmployeeId = null;
    state.currentDetail = null;
    renderEmployeeWorkspace();
    renderDetailPlaceholder('Нет сотрудников', 'Смените фильтр, чтобы увидеть карточку сотрудника.');
    renderDashboardSummary();
    return;
  }

  if (!state.selectedEmployeeId) {
    state.currentDetail = null;
    renderEmployeeWorkspace();
    renderDetailPlaceholder('Выберите сотрудника', 'Нажмите на строку сотрудника, чтобы открыть его карточку.');
    renderDashboardSummary();
    return;
  }

  if (!employees.some((item) => item.employeeId === state.selectedEmployeeId)) {
    state.selectedEmployeeId = null;
    state.currentDetail = null;
    renderEmployees();
    renderEmployeeWorkspace();
    renderDetailPlaceholder('Выберите сотрудника', 'Нажмите на строку сотрудника, чтобы открыть его карточку.');
    renderDashboardSummary();
    return;
  }

  renderEmployeeWorkspace();
  renderDashboardSummary();
}

function normalizeNumericInput(value) {
  return String(value ?? '').trim().replace(',', '.');
}

function getMetricValueInputConfig(metric) {
  if (metric.inputType === 'score') {
    return {
      min: Number(metric.minValue ?? 0),
      max: Number(metric.maxValue ?? 5),
      step: '1',
    };
  }

  return {
    min: Number(metric.minValue ?? 0),
    max: Number(metric.maxValue ?? 100),
    step: String(metric.normText || '').toLowerCase().includes('дн') ? '0.1' : '1',
  };
}

function renderMetricReadonlyValue(metric) {
  if (metric.inputType === 'score') {
    return escapeHtml(formatCompactNumber(metric.rawValue));
  }

  if (String(metric.normText || '').toLowerCase().includes('\u0434\u043d')) {
    return `${escapeHtml(formatCompactNumber(metric.rawValue))} дн`;
  }

  return escapeHtml(formatPercent(metric.rawValue));
}

function renderMetricValueInput(metric, isEditable) {
  const editable = isEditable !== false;
  if (!editable) {
    return `<span class="metric-pill">${renderMetricReadonlyValue(metric)}</span>`;
  }

  const config = getMetricValueInputConfig(metric);
  const isPercentMetric = !String(metric.normText || '').toLowerCase().includes('дн') && metric.inputType !== 'score';
  const displayValue = isPercentMetric
    ? formatPercentInputNumber(metric.rawValue)
    : formatInputNumber(metric.rawValue);
  return `
    <input
      class="detail-table-input"
      type="number"
      min="${formatInputNumber(config.min)}"
      max="${formatInputNumber(config.max)}"
      step="${config.step}"
      value="${displayValue}"
      data-metric-field="raw"
      data-metric-id="${metric.metricId}"
    >
  `;
}

function renderMetricAgreedInput(metric, groupMaxPercent, isEditable) {
  const effectiveValue = metric.agreedPercent ?? metric.calculatedPercent;
  const isDefaultValue = metric.agreedPercent === null || metric.agreedPercent === undefined;
  const editable = isEditable !== false;
  if (!editable) {
    return `<span class="metric-pill ${isDefaultValue ? '' : 'status-partial'}">${escapeHtml(formatPercent(effectiveValue))}</span>`;
  }

  return `
    <input
      class="detail-table-input ${isDefaultValue ? 'is-default' : ''}"
      type="number"
      min="0"
      max="${formatPercentInputNumber(groupMaxPercent)}"
      step="1"
      value="${formatPercentInputNumber(effectiveValue)}"
      data-metric-field="agreed"
      data-metric-id="${metric.metricId}"
      data-calculated-percent="${formatPercentInputNumber(metric.calculatedPercent)}"
    >
  `;
}

function setDetailSaveStatus(message, kind = '') {
  const node = document.getElementById('detail-save-status');
  if (!node) {
    return;
  }

  node.textContent = message;
  node.className = `detail-save-status ${kind}`.trim();
}

async function approveEmployeeRecord(recordId) {
  if (!recordId) {
    return;
  }

  if (!canCurrentDetailBeApproved()) {
    setDetailSaveStatus('Доступ ограничен', 'is-error');
    return;
  }

  try {
    setDetailSaveStatus('Согласование...');
    await sendJson(`/api/employee-records/${recordId}/approve`, 'PATCH', {});
    await refreshDashboardAndDetail();
    setDetailSaveStatus('Согласовано.', 'is-success');
  } catch (error) {
    setDetailSaveStatus(error.message, 'is-error');
  }
}

async function unapproveEmployeeRecord(recordId) {
  if (!recordId) {
    return;
  }

  if (!canCurrentDetailBeApproved()) {
    setDetailSaveStatus('Доступ ограничен', 'is-error');
    return;
  }

  try {
    setDetailSaveStatus('Снятие согласования...');
    await sendJson(`/api/employee-records/${recordId}/unapprove`, 'PATCH', {});
    await refreshDashboardAndDetail();
    setDetailSaveStatus('Согласование снято.', 'is-success');
  } catch (error) {
    setDetailSaveStatus(error.message, 'is-error');
  }
}

async function persistMetricFieldChange(recordId, input) {
  const metricId = Number(input.getAttribute('data-metric-id'));
  const field = input.getAttribute('data-metric-field');

  if (!recordId || !metricId || !field) {
    return;
  }

  if (!canCurrentDetailBeEdited()) {
    setDetailSaveStatus('Доступ ограничен', 'is-error');
    return;
  }

  const payload = {};
  if (field === 'raw') {
    payload.rawValue = normalizeNumericInput(input.value);
  } else {
    const normalizedValue = normalizeNumericInput(input.value);
    if (!normalizedValue) {
      payload.agreedPercent = null;
    } else {
      const numericValue = Number(normalizedValue);
      const calculatedPercent = Number(input.getAttribute('data-calculated-percent') || 0);
      payload.agreedPercent = Math.abs(numericValue - calculatedPercent) < 0.0005 ? null : normalizedValue;
    }
  }

  try {
    setDetailSaveStatus('Сохранение...');
    await sendJson(`/api/employee-records/${recordId}/metrics/${metricId}`, 'PATCH', payload);
    await refreshDashboardAndDetail();
    setDetailSaveStatus('Сохранено.', 'is-success');
  } catch (error) {
    if (state.currentDetail) {
      renderEmployeeDetail(state.currentDetail);
    }
    setDetailSaveStatus(error.message, 'is-error');
  }
}

function attachDetailEditorHandlers(recordId, isApproved) {
  elements.employeeDetail.querySelectorAll('[data-metric-field]').forEach((input) => {
    input.addEventListener('change', () => {
      persistMetricFieldChange(recordId, input);
    });
  });

  const approveButton = elements.employeeDetail.querySelector('[data-detail-action="approve"]');
  if (approveButton) {
    approveButton.addEventListener('click', () => {
      if (isApproved) {
        unapproveEmployeeRecord(recordId);
        return;
      }
      approveEmployeeRecord(recordId);
    });
  }
}

function getProjectManagerImportMetricMap(detail) {
  return new Map(
    (detail?.projectManagerImport?.metrics || []).map((metric) => [metric.metricName, metric])
  );
}

function getProjectManagerImportObjectRows(detail) {
  return Array.isArray(detail?.projectManagerImport?.objects) ? detail.projectManagerImport.objects : [];
}

function getProjectManagerPercentTone(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'is-empty';
  }
  if (Number(value) >= 100) {
    return 'is-good';
  }
  if (Number(value) >= 80) {
    return 'is-warn';
  }
  return 'is-bad';
}

function renderProjectManagerMetricColumns(metricData) {
  return `
    <td class="project-manager-ds-number project-manager-ds-group-start">${escapeHtml(formatMeasureNumber(metricData?.planValue))}</td>
    <td class="project-manager-ds-number">${escapeHtml(formatMeasureNumber(metricData?.factValue))}</td>
    <td class="project-manager-ds-percent-cell">
      <span class="project-manager-ds-percent-value ${getProjectManagerPercentTone(metricData?.actualPercent)}">${escapeHtml(formatPercent(metricData?.actualPercent))}</span>
    </td>
  `;
}

function sumMetricEffectivePercent(metrics) {
  return metrics.reduce((total, metric) => total + Number(metric.effectivePercent ?? metric.calculatedPercent ?? 0), 0);
}

function renderBlockBMetricCard(metric, groupMaxPercent, isEditable, options = {}) {
  const title = options.title || metric?.name || '\u2014';
  const kicker = options.kicker || '\u041f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u044c \u0431\u043b\u043e\u043a\u0430 \u0411';
  const summaryLabel = options.summaryLabel || '\u0418\u0442\u043e\u0433 KPI';
  const noteLabel = options.noteLabel || '\u041d\u043e\u0440\u043c\u0430';
  const noteValue = options.noteValue ?? metric?.normText ?? '\u2014';
  const factLabel = options.factLabel || '\u0424\u0430\u043a\u0442';
  const finalPercent = options.finalPercent ?? (metric ? metric.effectivePercent ?? metric.calculatedPercent : null);
  const weightBadge = metric ? `<span class="metric-pill">${formatPercent(Number(metric.weight || 0) * 100)}</span>` : '';
  const factContent = options.factContent || (metric ? renderMetricValueInput(metric, isEditable) : '<span class="metric-pill">\u2014</span>');
  const calculatedContent = options.calculatedContent || `<strong class="project-manager-import-editor-value">${escapeHtml(metric ? formatPercent(metric.calculatedPercent) : '\u2014')}</strong>`;
  const agreedContent = options.agreedContent || (metric ? renderMetricAgreedInput(metric, groupMaxPercent, isEditable) : '<span class="metric-pill">\u2014</span>');

  return `
    <article class="project-manager-kpi-summary-card block-b-metric-card ${metric ? '' : 'is-empty'}">
      <div class="project-manager-kpi-summary-head">
        <div class="project-manager-panel-title-stack">
          <div class="project-manager-panel-kicker">${escapeHtml(kicker)}</div>
          <h4 class="project-manager-kpi-summary-title">${escapeHtml(title)}</h4>
        </div>
        ${weightBadge}
      </div>
      <div class="project-manager-kpi-summary-main">
        <div>
          <div class="project-manager-kpi-summary-caption">${escapeHtml(summaryLabel)}</div>
          <div class="project-manager-kpi-summary-note">${escapeHtml(noteLabel)}: ${escapeHtml(noteValue)}</div>
        </div>
        <strong class="project-manager-kpi-summary-value">${escapeHtml(formatPercent(finalPercent))}</strong>
      </div>
      <div class="project-manager-import-editor-grid">
        <div class="project-manager-import-editor-cell">
          <span class="project-manager-import-cell-label">${escapeHtml(factLabel)}</span>
          ${factContent}
        </div>
        <div class="project-manager-import-editor-cell">
          <span class="project-manager-import-cell-label">\u0420\u0430\u0441\u0447.%</span>
          ${calculatedContent}
        </div>
        <div class="project-manager-import-editor-cell">
          <span class="project-manager-import-cell-label">\u0421\u043e\u0433\u043b.%</span>
          ${agreedContent}
        </div>
      </div>
    </article>
  `;
}

function renderProjectManagerImportSummaryCard(meta, metric, groupMaxPercent, isEditable) {
  return renderBlockBMetricCard(metric, groupMaxPercent, isEditable, {
    title: meta?.shortLabel || meta?.name || '\u2014',
    kicker: '\u0421\u0440\u0435\u0434\u043d\u0438\u0439 \u0438\u0442\u043e\u0433 KPI',
    factLabel: '\u0412 \u0440\u0430\u0441\u0447\u0451\u0442',
  });
}

function renderProjectManagerBlockBSummaryCards(blockB, isEditable) {
  const metricByName = new Map((blockB?.metrics || []).map((metric) => [metric.name, metric]));
  const groupMaxPercent = Number(blockB?.maxPercent || 0);
  const summaryCards = PROJECT_MANAGER_IMPORT_METRICS
    .map((meta) => renderProjectManagerImportSummaryCard(meta, metricByName.get(meta.name) || null, groupMaxPercent, isEditable))
    .join('');

  return summaryCards
    ? `
      <div class="project-manager-kpi-summary-grid project-manager-kpi-summary-grid-block-b">
        ${summaryCards}
      </div>
    `
    : '';
}

function renderProjectManagerImportCardsLegacy(detail, blockB, isEditable) {
  const metricByName = new Map((blockB?.metrics || []).map((metric) => [metric.name, metric]));
  const importMetricMap = getProjectManagerImportMetricMap(detail);
  const objectRows = getProjectManagerImportObjectRows(detail);
  const groupMaxPercent = Number(blockB?.maxPercent || 0);
  const objectCount = Number(detail?.projectManagerImport?.objectCount || 0);
  const importedAt = detail?.projectManagerImport?.importedAt || '';
  const cashInMeta = PROJECT_MANAGER_IMPORT_METRICS.find((metric) => metric.key === 'cashIn');
  const cashOutMeta = PROJECT_MANAGER_IMPORT_METRICS.find((metric) => metric.key === 'cashOut');
  const workMeta = PROJECT_MANAGER_IMPORT_METRICS.find((metric) => metric.key === 'work');
  const cashInMetric = cashInMeta ? metricByName.get(cashInMeta.name) || null : null;
  const cashOutMetric = cashOutMeta ? metricByName.get(cashOutMeta.name) || null : null;
  const workMetric = workMeta ? metricByName.get(workMeta.name) || null : null;
  const cashInImport = cashInMeta ? importMetricMap.get(cashInMeta.name) || null : null;
  const cashOutImport = cashOutMeta ? importMetricMap.get(cashOutMeta.name) || null : null;
  const workImport = workMeta ? importMetricMap.get(workMeta.name) || null : null;

  const dsRows = objectRows.length
    ? objectRows.map((row) => `
      <tr>
        <td class="project-manager-ds-object">${escapeHtml(row.objectName || '—')}</td>
        <td class="project-manager-ds-number project-manager-ds-group-start">${escapeHtml(formatMeasureNumber(row.cashIn?.planValue))}</td>
        <td class="project-manager-ds-number">${escapeHtml(formatMeasureNumber(row.cashIn?.factValue))}</td>
        <td class="project-manager-ds-percent">${escapeHtml(formatPercent(row.cashIn?.actualPercent))}</td>
        <td class="project-manager-ds-number project-manager-ds-group-start">${escapeHtml(formatMeasureNumber(row.cashOut?.planValue))}</td>
        <td class="project-manager-ds-number">${escapeHtml(formatMeasureNumber(row.cashOut?.factValue))}</td>
        <td class="project-manager-ds-percent">${escapeHtml(formatPercent(row.cashOut?.actualPercent))}</td>
      </tr>
    `).join('')
    : `
      <tr>
        <td colspan="7">
          <div class="empty-state project-manager-ds-empty">По сотруднику ещё нет загруженных данных по объектам.</div>
        </td>
      </tr>
    `;

  return `
    <section class="project-manager-import-section">
      <div class="project-manager-import-top">
        <section class="project-manager-ds-panel">
          <div class="project-manager-panel-head">
            <div class="project-manager-panel-title-stack">
              <div class="project-manager-panel-kicker">Данные загрузки export</div>
              <h3 class="project-manager-panel-title">ДС по объектам</h3>
              <div class="project-manager-panel-copy">
                ${objectCount > 0
                  ? `План/факт по каждому объекту. KPI по поступлению и расходованию считается как среднее по ${objectCount} объектам.`
                  : 'По сотруднику ещё нет загруженных данных по объектам.'}
                ${importedAt ? ` Обновлено: ${escapeHtml(formatDateTime(importedAt))}.` : ''}
              </div>
            </div>
            <div class="project-manager-panel-stats">
              <span class="project-manager-panel-stat">Объектов: ${escapeHtml(String(objectCount || 0))}</span>
              <span class="project-manager-panel-stat">Поступление KPI: ${escapeHtml(cashInMetric ? formatPercent(cashInMetric.effectivePercent ?? cashInMetric.calculatedPercent) : '—')}</span>
              <span class="project-manager-panel-stat">Расходование KPI: ${escapeHtml(cashOutMetric ? formatPercent(cashOutMetric.effectivePercent ?? cashOutMetric.calculatedPercent) : '—')}</span>
            </div>
          </div>

          <div class="project-manager-ds-table-wrap">
            <table class="project-manager-ds-table">
              <colgroup>
                <col class="project-manager-ds-col-object">
                <col class="project-manager-ds-col-number">
                <col class="project-manager-ds-col-number">
                <col class="project-manager-ds-col-percent">
                <col class="project-manager-ds-col-number">
                <col class="project-manager-ds-col-number">
                <col class="project-manager-ds-col-percent">
              </colgroup>
              <thead>
                <tr>
                  <th rowspan="2" class="project-manager-ds-object-head">Объект</th>
                  <th colspan="3" class="project-manager-ds-group-head">Поступление ДС</th>
                  <th colspan="3" class="project-manager-ds-group-head project-manager-ds-group-head-start">Расходование ДС</th>
                </tr>
                <tr>
                  <th class="project-manager-ds-subhead project-manager-ds-group-start">План</th>
                  <th class="project-manager-ds-subhead">Факт</th>
                  <th class="project-manager-ds-subhead">Исп.%</th>
                  <th class="project-manager-ds-subhead project-manager-ds-group-start">План</th>
                  <th class="project-manager-ds-subhead">Факт</th>
                  <th class="project-manager-ds-subhead">Исп.%</th>
                </tr>
              </thead>
              <tbody>
                ${dsRows}
              </tbody>
              <tfoot>
                <tr class="is-total-row">
                  <td class="project-manager-ds-object project-manager-ds-total-label">Итого</td>
                  <td class="project-manager-ds-number project-manager-ds-group-start">${escapeHtml(formatMeasureNumber(cashInImport?.planValue))}</td>
                  <td class="project-manager-ds-number">${escapeHtml(formatMeasureNumber(cashInImport?.factValue))}</td>
                  <td class="project-manager-ds-percent">${escapeHtml(formatPercent(cashInImport?.actualPercent))}</td>
                  <td class="project-manager-ds-number project-manager-ds-group-start">${escapeHtml(formatMeasureNumber(cashOutImport?.planValue))}</td>
                  <td class="project-manager-ds-number">${escapeHtml(formatMeasureNumber(cashOutImport?.factValue))}</td>
                  <td class="project-manager-ds-percent">${escapeHtml(formatPercent(cashOutImport?.actualPercent))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <article class="project-manager-work-panel ${workImport ? '' : 'is-empty'}">
          <div class="project-manager-panel-head">
            <div class="project-manager-panel-title-stack">
              <div class="project-manager-panel-kicker">Export · ${escapeHtml(workMeta?.shortLabel || 'СМР')}</div>
              <h3 class="project-manager-panel-title">${escapeHtml(workMeta?.name || 'Исполнение Плана выполнения СМР, руб.')}</h3>
            </div>
            ${workMetric ? `<span class="metric-pill">${formatPercent(Number(workMetric.weight || 0) * 100)}</span>` : ''}
          </div>

          <div class="project-manager-work-grid">
            <div class="project-manager-import-cell">
              <span class="project-manager-import-cell-label">План</span>
              <strong class="project-manager-import-cell-value">${escapeHtml(formatMeasureNumber(workImport?.planValue))}</strong>
            </div>
            <div class="project-manager-import-cell">
              <span class="project-manager-import-cell-label">Факт</span>
              <strong class="project-manager-import-cell-value">${escapeHtml(formatMeasureNumber(workImport?.factValue))}</strong>
            </div>
            <div class="project-manager-import-cell">
              <span class="project-manager-import-cell-label">Исп.</span>
              <strong class="project-manager-import-cell-value">${escapeHtml(formatPercent(workImport?.actualPercent))}</strong>
            </div>
            <div class="project-manager-import-cell">
              <span class="project-manager-import-cell-label">Норма</span>
              <strong class="project-manager-import-cell-value">${escapeHtml(workMetric?.normText || '—')}</strong>
            </div>
          </div>

          <div class="project-manager-import-editor-grid">
            <div class="project-manager-import-editor-cell">
              <span class="project-manager-import-cell-label">В расчёт</span>
              ${workMetric ? renderMetricValueInput(workMetric, isEditable) : '<span class="metric-pill">—</span>'}
            </div>
            <div class="project-manager-import-editor-cell">
              <span class="project-manager-import-cell-label">Расч.%</span>
              <strong class="project-manager-import-editor-value">${escapeHtml(workMetric ? formatPercent(workMetric.calculatedPercent) : '—')}</strong>
            </div>
            <div class="project-manager-import-editor-cell">
              <span class="project-manager-import-cell-label">Согл.%</span>
              ${workMetric ? renderMetricAgreedInput(workMetric, groupMaxPercent, isEditable) : '<span class="metric-pill">—</span>'}
            </div>
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderProjectManagerImportCards(detail, blockB, isEditable) {
  const importMetricMap = getProjectManagerImportMetricMap(detail);
  const objectRows = getProjectManagerImportObjectRows(detail);
  const objectCount = Number(detail?.projectManagerImport?.objectCount || 0);
  const importedAt = detail?.projectManagerImport?.importedAt || '';
  const cashInMeta = PROJECT_MANAGER_IMPORT_METRICS.find((metric) => metric.key === 'cashIn');
  const cashOutMeta = PROJECT_MANAGER_IMPORT_METRICS.find((metric) => metric.key === 'cashOut');
  const workMeta = PROJECT_MANAGER_IMPORT_METRICS.find((metric) => metric.key === 'work');
  const cashInImport = cashInMeta ? importMetricMap.get(cashInMeta.name) || null : null;
  const cashOutImport = cashOutMeta ? importMetricMap.get(cashOutMeta.name) || null : null;
  const workImport = workMeta ? importMetricMap.get(workMeta.name) || null : null;
  const hasScrollableTable = objectRows.length > 8;

  const dsRows = objectRows.length
    ? objectRows.map((row) => `
      <tr>
        <td class="project-manager-ds-object">${escapeHtml(row.objectName || '—')}</td>
        ${renderProjectManagerMetricColumns(row.cashIn)}
        ${renderProjectManagerMetricColumns(row.cashOut)}
        ${renderProjectManagerMetricColumns(row.work)}
      </tr>
    `).join('')
    : `
      <tr>
        <td colspan="10">
          <div class="empty-state project-manager-ds-empty">По сотруднику ещё нет загруженных данных по объектам.</div>
        </td>
      </tr>
    `;

  return `
    <section class="project-manager-import-section">
      <div class="project-manager-import-top">
        <section class="project-manager-ds-panel">
          <div class="project-manager-panel-head">
            <div class="project-manager-panel-title-stack">
              <div class="project-manager-panel-kicker">Данные загрузки export</div>
              <h3 class="project-manager-panel-title">Показатели по объектам</h3>
              <div class="project-manager-panel-copy">
                ${objectCount > 0
                  ? `План/факт показан по каждому объекту. KPI по поступлению, расходованию и СМР считается как среднее по ${objectCount} объектам.`
                  : 'По сотруднику ещё нет загруженных данных по объектам.'}
                ${importedAt ? ` Обновлено: ${escapeHtml(formatDateTime(importedAt))}.` : ''}
              </div>
            </div>
            <div class="project-manager-panel-stats">
              <span class="project-manager-panel-stat">Объектов: ${escapeHtml(String(objectCount || 0))}</span>
            </div>
          </div>

          <div class="project-manager-ds-table-wrap${hasScrollableTable ? ' is-scrollable' : ''}">
            <table class="project-manager-ds-table">
              <colgroup>
                <col class="project-manager-ds-col-object">
                <col class="project-manager-ds-col-plan">
                <col class="project-manager-ds-col-fact">
                <col class="project-manager-ds-col-percent">
                <col class="project-manager-ds-col-plan">
                <col class="project-manager-ds-col-fact">
                <col class="project-manager-ds-col-percent">
                <col class="project-manager-ds-col-plan">
                <col class="project-manager-ds-col-fact">
                <col class="project-manager-ds-col-percent">
              </colgroup>
              <thead>
                <tr>
                  <th rowspan="2" class="project-manager-ds-object-head">Объект</th>
                  <th colspan="3" class="project-manager-ds-group-head">Поступление ДС</th>
                  <th colspan="3" class="project-manager-ds-group-head">Расходование ДС</th>
                  <th colspan="3" class="project-manager-ds-group-head">Выполнение СМР</th>
                </tr>
                <tr>
                  <th class="project-manager-ds-subhead project-manager-ds-group-start">План</th>
                  <th class="project-manager-ds-subhead">Факт</th>
                  <th class="project-manager-ds-subhead">%</th>
                  <th class="project-manager-ds-subhead project-manager-ds-group-start">План</th>
                  <th class="project-manager-ds-subhead">Факт</th>
                  <th class="project-manager-ds-subhead">%</th>
                  <th class="project-manager-ds-subhead project-manager-ds-group-start">План</th>
                  <th class="project-manager-ds-subhead">Факт</th>
                  <th class="project-manager-ds-subhead">%</th>
                </tr>
              </thead>
              <tbody>
                ${dsRows}
              </tbody>
              <tfoot>
                <tr class="is-total-row">
                  <td class="project-manager-ds-object project-manager-ds-total-label">Итого</td>
                  ${renderProjectManagerMetricColumns(cashInImport)}
                  ${renderProjectManagerMetricColumns(cashOutImport)}
                  ${renderProjectManagerMetricColumns(workImport)}
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderProjectManagerTotals(detail) {
  return `
    <div class="detail-summary-grid detail-summary-grid-project">
      <div class="detail-summary-item">
        <span class="detail-summary-label">Итого блок А</span>
        <span class="detail-summary-value">${escapeHtml(formatPercent(detail.blockAPercent))}</span>
      </div>
      <div class="detail-summary-item">
        <span class="detail-summary-label">Итого блок Б</span>
        <span class="detail-summary-value">${escapeHtml(formatPercent(detail.blockBPercent))}</span>
      </div>
      <div class="detail-summary-item detail-summary-item-strong">
        <span class="detail-summary-label">Итого премии %</span>
        <span class="detail-summary-value">${escapeHtml(formatPercent(detail.finalTotalPercent))}</span>
      </div>
    </div>
  `;
}

function renderGroupTable(group, totalPercent, isEditable, options = {}) {
  const isBlockA = group.code === 'block_a';
  const metrics = Array.isArray(options.metrics) ? options.metrics : group.metrics;
  const title = options.title || group.name;
  const totalLabel = options.totalLabel || (isBlockA ? 'Итого блок А:' : 'Итого блок Б:');
  const panelClass = ['detail-group-panel', isBlockA ? 'is-block-a' : 'is-block-b', options.extraClass || '']
    .filter(Boolean)
    .join(' ');
  const firstColumnLabel = isBlockA ? 'Критерий' : 'Показатель';
  const middleColumns = isBlockA
    ? `
        <th>Вес</th>
        <th>Оценка</th>
        <th>Расч.%</th>
        <th>Согл.%</th>
      `
    : `
        <th>Вес</th>
        <th>Норма</th>
        <th>Факт</th>
        <th>Расч.%</th>
        <th>Согл.%</th>
      `;

  const rows = metrics
    .map((metric) => `
      <tr>
        <td class="detail-table-metric">${escapeHtml(metric.name)}</td>
        <td>${formatPercent(Number(metric.weight) * 100)}</td>
        ${
          isBlockA
            ? `
              <td class="detail-table-input-cell">${renderMetricValueInput(metric, isEditable)}</td>
              <td>${formatPercent(metric.calculatedPercent)}</td>
              <td class="detail-table-input-cell">${renderMetricAgreedInput(metric, group.maxPercent, isEditable)}</td>
            `
            : `
              <td>${escapeHtml(metric.normText || '-')}</td>
              <td class="detail-table-input-cell">${renderMetricValueInput(metric, isEditable)}</td>
              <td>${formatPercent(metric.calculatedPercent)}</td>
              <td class="detail-table-input-cell">${renderMetricAgreedInput(metric, group.maxPercent, isEditable)}</td>
            `
        }
      </tr>
    `)
    .join('');

  return `
    <section class="${panelClass}">
      <div class="metric-group-header">
        <div class="metric-group-title">${escapeHtml(title)}</div>
      </div>
      <div class="table-wrap">
        <table class="detail-compact-table">
          <thead>
            <tr>
              <th>${firstColumnLabel}</th>
              ${middleColumns}
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <div class="detail-group-total">
        <span>${escapeHtml(totalLabel)}</span>
        <strong>${formatPercent(totalPercent)}</strong>
      </div>
    </section>
  `;
}

function renderProjectManagerOtherBlockBSection(blockB, metrics, totalPercent, isEditable) {
  const summaryCards = renderProjectManagerBlockBSummaryCards(blockB, isEditable);
  const rows = metrics.length
    ? metrics
      .map((metric) => `
        <tr>
          <td class="detail-table-metric">${escapeHtml(metric.name)}</td>
          <td>${formatPercent(Number(metric.weight) * 100)}</td>
          <td>${escapeHtml(metric.normText || '-')}</td>
          <td class="detail-table-input-cell">${renderMetricValueInput(metric, isEditable)}</td>
          <td>${formatPercent(metric.calculatedPercent)}</td>
          <td class="detail-table-input-cell">${renderMetricAgreedInput(metric, blockB.maxPercent, isEditable)}</td>
        </tr>
      `)
      .join('')
    : `
      <tr>
        <td colspan="6">
          <div class="empty-state">В этом блоке пока нет дополнительных показателей.</div>
        </td>
      </tr>
    `;

  return `
    <section class="detail-group-panel is-block-b detail-group-panel-compact">
      <div class="metric-group-header">
        <div class="metric-group-title">Прочие показатели блока Б</div>
      </div>
      ${summaryCards}
      <div class="table-wrap">
        <table class="detail-compact-table">
          <thead>
            <tr>
              <th>Показатель</th>
              <th>Вес</th>
              <th>Норма</th>
              <th>Факт</th>
              <th>Расч.%</th>
              <th>Согл.%</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <div class="detail-group-total">
        <span>Прочие блок Б:</span>
        <strong>${formatPercent(totalPercent)}</strong>
      </div>
    </section>
  `;
}

function renderBlockBMetricSection(metrics, totalPercent, groupMaxPercent, isEditable, options = {}) {
  const title = options.title || '\u0411\u043b\u043e\u043a \u0411';
  const totalLabel = options.totalLabel || '\u0418\u0442\u043e\u0433\u043e \u0431\u043b\u043e\u043a \u0411:';
  const extraClass = options.extraClass || '';
  const prependContent = options.prependContent || '';
  const emptyMessage = options.emptyMessage || '\u0412 \u044d\u0442\u043e\u043c \u0431\u043b\u043e\u043a\u0435 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442 \u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u0435\u0439.';
  const cards = Array.isArray(metrics)
    ? metrics.map((metric) => renderBlockBMetricCard(metric, groupMaxPercent, isEditable)).join('')
    : '';
  const cardGrid = cards
    ? `
      <div class="project-manager-kpi-summary-grid project-manager-kpi-summary-grid-block-b">
        ${cards}
      </div>
    `
    : (!prependContent ? `<div class="empty-state">${escapeHtml(emptyMessage)}</div>` : '');

  return `
    <section class="detail-group-panel is-block-b ${extraClass}">
      <div class="metric-group-header">
        <div class="metric-group-title">${escapeHtml(title)}</div>
      </div>
      ${prependContent}
      ${cardGrid}
      <div class="detail-group-total">
        <span>${escapeHtml(totalLabel)}</span>
        <strong>${formatPercent(totalPercent)}</strong>
      </div>
    </section>
  `;
}

function renderProjectManagerBlockBCardSection(blockB, metrics, totalPercent, isEditable) {
  return renderBlockBMetricSection(metrics, totalPercent, Number(blockB?.maxPercent || 0), isEditable, {
    title: '\u0411\u043b\u043e\u043a \u0411 \u2014 \u041a\u043b\u044e\u0447\u0435\u0432\u044b\u0435 \u043f\u043e\u043a\u0430\u0437\u0430\u0442\u0435\u043b\u0438 \u0434\u0435\u044f\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u0438',
    totalLabel: '\u0418\u0442\u043e\u0433\u043e \u0431\u043b\u043e\u043a \u0411:',
    extraClass: 'detail-group-panel-compact',
    prependContent: renderProjectManagerBlockBSummaryCards(blockB, isEditable),
  });
}

function renderEmployeeDetail(detail) {
  const blockA = detail.groups.find((group) => group.code === 'block_a');
  const blockB = detail.groups.find((group) => group.code === 'block_b');
  const detailPermissions = detail.permissions || {};
  const canEdit = Boolean(detailPermissions.canEdit);
  const canApprove = Boolean(detailPermissions.canApprove);
  const isProjectManager = isProjectManagerDetail(detail);
  const otherBlockBMetrics = (blockB?.metrics || []).filter((metric) => !PROJECT_MANAGER_IMPORT_METRIC_NAMES.has(metric.name));
  const otherBlockBPercent = sumMetricEffectivePercent(otherBlockBMetrics);
  const detailBody = isProjectManager
    ? `
      ${renderProjectManagerImportCards(detail, blockB, canEdit)}
      <div class="detail-groups-grid detail-groups-grid-project">
        ${blockA ? renderGroupTable(blockA, detail.blockAPercent, canEdit, { extraClass: 'detail-group-panel-compact' }) : ''}
        ${blockB ? renderGroupTable(blockB, detail.blockBPercent, canEdit, { extraClass: 'detail-group-panel-compact' }) : ''}
        ${false && otherBlockBMetrics.length
          ? renderGroupTable(
            blockB,
            otherBlockBPercent,
            canEdit,
            {
              metrics: otherBlockBMetrics,
              title: 'Прочие показатели блока Б',
              totalLabel: 'Прочие блок Б:',
              extraClass: 'detail-group-panel-compact',
            }
          )
          : ''}
      </div>
      ${renderProjectManagerTotals(detail)}
    `
    : `
      <div class="detail-groups-grid">
        ${blockA ? renderGroupTable(blockA, detail.blockAPercent, canEdit) : ''}
        ${blockB ? renderGroupTable(blockB, detail.blockBPercent, canEdit) : ''}
      </div>

      <div class="detail-final-total">
        <span>Итого премии %</span>
        <strong>${formatPercent(detail.finalTotalPercent)}</strong>
      </div>
    `;
  state.currentDetail = detail;
  elements.employeeDetail.classList.toggle('is-project-manager-detail', isProjectManager);

  elements.employeeDetail.innerHTML = `
    <div class="detail-meta">
      <div class="detail-header-minimal">
        <div class="detail-title-stack">
          <h2 class="detail-title">${escapeHtml(detail.fullName)}</h2>
          <div class="employee-pos">Автор: ${escapeHtml(detail.createdByDisplayName || '—')} · Создано: ${escapeHtml(formatDateTime(detail.createdAt))}</div>
          <div class="employee-pos">Последнее изменение: ${escapeHtml(detail.updatedByDisplayName || '—')} · ${escapeHtml(formatDateTime(detail.updatedAt))}</div>
          <div class="employee-pos">Статус заявки: ${escapeHtml(getRequestStatusLabel(detail.requestStatus))} · Руководитель: ${escapeHtml(detail.object?.managerName || '—')}</div>
          <div id="detail-save-status" class="detail-save-status"></div>
        </div>
        <button
          class="action-button detail-approve-button ${detail.isApproved ? 'is-approved' : ''}"
          type="button"
          data-detail-action="approve"
        >
          ${detail.isApproved ? 'Снять согласование' : 'Согласовать'}
        </button>
      </div>

      ${detailBody}
    </div>
  `;

  if (!canApprove) {
    elements.employeeDetail.querySelector('[data-detail-action="approve"]')?.remove();
  }

  if (!canEdit) {
    elements.employeeDetail.querySelectorAll('[data-metric-field]').forEach((input) => {
      input.disabled = true;
      input.readOnly = true;
    });
  }

  attachDetailEditorHandlers(detail.recordId, detail.isApproved);
}

async function loadEmployeeDetail(employeeId) {
  state.selectedEmployeeId = employeeId;
  renderEmployees();
  renderEmployeeWorkspace();
  renderDashboardSummary();
  renderDetailPlaceholder('Загрузка карточки...', '');

  const detail = await requestJson(`/api/employees/${employeeId}?period=${encodeURIComponent(state.selectedPeriod)}`);
  if (state.selectedEmployeeId !== employeeId) {
    return;
  }
  renderEmployeeDetail(detail);
}

function getInitialPeriodCodeFromUrl() {
  const currentUrl = new URL(window.location.href);
  return currentUrl.searchParams.get('period') || getStoredPeriodCode();
}

function syncSelectedPeriodInUrl(periodCode) {
  const currentUrl = new URL(window.location.href);
  if (periodCode) {
    currentUrl.searchParams.set('period', periodCode);
  } else {
    currentUrl.searchParams.delete('period');
  }
  window.history.replaceState({}, '', currentUrl);
}

async function loadDashboard(periodCode) {
  const dashboard = await requestJson(`/api/dashboard?period=${encodeURIComponent(periodCode || '')}`);
  state.dashboard = dashboard;
  state.selectedPeriod = dashboard.selectedPeriod;
  state.selectedEmployeeId = null;
  state.currentDetail = null;
  syncSelectedPeriodInUrl(state.selectedPeriod);
  storeSelectedPeriodCode(state.selectedPeriod);

  syncObjectFilter(dashboard.objects);
  renderPeriodSelect(dashboard.periods, dashboard.selectedPeriod);
  renderObjectScopedDashboard();
}

function showLoadError(error) {
  console.error(error);
  elements.objectGrid.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  elements.employeesBody.innerHTML = `
    <tr>
      <td colspan="7">
        <div class="empty-state">Не удалось загрузить данные: ${escapeHtml(error.message)}</div>
      </td>
    </tr>
  `;
  renderDetailPlaceholder('Ошибка загрузки', error.message);
}

function attachEvents() {
  window.addEventListener('kpi-auth-ready', () => {
    applyRolePermissions();
  });

  elements.periodSelect.addEventListener('change', () => {
    loadDashboard(elements.periodSelect.value).catch(showLoadError);
  });

  if (elements.openCreateEmployeeButton) {
    elements.openCreateEmployeeButton.addEventListener('click', () => {
      openCreateEmployeeDialog();
    });
  }

  if (elements.openPeriodCopyButton) {
    elements.openPeriodCopyButton.addEventListener('click', () => {
      openPeriodCopyDialog().catch(showLoadError);
    });
  }

  if (elements.closePeriodCopyButton) {
    elements.closePeriodCopyButton.addEventListener('click', () => {
      closePeriodCopyDialog();
    });
  }

  if (elements.cancelPeriodCopyButton) {
    elements.cancelPeriodCopyButton.addEventListener('click', () => {
      closePeriodCopyDialog();
    });
  }

  if (elements.periodCopyForm) {
    elements.periodCopyForm.addEventListener('submit', (event) => {
      submitPeriodCopyForm(event).catch(showLoadError);
    });
  }

  if (elements.periodCopySourceSelect) {
    elements.periodCopySourceSelect.addEventListener('change', () => {
      if (elements.periodCopyTargetSelect?.value === elements.periodCopySourceSelect.value) {
        elements.periodCopyTargetSelect.value = getAlternatePeriodCode(elements.periodCopySourceSelect.value);
      }
      syncPeriodCopyStatus();
      updatePeriodCopySubmitState();
    });
  }

  if (elements.periodCopyTargetSelect) {
    elements.periodCopyTargetSelect.addEventListener('change', () => {
      syncPeriodCopyStatus();
      updatePeriodCopySubmitState();
    });
  }

  if (elements.closeCreateEmployeeButton) {
    elements.closeCreateEmployeeButton.addEventListener('click', () => {
      closeCreateEmployeeDialog();
    });
  }

  if (elements.cancelCreateEmployeeButton) {
    elements.cancelCreateEmployeeButton.addEventListener('click', () => {
      closeCreateEmployeeDialog();
    });
  }

  if (elements.createEmployeeForm) {
    elements.createEmployeeForm.addEventListener('submit', (event) => {
      submitCreateEmployeeForm(event).catch(showLoadError);
    });
  }

  if (elements.createEmployeeInput) {
    elements.createEmployeeInput.addEventListener('input', () => {
      if (!findCreateEmployeeByName(elements.createEmployeeInput.value)) {
        setCreateEmployeeStatus('');
      }
      syncCreateEmployeeObject();
    });
    elements.createEmployeeInput.addEventListener('change', () => {
      syncCreateEmployeeObject();
    });
  }

  if (elements.createObjectSelect) {
    elements.createObjectSelect.addEventListener('change', () => {
      syncCreateEmployeeStatus();
      updateCreateEmployeeSubmitState();
    });
  }

  if (elements.printReportButton) {
    elements.printReportButton.addEventListener('click', () => {
      printCurrentKpiReport().catch(showLoadError);
    });
  }

  if (elements.searchInput) {
    elements.searchInput.addEventListener('input', () => {
      state.search = elements.searchInput.value;
      renderEmployees();
      syncEmployeeDetailVisibility();
    });
  }

  if (elements.statusFilter) {
    elements.statusFilter.addEventListener('change', () => {
      state.status = elements.statusFilter.value;
      renderEmployees();
      syncEmployeeDetailVisibility();
    });
  }

  if (elements.objectFilter) {
    elements.objectFilter.addEventListener('change', () => {
      state.objectId = elements.objectFilter.value;
      state.selectedEmployeeId = null;
      state.currentDetail = null;
      renderObjectScopedDashboard();
    });
  }

  elements.resetObjectsButton.addEventListener('click', () => {
    state.objectId = '';
    state.selectedEmployeeId = null;
    state.currentDetail = null;
    state.search = '';
    state.status = '';
    if (elements.searchInput) {
      elements.searchInput.value = '';
    }
    if (elements.statusFilter) {
      elements.statusFilter.value = '';
    }
    if (elements.objectFilter) {
      elements.objectFilter.value = '';
    }
    renderObjectScopedDashboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  if (elements.resetEmployeesButton) {
    elements.resetEmployeesButton.addEventListener('click', () => {
      state.selectedEmployeeId = null;
      state.currentDetail = null;
      renderEmployees();
      syncEmployeeDetailVisibility();
    });
  }
}

async function boot() {
  try {
    attachEvents();
    applyRolePermissions();
    await loadDashboard(getInitialPeriodCodeFromUrl());
  } catch (error) {
    showLoadError(error);
  }
}

boot();
