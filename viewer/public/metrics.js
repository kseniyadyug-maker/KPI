const state = {
  groups: [],
};

const elements = {
  groups: document.getElementById('metrics-groups'),
  createForm: document.getElementById('metric-create-form'),
  createGroup: document.getElementById('metric-create-group'),
  createName: document.getElementById('metric-create-name'),
  createType: document.getElementById('metric-create-type'),
  createWeight: document.getElementById('metric-create-weight'),
  createNorm: document.getElementById('metric-create-norm'),
  createSort: document.getElementById('metric-create-sort'),
  createStatus: document.getElementById('metric-create-status'),
};

const metricTypeLabels = {
  score: 'Баллы 0-5',
  pct: 'Процент',
  disc: 'Дисциплина %',
};

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function typeOptions(selectedType) {
  return Object.entries(metricTypeLabels)
    .map(([value, label]) => `<option value="${value}" ${value === selectedType ? 'selected' : ''}>${escapeHtml(label)}</option>`)
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

function syncCreateNormPlaceholder() {
  const defaults = {
    score: '0-5 б.',
    pct: '0-100%',
    disc: '0-100%',
  };

  elements.createNorm.placeholder = defaults[elements.createType.value] || 'Введите норму';
}

function renderCreateGroupOptions() {
  elements.createGroup.innerHTML = state.groups
    .map(
      (group) => `
        <option value="${escapeHtml(group.groupCode)}">
          ${escapeHtml(group.groupName)}
        </option>
      `
    )
    .join('');
}

function renderGroups() {
  if (!state.groups.length) {
    elements.groups.innerHTML = '<div class="empty-state">Показатели не найдены.</div>';
    return;
  }

  elements.groups.innerHTML = state.groups
    .map((group) => {
      return `
      <section class="panel metrics-panel">
        <div class="panel-head">
          <div>
            <p class="panel-kicker">${escapeHtml(group.groupCode)}</p>
            <h2>${escapeHtml(group.groupName)}</h2>
          </div>
          <div class="metrics-panel-actions">
            <button class="primary-button" type="button" data-action="save-group" data-group-code="${escapeHtml(group.groupCode)}">Сохранить</button>
            <div class="form-status metrics-panel-status" id="block-message-${escapeHtml(group.groupCode)}"></div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="employees-table metric-config-table">
            <thead>
              <tr>
                <th>Показатель</th>
                <th>Тип</th>
                <th>Норма</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              ${group.metrics.length
                ? group.metrics
                    .map((metric) => `
                      <tr>
                        <td>
                          <div class="metric-name-static">${escapeHtml(metric.name)}</div>
                        </td>
                        <td>
                          <select class="control control-select metric-row-control" data-field="inputType" data-metric-id="${metric.metricId}">
                            ${typeOptions(metric.inputType)}
                          </select>
                        </td>
                        <td>
                          <input class="control metric-row-control metric-row-input" type="text" data-field="normText" data-metric-id="${metric.metricId}" value="${escapeHtml(metric.normText || '')}">
                        </td>
                        <td>
                          <div class="table-actions">
                            <button class="action-button danger" type="button" data-action="delete" data-metric-id="${metric.metricId}">Удалить</button>
                          </div>
                          <div class="row-message" id="metric-message-${metric.metricId}"></div>
                        </td>
                      </tr>
                    `)
                    .join('')
                : `
                  <tr>
                    <td colspan="4">
                      <div class="empty-state">В этом блоке пока нет показателей.</div>
                    </td>
                  </tr>
                `}
            </tbody>
          </table>
        </div>
      </section>
    `;
    })
    .join('');

  elements.groups.querySelectorAll('[data-action="save-group"]').forEach((button) => {
    button.addEventListener('click', () => {
      saveGroup(button.getAttribute('data-group-code')).catch(() => {});
    });
  });

  elements.groups.querySelectorAll('[data-action="delete"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeMetric(Number(button.getAttribute('data-metric-id'))).catch(showError);
    });
  });
}

function getMetricRowValues(metricId) {
  const inputs = [...elements.groups.querySelectorAll(`[data-metric-id="${metricId}"][data-field]`)];
  const values = {};
  for (const input of inputs) {
    values[input.getAttribute('data-field')] = input.value;
  }
  return values;
}

function setMetricMessage(metricId, message, kind = '') {
  const node = document.getElementById(`metric-message-${metricId}`);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.className = `row-message ${kind}`.trim();
}

function setGroupMessage(groupCode, message, kind = '') {
  const node = document.getElementById(`block-message-${groupCode}`);
  if (!node) {
    return;
  }
  node.textContent = message;
  node.className = `form-status metrics-panel-status ${kind}`.trim();
}

function setGroupSavingState(groupCode, isSaving) {
  const button = elements.groups.querySelector(`[data-action="save-group"][data-group-code="${groupCode}"]`);
  if (!button) {
    return;
  }
  button.disabled = isSaving;
  button.textContent = isSaving ? 'Сохранение...' : 'Сохранить';
}

async function loadMetrics() {
  const payload = await requestJson('/api/metrics');
  state.groups = payload.groups;
  renderCreateGroupOptions();
  renderGroups();
}

async function saveGroup(groupCode) {
  const group = state.groups.find((item) => item.groupCode === groupCode);
  if (!group || !group.metrics.length) {
    return;
  }

  setGroupSavingState(groupCode, true);
  setGroupMessage(groupCode, 'Сохранение...');

  try {
    for (const metric of group.metrics) {
      const values = getMetricRowValues(metric.metricId);

      try {
        await sendJson(`/api/metrics/${metric.metricId}`, 'PATCH', values);
      } catch (error) {
        throw new Error(`${metric.name}: ${error.message}`);
      }
    }

    await loadMetrics();
    setGroupMessage(groupCode, 'Сохранено.', 'is-success');
  } catch (error) {
    setGroupMessage(groupCode, error.message, 'is-error');
    throw error;
  } finally {
    setGroupSavingState(groupCode, false);
  }
}

async function removeMetric(metricId) {
  if (!window.confirm('Удалить показатель? Его значения по сотрудникам тоже будут удалены.')) {
    return;
  }

  setMetricMessage(metricId, 'Удаление...');

  try {
    await sendJson(`/api/metrics/${metricId}`, 'DELETE');
    await loadMetrics();
  } catch (error) {
    setMetricMessage(metricId, error.message, 'is-error');
    throw error;
  }
}

function showError(error) {
  console.error(error);
  elements.createStatus.textContent = error.message;
  elements.createStatus.className = 'form-status is-error';
}

function attachEvents() {
  elements.createType.addEventListener('change', syncCreateNormPlaceholder);

  elements.createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    elements.createStatus.textContent = 'Сохранение...';
    elements.createStatus.className = 'form-status';

    try {
      await sendJson('/api/metrics', 'POST', {
        groupCode: elements.createGroup.value,
        name: elements.createName.value,
        inputType: elements.createType.value,
        weightPercent: elements.createWeight.value,
        normText: elements.createNorm.value,
        sortOrder: elements.createSort.value,
      });

      elements.createForm.reset();
      syncCreateNormPlaceholder();
      renderCreateGroupOptions();
      elements.createStatus.textContent = 'Показатель добавлен.';
      elements.createStatus.className = 'form-status is-success';
      await loadMetrics();
    } catch (error) {
      elements.createStatus.textContent = error.message;
      elements.createStatus.className = 'form-status is-error';
    }
  });
}

async function boot() {
  try {
    attachEvents();
    syncCreateNormPlaceholder();
    await loadMetrics();
  } catch (error) {
    showError(error);
  }
}

boot();
