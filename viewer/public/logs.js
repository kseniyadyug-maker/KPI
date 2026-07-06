const state = {
  logs: [],
  search: '',
  limit: '200',
};

const elements = {
  status: document.getElementById('logs-status'),
  limitSelect: document.getElementById('logs-limit-select'),
  refreshButton: document.getElementById('logs-refresh-button'),
  searchInput: document.getElementById('logs-search-input'),
  tableBody: document.getElementById('logs-table-body'),
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
    timeStyle: 'medium',
  }).format(date);
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

function filteredLogs() {
  const query = state.search.trim().toLowerCase();
  return state.logs.filter((log) => {
    if (!query) {
      return true;
    }

    const actorText = `${log.actorLogin || ''} ${log.actorDisplayName || ''} ${log.actorRoleLabel || ''}`;
    const detailText = log.details ? JSON.stringify(log.details) : '';
    return `${actorText} ${log.actionType} ${log.entityType} ${log.entityId || ''} ${log.message} ${detailText}`
      .toLowerCase()
      .includes(query);
  });
}

function renderStatus(note = '') {
  const filteredCount = filteredLogs().length;
  const countLabel = filteredCount === state.logs.length ? `${filteredCount}` : `${filteredCount} из ${state.logs.length}`;
  elements.status.textContent = note ? `Записей: ${countLabel} · ${note}` : `Записей: ${countLabel}`;
}

function renderTable() {
  const rows = filteredLogs();
  if (!rows.length) {
    elements.tableBody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">Логи не найдены.</div>
        </td>
      </tr>
    `;
    return;
  }

  elements.tableBody.innerHTML = rows.map((log) => {
    const detailsText = log.details ? JSON.stringify(log.details, null, 2) : '—';
    const actorLabel = [log.actorDisplayName || '', log.actorLogin ? `(${log.actorLogin})` : ''].filter(Boolean).join(' ');
    return `
      <tr>
        <td>${escapeHtml(formatDateTime(log.createdAt))}</td>
        <td>
          <div class="employee-name">${escapeHtml(actorLabel || 'Система')}</div>
          <div class="employee-pos">${escapeHtml(log.actorRoleLabel || '')}</div>
        </td>
        <td>${escapeHtml(log.actionType)}</td>
        <td>
          <div>${escapeHtml(log.entityType)}</div>
          <div class="employee-pos">${escapeHtml(log.entityId || '—')}</div>
        </td>
        <td>${escapeHtml(log.message)}</td>
        <td><pre class="logs-details">${escapeHtml(detailsText)}</pre></td>
      </tr>
    `;
  }).join('');
}

async function loadLogs() {
  elements.status.textContent = 'Загрузка журнала...';
  const payload = await requestJson(`/api/logs?limit=${encodeURIComponent(state.limit)}`);
  state.logs = Array.isArray(payload.logs) ? payload.logs : [];
  renderTable();
  renderStatus();
}

function showError(error) {
  console.error(error);
  renderStatus(`ошибка: ${error.message}`);
}

function attachEvents() {
  elements.limitSelect.addEventListener('change', () => {
    state.limit = elements.limitSelect.value;
    loadLogs().catch(showError);
  });

  elements.refreshButton.addEventListener('click', () => {
    loadLogs().catch(showError);
  });

  elements.searchInput.addEventListener('input', () => {
    state.search = elements.searchInput.value;
    renderTable();
    renderStatus();
  });
}

async function boot() {
  try {
    attachEvents();
    await loadLogs();
  } catch (error) {
    showError(error);
  }
}

boot();
