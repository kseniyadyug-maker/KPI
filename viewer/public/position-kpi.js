const state = {
  positions: [],
  selectedPosition: '',
  selectedGroupCode: '',
  groups: [],
};

const elements = {
  positionSelect: document.getElementById('position-kpi-position'),
  status: document.getElementById('position-kpi-status'),
  createForm: document.getElementById('position-kpi-create-form'),
  createGroup: document.getElementById('position-kpi-group'),
  createMetric: document.getElementById('position-kpi-metric'),
  createUnit: document.getElementById('position-kpi-unit'),
  createTarget: document.getElementById('position-kpi-target'),
  createWeight: document.getElementById('position-kpi-weight'),
  createSort: document.getElementById('position-kpi-sort'),
  createStatus: document.getElementById('position-kpi-create-status'),
  groups: document.getElementById('position-kpi-groups'),
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function roundPercentValue(value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) {
    return '';
  }

  return String(Math.round(Number(value)));
}

function formatNumericValue(value) {
  if (value === null || value === undefined || value === '' || Number.isNaN(Number(value))) {
    return '';
  }

  return Number(value).toFixed(3).replace(/\.?0+$/, '');
}

function formatWeightValue(value) {
  return roundPercentValue(value);
}

function formatTargetValue(value, inputType = '') {
  if (inputType === 'score') {
    return formatNumericValue(value);
  }

  return roundPercentValue(value);
}

function getUnitLabel(inputType) {
  if (inputType === 'score') {
    return 'Баллы 0-5';
  }
  if (inputType === 'pct') {
    return 'Процент';
  }
  return 'Дисциплина %';
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
    body: payload ? JSON.stringify(payload) : undefined,
  });

  if (!response.ok) {
    const payloadBody = await response.json().catch(() => ({}));
    throw new Error(payloadBody.error || `HTTP ${response.status}`);
  }

  return response.json();
}

function renderPositionOptions() {
  if (!state.positions.length) {
    elements.positionSelect.innerHTML = '<option value="">Нет должностей в справочнике сотрудников</option>';
    return;
  }

  elements.positionSelect.innerHTML = state.positions
    .map(
      (position) => `
        <option value="${escapeHtml(position)}" ${position === state.selectedPosition ? 'selected' : ''}>
          ${escapeHtml(position)}
        </option>
      `
    )
    .join('');
}

function renderGroupOptions() {
  if (!state.groups.length) {
    elements.createGroup.innerHTML = '<option value="">Нет блоков</option>';
    return;
  }

  if (!state.groups.some((group) => group.groupCode === state.selectedGroupCode)) {
    state.selectedGroupCode = state.groups[0].groupCode;
  }

  elements.createGroup.innerHTML = state.groups
    .map(
      (group) => `
        <option value="${escapeHtml(group.groupCode)}" ${group.groupCode === state.selectedGroupCode ? 'selected' : ''}>
          ${escapeHtml(group.groupName)}
        </option>
      `
    )
    .join('');
}

function getSelectedGroup() {
  return state.groups.find((group) => group.groupCode === state.selectedGroupCode) || null;
}

function getAvailableMetrics(group) {
  if (!group) {
    return [];
  }

  const assignedMetricIds = new Set(group.assignments.map((assignment) => assignment.metricId));
  return group.catalogMetrics.filter((metric) => !assignedMetricIds.has(metric.metricId));
}

function syncCreateTargetConstraints(metric) {
  const isScoreMetric = metric?.inputType === 'score';
  elements.createTarget.step = isScoreMetric ? '0.001' : '1';
  elements.createTarget.min = isScoreMetric ? '0.001' : '0';
  elements.createWeight.step = '1';
}

function syncCreateMetricFields() {
  const group = getSelectedGroup();
  const availableMetrics = getAvailableMetrics(group);

  if (!availableMetrics.length) {
    elements.createMetric.innerHTML = '<option value="">Все показатели блока уже добавлены</option>';
    elements.createUnit.value = '';
    elements.createTarget.value = '';
    return;
  }

  elements.createMetric.innerHTML = availableMetrics
    .map(
      (metric) => `
        <option value="${metric.metricId}">
          ${escapeHtml(metric.metricName)}
        </option>
      `
    )
    .join('');

  const selectedMetric = availableMetrics.find((metric) => metric.metricId === Number(elements.createMetric.value)) || availableMetrics[0];
  elements.createMetric.value = String(selectedMetric.metricId);
  elements.createUnit.value = selectedMetric.unitLabel;
  syncCreateTargetConstraints(selectedMetric);
  elements.createTarget.value = formatTargetValue(selectedMetric.defaultTargetValue, selectedMetric.inputType);
}

function renderGroups() {
  if (!state.selectedPosition) {
    elements.groups.innerHTML = `
      <div class="empty-state">
        Добавьте сотрудников с должностями в справочник, чтобы собрать карточки KPI по ролям.
      </div>
    `;
    return;
  }

  elements.groups.innerHTML = `
    <section class="panel position-profile-shell">
      <div class="panel-head">
        <div>
          <p class="panel-kicker">Профиль должности</p>
          <h2>${escapeHtml(state.selectedPosition)}</h2>
        </div>
      </div>

      <div class="position-profile-blocks">
        ${state.groups
          .map((group) => `
            <section class="position-profile-block">
              <div class="panel-head position-profile-block-head">
                <div>
                  <p class="panel-kicker">${escapeHtml(group.groupCode)}</p>
                  <h3 class="position-profile-block-title">${escapeHtml(group.groupName)}</h3>
                </div>
                <div class="metrics-pills">
                  <div class="metric-pill">Контрольная сумма: ${escapeHtml(formatWeightValue(group.totalWeightPercent))}%</div>
                  <div class="metric-pill">Макс. ${escapeHtml(formatWeightValue(group.maxPercent))}%</div>
                  <div class="warning-pill ${group.isWeightBalanced ? 'is-ok' : 'is-warning'}">
                    ${group.isWeightBalanced ? 'Сумма 100%' : 'Нужно довести до 100%'}
                  </div>
                </div>
              </div>

              <div class="table-wrap">
                <table class="employees-table metric-config-table">
                  <thead>
                    <tr>
                      <th>Показатель</th>
                      <th>Ед. изм.</th>
                      <th>Норма</th>
                      <th>Вес, %</th>
                      <th>Порядок</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${group.assignments.length
                      ? group.assignments
                          .map((assignment) => `
                            <tr>
                              <td>
                                <div class="metric-name-static">${escapeHtml(assignment.metricName)}</div>
                              </td>
                              <td>
                                <div class="readonly-cell">${escapeHtml(assignment.unitLabel)}</div>
                              </td>
                              <td>
                                <input
                                  class="control metric-row-control"
                                  type="number"
                                  min="0.001"
                                  step="${assignment.inputType === 'score' ? '0.001' : '1'}"
                                  data-field="targetValue"
                                  data-assignment-id="${assignment.assignmentId}"
                                  value="${escapeHtml(formatTargetValue(assignment.targetValue, assignment.inputType))}"
                                >
                              </td>
                              <td>
                                <input
                                  class="control metric-row-control"
                                  type="number"
                                  min="0"
                                  max="100"
                                  step="1"
                                  data-field="weightPercent"
                                  data-assignment-id="${assignment.assignmentId}"
                                  value="${escapeHtml(formatWeightValue(assignment.weightPercent))}"
                                >
                              </td>
                              <td>
                                <input
                                  class="control metric-row-control"
                                  type="number"
                                  min="1"
                                  step="1"
                                  data-field="sortOrder"
                                  data-assignment-id="${assignment.assignmentId}"
                                  value="${escapeHtml(String(assignment.sortOrder))}"
                                >
                              </td>
                              <td>
                                <div class="table-actions">
                                  <button class="action-button" type="button" data-action="save" data-assignment-id="${assignment.assignmentId}">Сохранить</button>
                                  <button class="action-button danger" type="button" data-action="delete" data-assignment-id="${assignment.assignmentId}">Удалить</button>
                                </div>
                                <div class="row-message" id="assignment-message-${assignment.assignmentId}"></div>
                              </td>
                            </tr>
                          `)
                          .join('')
                      : `
                        <tr>
                          <td colspan="6">
                            <div class="empty-state">Для этой должности в блоке пока нет показателей.</div>
                          </td>
                        </tr>
                      `}
                  </tbody>
                </table>
              </div>
            </section>
          `)
          .join('')}
      </div>
    </section>
  `;

  elements.groups.querySelectorAll('[data-action="save"]').forEach((button) => {
    button.addEventListener('click', () => {
      saveAssignment(Number(button.getAttribute('data-assignment-id'))).catch(showError);
    });
  });

  elements.groups.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeAssignment(Number(button.getAttribute('data-assignment-id'))).catch(showError);
    });
  });
}

function getAssignmentValues(assignmentId) {
  const inputs = [...elements.groups.querySelectorAll(`[data-assignment-id="${assignmentId}"][data-field]`)];
  const values = {};
  for (const input of inputs) {
    values[input.getAttribute('data-field')] = input.value;
  }
  return values;
}

function setAssignmentMessage(assignmentId, message, kind = '') {
  const node = document.getElementById(`assignment-message-${assignmentId}`);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.className = `row-message ${kind}`.trim();
}

async function loadPositionKpi(positionTitle = '') {
  const payload = await requestJson(`/api/position-kpi?position=${encodeURIComponent(positionTitle)}`);
  state.positions = payload.positions;
  state.selectedPosition = payload.selectedPosition;
  state.groups = payload.groups;

  renderPositionOptions();
  renderGroupOptions();
  syncCreateMetricFields();
  renderGroups();

  elements.status.textContent = state.selectedPosition
    ? `Карточка должности: ${state.selectedPosition}`
    : 'Нет доступных должностей в справочнике сотрудников.';
  elements.status.className = 'form-status';
}

async function saveAssignment(assignmentId) {
  setAssignmentMessage(assignmentId, 'Сохранение...');

  try {
    const values = getAssignmentValues(assignmentId);
    await sendJson(`/api/position-kpi/assignments/${assignmentId}`, 'PATCH', values);
    setAssignmentMessage(assignmentId, 'Сохранено.', 'is-success');
    await loadPositionKpi(state.selectedPosition);
  } catch (error) {
    setAssignmentMessage(assignmentId, error.message, 'is-error');
    throw error;
  }
}

async function removeAssignment(assignmentId) {
  if (!window.confirm('Удалить показатель из карточки должности?')) {
    return;
  }

  setAssignmentMessage(assignmentId, 'Удаление...');

  try {
    await sendJson(`/api/position-kpi/assignments/${assignmentId}`, 'DELETE');
    await loadPositionKpi(state.selectedPosition);
  } catch (error) {
    setAssignmentMessage(assignmentId, error.message, 'is-error');
    throw error;
  }
}

function showError(error) {
  console.error(error);
  elements.createStatus.textContent = error.message;
  elements.createStatus.className = 'form-status is-error';
}

function attachEvents() {
  elements.positionSelect.addEventListener('change', () => {
    loadPositionKpi(elements.positionSelect.value).catch(showError);
  });

  elements.createGroup.addEventListener('change', () => {
    state.selectedGroupCode = elements.createGroup.value;
    syncCreateMetricFields();
  });

  elements.createMetric.addEventListener('change', syncCreateMetricFields);

  elements.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.createStatus.textContent = 'Сохранение...';
    elements.createStatus.className = 'form-status';

    try {
      await sendJson('/api/position-kpi/assignments', 'POST', {
        positionTitle: state.selectedPosition,
        metricId: elements.createMetric.value,
        targetValue: elements.createTarget.value,
        weightPercent: elements.createWeight.value,
        sortOrder: elements.createSort.value,
      });

      elements.createForm.reset();
      elements.createWeight.value = '10';
      elements.createStatus.textContent = 'Показатель добавлен в карточку должности.';
      elements.createStatus.className = 'form-status is-success';
      await loadPositionKpi(state.selectedPosition);
    } catch (error) {
      elements.createStatus.textContent = error.message;
      elements.createStatus.className = 'form-status is-error';
    }
  });
}

async function boot() {
  try {
    attachEvents();
    await loadPositionKpi('');
  } catch (error) {
    showError(error);
  }
}

boot();
