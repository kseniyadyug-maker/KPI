const SELECTED_PERIOD_STORAGE_KEY = 'kpi.selectedPeriod';

const state = {
  periods: [],
  selectedPeriod: '',
  lastResult: null,
  pendingUploadTypeKey: '',
};

const elements = {
  pageStatus: document.getElementById('upload-page-status'),
  selectedPeriod: document.getElementById('upload-selected-period'),
  executionForm: document.getElementById('execution-discipline-form'),
  executionFileInput: document.getElementById('execution-discipline-file'),
  executionSubmitButton: document.getElementById('execution-discipline-submit'),
  executionStatus: document.getElementById('execution-discipline-status'),
  contractForm: document.getElementById('contract-approvals-form'),
  contractFileInput: document.getElementById('contract-approvals-file'),
  contractSubmitButton: document.getElementById('contract-approvals-submit'),
  contractStatus: document.getElementById('contract-approvals-status'),
  projectManagerExportForm: document.getElementById('project-manager-export-form'),
  projectManagerExportFileInput: document.getElementById('project-manager-export-file'),
  projectManagerExportSubmitButton: document.getElementById('project-manager-export-submit'),
  projectManagerExportStatus: document.getElementById('project-manager-export-status'),
  resultPanel: document.getElementById('upload-result-panel'),
  resultSummary: document.getElementById('upload-result-summary'),
  resultBody: document.getElementById('upload-results-body'),
  periodDialog: document.getElementById('upload-period-dialog'),
  periodDialogForm: document.getElementById('upload-period-form'),
  periodDialogTitle: document.getElementById('upload-period-dialog-title'),
  periodDialogSelect: document.getElementById('upload-period-dialog-select'),
  periodDialogStatus: document.getElementById('upload-period-dialog-status'),
  periodDialogCloseButton: document.getElementById('close-upload-period-dialog'),
  periodDialogCancelButton: document.getElementById('cancel-upload-period-dialog'),
};

const UPLOAD_TYPES = {
  executionDiscipline: {
    label: 'Исполнительская дисциплина',
    endpoint: '/api/uploads/execution-discipline',
    fileInput: elements.executionFileInput,
    submitButton: elements.executionSubmitButton,
    statusNode: elements.executionStatus,
    form: elements.executionForm,
    emptyFileMessage: 'Выберите Excel-файл с исполнительской дисциплиной.',
    progressMessage: 'Загрузка файла с исполнительской дисциплиной...',
    successMessage: (result) => `Загрузка завершена. Обновлено строк: ${result.updatedCount}.`,
  },
  contractApprovals: {
    label: 'Согласование договоров',
    endpoint: '/api/uploads/contract-approvals',
    fileInput: elements.contractFileInput,
    submitButton: elements.contractSubmitButton,
    statusNode: elements.contractStatus,
    form: elements.contractForm,
    emptyFileMessage: 'Выберите Excel-файл с согласованием договоров.',
    progressMessage: 'Загрузка файла с согласованием договоров...',
    successMessage: (result) => `Загрузка завершена. Обновлено строк: ${result.updatedCount}.`,
  },
  projectManagerExport: {
    label: 'Export по руководителям',
    endpoint: '/api/uploads/project-manager-export',
    fileInput: elements.projectManagerExportFileInput,
    submitButton: elements.projectManagerExportSubmitButton,
    statusNode: elements.projectManagerExportStatus,
    form: elements.projectManagerExportForm,
    emptyFileMessage: 'Выберите export-выгрузку Excel.',
    progressMessage: 'Загрузка export-выгрузки...',
    successMessage: (result) => `Загрузка завершена. Обновлено руководителей: ${result.updatedCount}.`,
  },
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '-';
  }
  return Number(value).toFixed(3).replace(/\.?0+$/, '');
}

function roundPercentToken(rawToken) {
  const numericValue = Number(String(rawToken).replace(',', '.'));
  return Number.isFinite(numericValue) ? String(Math.round(numericValue)) : String(rawToken);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  if (typeof value === 'string' && value.includes('%')) {
    return value.replace(/(-?\d+(?:[.,]\d+)?)\s*%/g, (_, token) => `${roundPercentToken(token)}%`);
  }

  const normalized = String(value).trim().replace('%', '').replace(',', '.');
  const numericValue = Number(normalized);
  if (!Number.isFinite(numericValue)) {
    return String(value);
  }

  return `${Math.round(numericValue)}%`;
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
    // Ignore storage errors and keep upload page functional.
  }
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

function setPageStatus(message) {
  elements.pageStatus.textContent = message;
}

function setUploadStatus(node, message, kind = '') {
  if (!node) {
    return;
  }
  node.textContent = message;
  node.className = `form-status ${kind}`.trim();
}

function buildPeriodOptions(selectedPeriodCode = '') {
  return [
    '<option value="">Выберите период KPI</option>',
    ...state.periods.map((period) => `
      <option value="${escapeHtml(period.code)}" ${period.code === selectedPeriodCode ? 'selected' : ''}>
        ${escapeHtml(period.label)}${period.status === 'open' ? ' · открыто' : ''}
      </option>
    `),
  ].join('');
}

function renderSelectedPeriodHint() {
  if (!elements.selectedPeriod) {
    return;
  }

  const selectedPeriod = state.periods.find((period) => period.code === state.selectedPeriod);
  if (!selectedPeriod) {
    elements.selectedPeriod.textContent = 'Месяц будет выбран при загрузке файла.';
    return;
  }

  elements.selectedPeriod.textContent = `Последний выбранный месяц: ${selectedPeriod.label}. Его можно изменить перед каждой загрузкой.`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result || '');
      const separatorIndex = result.indexOf(',');
      resolve(separatorIndex >= 0 ? result.slice(separatorIndex + 1) : result);
    };

    reader.onerror = () => {
      reject(new Error('Не удалось прочитать выбранный файл.'));
    };

    reader.readAsDataURL(file);
  });
}

function renderUploadResults(result) {
  state.lastResult = result;
  elements.resultPanel.hidden = false;

  const summaryItems = [
    { label: 'Импорт', value: result.importLabel || '-' },
    { label: 'Показатель', value: result.metricLabel || '-' },
    { label: 'Период', value: result.periodLabel || result.periodCode || '-' },
    { label: 'Лист', value: result.sheetName || '-' },
    { label: 'Файл', value: result.fileName || '-' },
    { label: 'Всего строк', value: formatNumber(result.totalRows) },
    { label: 'Обновлено', value: formatNumber(result.updatedCount) },
    { label: 'Пропущено', value: formatNumber(result.skippedCount) },
  ];

  elements.resultSummary.innerHTML = summaryItems
    .map((item) => `
      <article class="upload-result-card">
        <div class="upload-result-label">${escapeHtml(item.label)}</div>
        <div class="upload-result-value">${escapeHtml(item.value)}</div>
      </article>
    `)
    .join('');

  const rows = Array.isArray(result.results) ? result.results : [];
  if (!rows.length) {
    elements.resultBody.innerHTML = `
      <tr>
        <td colspan="4">
          <div class="empty-state">В файле не найдено строк для обработки.</div>
        </td>
      </tr>
    `;
    return;
  }

  elements.resultBody.innerHTML = rows
    .map((row) => {
      const isUpdated = row.status === 'updated';
      return `
        <tr>
          <td>${escapeHtml(row.fullName || '—')}</td>
          <td>${escapeHtml(formatPercent(row.percent))}</td>
          <td>
            <span class="status-pill ${isUpdated ? 'status-done' : 'status-failed'}">
              ${isUpdated ? 'Обновлено' : 'Пропущено'}
            </span>
          </td>
          <td>${escapeHtml(row.message || '')}</td>
        </tr>
      `;
    })
    .join('');
}

function openPeriodDialog(uploadTypeKey) {
  const uploadType = UPLOAD_TYPES[uploadTypeKey];
  if (!uploadType || !elements.periodDialog) {
    return;
  }

  state.pendingUploadTypeKey = uploadTypeKey;
  elements.periodDialogTitle.textContent = `Выберите месяц для загрузки "${uploadType.label}"`;
  elements.periodDialogSelect.innerHTML = buildPeriodOptions(state.selectedPeriod);
  elements.periodDialogSelect.value = state.selectedPeriod || '';
  setUploadStatus(elements.periodDialogStatus, '');

  if (typeof elements.periodDialog.showModal === 'function') {
    elements.periodDialog.showModal();
  } else {
    elements.periodDialog.setAttribute('open', 'open');
  }
}

function closePeriodDialog() {
  state.pendingUploadTypeKey = '';
  setUploadStatus(elements.periodDialogStatus, '');

  if (!elements.periodDialog || !elements.periodDialog.hasAttribute('open')) {
    return;
  }

  if (typeof elements.periodDialog.close === 'function') {
    elements.periodDialog.close();
  } else {
    elements.periodDialog.removeAttribute('open');
  }
}

async function loadPeriods() {
  setPageStatus('Загрузка периодов...');
  const storedPeriodCode = getStoredPeriodCode();
  const dashboard = await requestJson(`/api/dashboard?period=${encodeURIComponent(storedPeriodCode)}`);
  state.periods = Array.isArray(dashboard.periods) ? dashboard.periods : [];
  state.selectedPeriod = dashboard.selectedPeriod || '';
  storeSelectedPeriodCode(state.selectedPeriod);
  renderSelectedPeriodHint();
  setPageStatus('Файлы можно загружать. Месяц подтверждается перед каждой загрузкой.');
}

async function submitUpload(uploadTypeKey, periodCode) {
  const uploadType = UPLOAD_TYPES[uploadTypeKey];
  const file = uploadType.fileInput.files?.[0];
  if (!file) {
    setUploadStatus(uploadType.statusNode, uploadType.emptyFileMessage, 'is-error');
    return;
  }

  try {
    setUploadStatus(uploadType.statusNode, uploadType.progressMessage);
    uploadType.submitButton.disabled = true;

    const fileContentBase64 = await readFileAsBase64(file);
    const result = await sendJson(uploadType.endpoint, 'POST', {
      periodCode,
      fileName: file.name,
      fileContentBase64,
    });

    renderUploadResults(result);
    setUploadStatus(uploadType.statusNode, uploadType.successMessage(result), 'is-success');
    uploadType.form.reset();
  } catch (error) {
    setUploadStatus(uploadType.statusNode, error.message, 'is-error');
  } finally {
    uploadType.submitButton.disabled = false;
  }
}

function handleUploadRequest(uploadTypeKey, event) {
  event.preventDefault();

  const uploadType = UPLOAD_TYPES[uploadTypeKey];
  const file = uploadType.fileInput.files?.[0];
  if (!file) {
    setUploadStatus(uploadType.statusNode, uploadType.emptyFileMessage, 'is-error');
    return;
  }

  if (!state.periods.length) {
    setUploadStatus(uploadType.statusNode, 'В системе не найдено ни одного KPI-периода.', 'is-error');
    return;
  }

  openPeriodDialog(uploadTypeKey);
}

function attachEvents() {
  elements.executionForm.addEventListener('submit', (event) => {
    handleUploadRequest('executionDiscipline', event);
  });

  elements.contractForm.addEventListener('submit', (event) => {
    handleUploadRequest('contractApprovals', event);
  });

  elements.projectManagerExportForm.addEventListener('submit', (event) => {
    handleUploadRequest('projectManagerExport', event);
  });

  elements.periodDialogForm?.addEventListener('submit', (event) => {
    event.preventDefault();

    const uploadTypeKey = state.pendingUploadTypeKey;
    const selectedPeriodCode = String(elements.periodDialogSelect?.value || '').trim();
    if (!uploadTypeKey) {
      setUploadStatus(elements.periodDialogStatus, 'Не выбран тип загрузки.', 'is-error');
      return;
    }

    if (!selectedPeriodCode) {
      setUploadStatus(elements.periodDialogStatus, 'Выберите месяц для загрузки.', 'is-error');
      return;
    }

    state.selectedPeriod = selectedPeriodCode;
    storeSelectedPeriodCode(state.selectedPeriod);
    renderSelectedPeriodHint();

    closePeriodDialog();
    submitUpload(uploadTypeKey, selectedPeriodCode).catch((error) => {
      const uploadType = UPLOAD_TYPES[uploadTypeKey];
      setUploadStatus(uploadType.statusNode, error.message, 'is-error');
      uploadType.submitButton.disabled = false;
    });
  });

  elements.periodDialogCancelButton?.addEventListener('click', () => {
    closePeriodDialog();
  });

  elements.periodDialogCloseButton?.addEventListener('click', () => {
    closePeriodDialog();
  });

  elements.periodDialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    closePeriodDialog();
  });
}

async function boot() {
  try {
    attachEvents();
    await loadPeriods();
  } catch (error) {
    console.error(error);
    setPageStatus(`Ошибка: ${error.message}`);
    setUploadStatus(elements.executionStatus, error.message, 'is-error');
    setUploadStatus(elements.contractStatus, error.message, 'is-error');
    setUploadStatus(elements.projectManagerExportStatus, error.message, 'is-error');
  }
}

boot();
