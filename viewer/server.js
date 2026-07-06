const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} = require('node:crypto');
const { URL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const {
  parseExecutionDisciplineUpload,
  parseContractApprovalsUpload,
  parseProjectManagerExport,
} = require('../database/xlsx_upload_parser');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DB_PATH = path.join(ROOT_DIR, '..', 'database', 'kpi.sqlite');
const SESSION_COOKIE_NAME = 'kpi_crm_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_LOGIN = process.env.CRM_ADMIN_LOGIN || 'admin';
const DEFAULT_AUTH_PASSWORD = process.env.CRM_ADMIN_PASSWORD || 'Admin123!';
const DEFAULT_AUTH_DISPLAY_NAME = process.env.CRM_ADMIN_NAME || 'Администратор системы';
const LOGIN_ERROR_MESSAGE = 'Не удалось выполнить вход. Проверьте введенные данные.';
const LOGIN_LOCKED_MESSAGE = 'Слишком много неудачных попыток входа. Обратитесь к администратору системы.';
const ACCESS_DENIED_MESSAGE = 'Доступ ограничен.';
const ROLE_CODES = Object.freeze({
  ADMIN: 'admin',
  BOSS: 'boss',
  MANAGER: 'manager',
});
const ROLE_LABELS = Object.freeze({
  [ROLE_CODES.ADMIN]: 'Администратор',
  [ROLE_CODES.BOSS]: 'Boss',
  [ROLE_CODES.MANAGER]: 'Руководитель',
});
const DEFAULT_AUTH_ROLE_CODE = ROLE_CODES.ADMIN;
const DEFAULT_AUTH_SHORT_NAME = process.env.CRM_ADMIN_SHORT_NAME || 'Администратор';
const PROTECTED_PAGE_PATHS = new Set([
  '/index.html',
  '/staff.html',
  '/objects.html',
  '/upload.html',
  '/metrics.html',
  '/position-kpi.html',
  '/users.html',
  '/logs.html',
]);
const DEFAULT_EMPLOYEE_OBJECT_NAME = '—';
const CONTRACT_APPROVAL_METRIC_NAMES = Object.freeze([
  'Исполнение сроков согласования договоров',
  'Соблюдение сроков заключения договоров',
]);
const PROJECT_MANAGER_POSITION_TITLE = 'Руководитель проекта';
const PROJECT_MANAGER_EXPORT_METRIC_NAMES = Object.freeze({
  cashIn: 'Исполнение Плана поступления ДС',
  cashOut: 'Исполнение Плана расходования ДС',
  work: 'Исполнение Плана выполнения СМР, руб.',
});
const PROJECT_MANAGER_EXPORT_TYPE_CODES = Object.freeze({
  cashInPlan: 'IN_P',
  cashInFact: 'IN_F',
  cashOutPlan: 'OUT_P',
  cashOutFact: 'OUT_F',
  workPlan: 'WORK_P',
  workFact: 'WORK_F',
});
const PROJECT_MANAGER_IMPORT_METRIC_ORDER = Object.freeze(['cashIn', 'cashOut', 'work']);
const PERIOD_MONTH_LABELS = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

if (!fs.existsSync(DB_PATH)) {
  throw new Error(`SQLite database not found: ${DB_PATH}`);
}

const db = new DatabaseSync(DB_PATH, { open: true });
const sessions = new Map();
const loginAttempts = new Map();

function tableHasColumn(tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function buildPeriodCode(yearNum, monthNum) {
  return `${yearNum}-${String(monthNum).padStart(2, '0')}`;
}

function buildPeriodLabel(yearNum, monthNum) {
  return `${PERIOD_MONTH_LABELS[monthNum - 1]} ${yearNum}`;
}

function ensureCalendarPeriods() {
  const existingYears = db.prepare(`
    SELECT DISTINCT year_num
    FROM kpi_periods
    ORDER BY year_num
  `).all().map((row) => Number(row.year_num));

  const targetYears = existingYears.length ? existingYears : [new Date().getFullYear()];
  const hasAnyPeriods = existingYears.length > 0;
  const currentDate = new Date();
  const defaultOpenCode = buildPeriodCode(currentDate.getFullYear(), currentDate.getMonth() + 1);

  const insertPeriodStmt = db.prepare(`
    INSERT OR IGNORE INTO kpi_periods (code, label, year_num, month_num, status)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const yearNum of targetYears) {
    for (let monthNum = 1; monthNum <= 12; monthNum += 1) {
      const code = buildPeriodCode(yearNum, monthNum);
      const label = buildPeriodLabel(yearNum, monthNum);
      const status = !hasAnyPeriods && code === defaultOpenCode ? 'open' : 'closed';
      insertPeriodStmt.run(code, label, yearNum, monthNum, status);
    }
  }
}

function migrateCashflowPlanMetricToBlockB() {
  const metricRow = db.prepare(`
    SELECT
      m.id,
      g.code AS group_code
    FROM kpi_metrics m
    JOIN kpi_metric_groups g ON g.id = m.group_id
    WHERE m.name = 'Исполнение Плана поступления ДС'
    LIMIT 1
  `).get();

  if (!metricRow || metricRow.group_code === 'block_b') {
    return;
  }

  db.prepare(`
    UPDATE kpi_metrics
    SET group_id = (
      SELECT id
      FROM kpi_metric_groups
      WHERE code = 'block_b'
    )
    WHERE id = ?
  `).run(metricRow.id);
}

const KPI_VIEW_SQL = `
DROP VIEW IF EXISTS v_employee_kpi_totals;
DROP VIEW IF EXISTS v_kpi_metric_calculations;

CREATE VIEW v_kpi_metric_calculations AS
WITH scoped_metrics AS (
  SELECT
    r.id AS record_id,
    p.id AS period_id,
    p.code AS period_code,
    p.label AS period_label,
    e.id AS employee_id,
    e.full_name,
    COALESCE(NULLIF(TRIM(r.position_title_snapshot), ''), e.position_title) AS position_title,
    o.id AS object_id,
    o.name AS object_name,
    o.manager_name,
    COALESCE(mv.group_id_snapshot, m.group_id) AS group_id,
    COALESCE(NULLIF(TRIM(mv.group_code_snapshot), ''), g.code) AS group_code,
    COALESCE(NULLIF(TRIM(mv.group_name_snapshot), ''), g.name) AS group_name,
    COALESCE(mv.group_max_percent_snapshot, g.max_percent) AS group_max_percent,
    mv.metric_id,
    COALESCE(NULLIF(TRIM(mv.metric_code_snapshot), ''), m.code) AS metric_code,
    COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) AS metric_name,
    COALESCE(mv.metric_sort_order_snapshot, m.sort_order) AS metric_sort_order,
    COALESCE(mv.weight_snapshot, m.weight) AS weight,
    COALESCE(NULLIF(TRIM(mv.input_type_snapshot), ''), m.input_type) AS input_type,
    COALESCE(NULLIF(TRIM(mv.norm_text_snapshot), ''), m.norm_text) AS norm_text,
    COALESCE(mv.min_value_snapshot, m.min_value) AS min_value,
    COALESCE(mv.max_value_snapshot, m.max_value) AS metric_max_value,
    mv.target_value_snapshot AS target_value,
    mv.raw_value,
    mv.agreed_percent
  FROM employee_kpi_metric_values mv
  JOIN employee_kpi_records r ON r.id = mv.record_id
  JOIN kpi_periods p ON p.id = r.period_id
  JOIN employees e ON e.id = r.employee_id
  JOIN objects o ON o.id = r.object_id
  LEFT JOIN kpi_metrics m ON m.id = mv.metric_id
  LEFT JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), NULLIF(TRIM(m.name), '')) IS NOT NULL
)
SELECT
  x.record_id,
  x.period_id,
  x.period_code,
  x.period_label,
  x.employee_id,
  x.full_name,
  x.position_title,
  x.object_id,
  x.object_name,
  x.manager_name,
  x.group_id,
  x.group_code,
  x.group_name,
  x.group_max_percent,
  x.metric_id,
  x.metric_code,
  x.metric_name,
  x.metric_sort_order,
  x.weight,
  x.input_type,
  x.norm_text,
  x.min_value,
  x.metric_max_value AS max_value,
  x.raw_value,
  x.agreed_percent,
  ROUND(x.calculated_percent, 4) AS calculated_percent,
  ROUND(COALESCE(x.agreed_percent, x.calculated_percent), 4) AS effective_percent
FROM (
  SELECT
    sm.*,
    CASE
      WHEN sm.metric_name = 'Исполнение Плана расходования ДС' THEN
        (MIN(MAX(sm.raw_value, 0), 100) / 100.0) * sm.weight * sm.group_max_percent
      WHEN sm.target_value IS NOT NULL AND sm.target_value > 0 AND sm.norm_text LIKE '\u2264%' THEN
        CASE
          WHEN sm.raw_value <= 0 THEN 0
          ELSE MIN(sm.target_value / sm.raw_value, 1) * sm.weight * sm.group_max_percent
        END
      WHEN sm.target_value IS NOT NULL AND sm.target_value > 0 THEN
        MIN(
          MIN(MAX(sm.raw_value, 0), sm.metric_max_value) / sm.target_value,
          1
        ) * sm.weight * sm.group_max_percent
      WHEN sm.input_type = 'score' AND sm.group_code = 'block_a' THEN
        CASE
          WHEN sm.raw_value >= 4 THEN sm.weight * sm.group_max_percent
          WHEN sm.raw_value = 3 THEN 0.6 * sm.weight * sm.group_max_percent
          ELSE 0
        END
      WHEN sm.input_type = 'score' THEN
        (MIN(MAX(sm.raw_value, 0), 5) / 5.0) * sm.weight * sm.group_max_percent
      WHEN sm.input_type IN ('pct', 'disc') THEN
        (MIN(MAX(sm.raw_value, 0), 100) / 100.0) * sm.weight * sm.group_max_percent
      ELSE 0
    END AS calculated_percent
  FROM scoped_metrics sm
) AS x;

CREATE VIEW v_employee_kpi_totals AS
SELECT
  r.id AS record_id,
  p.id AS period_id,
  p.code AS period_code,
  p.label AS period_label,
  e.id AS employee_id,
  e.full_name,
  COALESCE(NULLIF(TRIM(r.position_title_snapshot), ''), e.position_title) AS position_title,
  o.id AS object_id,
  o.name AS object_name,
  o.manager_name,
  r.salary_rub,
  r.agreed_total_percent,
  r.is_approved,
  r.approved_at,
  ROUND(SUM(CASE WHEN vmc.group_code = 'block_a' THEN vmc.effective_percent ELSE 0 END), 4) AS block_a_percent,
  ROUND(SUM(CASE WHEN vmc.group_code = 'block_b' THEN vmc.effective_percent ELSE 0 END), 4) AS block_b_percent,
  ROUND(SUM(vmc.calculated_percent), 4) AS calculated_total_percent,
  ROUND(COALESCE(r.agreed_total_percent, SUM(vmc.effective_percent)), 4) AS final_total_percent,
  ROUND(
    CASE
      WHEN r.salary_rub IS NOT NULL THEN r.salary_rub * (COALESCE(r.agreed_total_percent, SUM(vmc.effective_percent)) / 100.0)
      ELSE NULL
    END,
    2
  ) AS bonus_rub,
  CASE
    WHEN COALESCE(r.agreed_total_percent, SUM(vmc.effective_percent)) >= 39.5 THEN 'Выполнено'
    WHEN COALESCE(r.agreed_total_percent, SUM(vmc.effective_percent)) >= 15 THEN 'Частично'
    ELSE 'Не выполнено'
  END AS status
FROM employee_kpi_records r
JOIN kpi_periods p ON p.id = r.period_id
JOIN employees e ON e.id = r.employee_id
JOIN objects o ON o.id = r.object_id
LEFT JOIN v_kpi_metric_calculations vmc ON vmc.record_id = r.id
GROUP BY
  r.id,
  p.id,
  p.code,
  p.label,
  e.id,
  e.full_name,
  r.position_title_snapshot,
  e.position_title,
  o.id,
  o.name,
  o.manager_name,
  r.salary_rub,
  r.agreed_total_percent,
  r.is_approved,
  r.approved_at;
`;

function toOptionalNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatSnapshotTargetText(value) {
  const numericValue = toOptionalNumber(value);
  if (numericValue === null) {
    return '';
  }

  return String(Number(numericValue.toFixed(3)));
}

function formatSnapshotPercentText(value) {
  const numericValue = toOptionalNumber(value);
  if (numericValue === null) {
    return '';
  }

  return String(Math.round(numericValue));
}

function buildMetricNormText(defaultNormText, inputType, targetValue) {
  const numericTargetValue = toOptionalNumber(targetValue);
  const baseNormText = String(defaultNormText || '');

  if (numericTargetValue === null) {
    return baseNormText;
  }

  const normalizedNormText = baseNormText.toLowerCase();
  const targetText = (inputType === 'score' || normalizedNormText.includes('РґРЅ'))
    ? formatSnapshotTargetText(numericTargetValue)
    : formatSnapshotPercentText(numericTargetValue);
  if (inputType === 'score') {
    return `${targetText} б.`;
  }
  if (baseNormText.includes('\u2264') && normalizedNormText.includes('дн')) {
    return `≤ ${targetText} дн`;
  }
  if (baseNormText.includes('\u2264')) {
    return `≤ ${targetText}%`;
  }
  if (normalizedNormText.includes('дн')) {
    return `${targetText} дн`;
  }
  if (baseNormText.includes('\u2265')) {
    return `≥ ${targetText}%`;
  }
  return `${targetText}%`;
}

function buildMetricSnapshotTemplate(row) {
  return {
    metricId: Number(row.metric_id),
    groupId: toOptionalNumber(row.group_id),
    groupCode: String(row.group_code || ''),
    groupName: String(row.group_name || ''),
    groupMaxPercent: Number(row.group_max_percent || 0),
    metricCode: String(row.metric_code || ''),
    metricName: String(row.metric_name || ''),
    metricSortOrder: Number(row.metric_sort_order || 0),
    weight: Number(row.weight || 0),
    inputType: String(row.input_type || ''),
    normText: buildMetricNormText(row.default_norm_text, row.input_type, row.target_value),
    minValue: Number(row.min_value || 0),
    maxValue: Number(row.max_value || 0),
    targetValue: toOptionalNumber(row.target_value),
  };
}

function buildMetricSnapshotInsertValues(recordId, snapshot, overrides = {}) {
  const rawValueSource = overrides.rawValue !== undefined ? overrides.rawValue : snapshot.rawValue;
  const agreedPercentSource = overrides.agreedPercent !== undefined ? overrides.agreedPercent : snapshot.agreedPercent;
  const importBatchIdSource = overrides.importBatchId !== undefined ? overrides.importBatchId : snapshot.importBatchId;
  const noteSource = overrides.note !== undefined ? overrides.note : snapshot.note;

  return [
    recordId,
    Number(snapshot.metricId),
    Number(rawValueSource || 0),
    toOptionalNumber(agreedPercentSource),
    toOptionalNumber(importBatchIdSource),
    noteSource ?? null,
    toOptionalNumber(snapshot.groupId),
    snapshot.groupCode || '',
    snapshot.groupName || '',
    Number(snapshot.groupMaxPercent || 0),
    snapshot.metricCode || '',
    snapshot.metricName || '',
    Number(snapshot.metricSortOrder || 0),
    Number(snapshot.weight || 0),
    snapshot.inputType || '',
    snapshot.normText || '',
    Number(snapshot.minValue || 0),
    Number(snapshot.maxValue || 0),
    toOptionalNumber(snapshot.targetValue),
  ];
}

function mapStoredMetricSnapshotRow(row) {
  return {
    metricId: Number(row.metric_id),
    rawValue: Number(row.raw_value || 0),
    agreedPercent: toOptionalNumber(row.agreed_percent),
    importBatchId: toOptionalNumber(row.import_batch_id),
    note: row.note ?? null,
    groupId: toOptionalNumber(row.group_id),
    groupCode: String(row.group_code || ''),
    groupName: String(row.group_name || ''),
    groupMaxPercent: Number(row.group_max_percent || 0),
    metricCode: String(row.metric_code || ''),
    metricName: String(row.metric_name || ''),
    metricSortOrder: Number(row.metric_sort_order || 0),
    weight: Number(row.weight || 0),
    inputType: String(row.input_type || ''),
    normText: String(row.norm_text || ''),
    minValue: Number(row.min_value || 0),
    maxValue: Number(row.max_value || 0),
    targetValue: toOptionalNumber(row.target_value),
  };
}

function listMetricSnapshotTemplatesForPosition(positionTitle) {
  const normalizedPositionTitle = normalizeText(positionTitle);
  const hasPositionProfile = Boolean(db.prepare(`
    SELECT 1
    FROM position_kpi_metric_assignments
    WHERE position_title = ?
    LIMIT 1
  `).get(normalizedPositionTitle));

  const rows = hasPositionProfile
    ? db.prepare(`
        SELECT
          m.id AS metric_id,
          g.id AS group_id,
          g.code AS group_code,
          g.name AS group_name,
          g.max_percent AS group_max_percent,
          m.code AS metric_code,
          m.name AS metric_name,
          pma.sort_order AS metric_sort_order,
          pma.weight AS weight,
          m.input_type,
          m.norm_text AS default_norm_text,
          m.min_value,
          m.max_value,
          pma.target_value
        FROM position_kpi_metric_assignments pma
        JOIN kpi_metrics m ON m.id = pma.metric_id
        JOIN kpi_metric_groups g ON g.id = m.group_id
        WHERE pma.position_title = ?
          AND m.is_active = 1
        ORDER BY g.sort_order, pma.sort_order, m.name COLLATE NOCASE
      `).all(normalizedPositionTitle)
    : db.prepare(`
        SELECT
          m.id AS metric_id,
          g.id AS group_id,
          g.code AS group_code,
          g.name AS group_name,
          g.max_percent AS group_max_percent,
          m.code AS metric_code,
          m.name AS metric_name,
          m.sort_order AS metric_sort_order,
          m.weight AS weight,
          m.input_type,
          m.norm_text AS default_norm_text,
          m.min_value,
          m.max_value,
          NULL AS target_value
        FROM kpi_metrics m
        JOIN kpi_metric_groups g ON g.id = m.group_id
        WHERE m.is_active = 1
        ORDER BY g.sort_order, m.sort_order, m.name COLLATE NOCASE
      `).all();

  return rows.map(buildMetricSnapshotTemplate);
}

function backfillKpiSnapshotData() {
  const records = db.prepare(`
    SELECT
      r.id,
      COALESCE(NULLIF(TRIM(r.position_title_snapshot), ''), e.position_title, '') AS position_title
    FROM employee_kpi_records r
    JOIN employees e ON e.id = r.employee_id
    WHERE r.position_title_snapshot IS NULL
       OR TRIM(r.position_title_snapshot) = ''
       OR EXISTS (
         SELECT 1
         FROM employee_kpi_metric_values mv
         WHERE mv.record_id = r.id
           AND (
             mv.metric_name_snapshot IS NULL
             OR TRIM(mv.metric_name_snapshot) = ''
           )
       )
  `).all();

  if (!records.length) {
    return;
  }

  const selectMetricRowsByRecordStmt = db.prepare(`
    SELECT
      id,
      metric_id
    FROM employee_kpi_metric_values
    WHERE record_id = ?
    ORDER BY metric_id
  `);

  const updateRecordPositionSnapshotStmt = db.prepare(`
    UPDATE employee_kpi_records
    SET position_title_snapshot = ?
    WHERE id = ?
  `);

  const updateMetricSnapshotByIdStmt = db.prepare(`
    UPDATE employee_kpi_metric_values
    SET
      group_id_snapshot = ?,
      group_code_snapshot = ?,
      group_name_snapshot = ?,
      group_max_percent_snapshot = ?,
      metric_code_snapshot = ?,
      metric_name_snapshot = ?,
      metric_sort_order_snapshot = ?,
      weight_snapshot = ?,
      input_type_snapshot = ?,
      norm_text_snapshot = ?,
      min_value_snapshot = ?,
      max_value_snapshot = ?,
      target_value_snapshot = ?
    WHERE id = ?
  `);

  const insertMetricSnapshotStmt = db.prepare(`
    INSERT INTO employee_kpi_metric_values (
      record_id,
      metric_id,
      raw_value,
      agreed_percent,
      import_batch_id,
      note,
      group_id_snapshot,
      group_code_snapshot,
      group_name_snapshot,
      group_max_percent_snapshot,
      metric_code_snapshot,
      metric_name_snapshot,
      metric_sort_order_snapshot,
      weight_snapshot,
      input_type_snapshot,
      norm_text_snapshot,
      min_value_snapshot,
      max_value_snapshot,
      target_value_snapshot
    )
    VALUES (?, ?, 0, NULL, NULL, 'Backfilled metric snapshot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const deleteMetricValueByIdStmt = db.prepare(`
    DELETE FROM employee_kpi_metric_values
    WHERE id = ?
  `);

  const templateCache = new Map();

  for (const record of records) {
    const positionTitle = String(record.position_title || '');
    updateRecordPositionSnapshotStmt.run(positionTitle, record.id);

    const templateCacheKey = normalizeText(positionTitle);
    let templates = templateCache.get(templateCacheKey);
    if (!templates) {
      templates = listMetricSnapshotTemplatesForPosition(positionTitle);
      templateCache.set(templateCacheKey, templates);
    }

    const templatesByMetricId = new Map(templates.map((template) => [template.metricId, template]));
    const existingRows = selectMetricRowsByRecordStmt.all(record.id);
    const existingMetricIds = new Set();

    for (const existingRow of existingRows) {
      const metricId = Number(existingRow.metric_id);
      const template = templatesByMetricId.get(metricId);
      if (!template) {
        deleteMetricValueByIdStmt.run(existingRow.id);
        continue;
      }

      existingMetricIds.add(metricId);
      updateMetricSnapshotByIdStmt.run(
        template.groupId,
        template.groupCode,
        template.groupName,
        template.groupMaxPercent,
        template.metricCode,
        template.metricName,
        template.metricSortOrder,
        template.weight,
        template.inputType,
        template.normText,
        template.minValue,
        template.maxValue,
        template.targetValue,
        existingRow.id
      );
    }

    for (const template of templates) {
      if (existingMetricIds.has(template.metricId)) {
        continue;
      }

      insertMetricSnapshotStmt.run(
        record.id,
        template.metricId,
        template.groupId,
        template.groupCode,
        template.groupName,
        template.groupMaxPercent,
        template.metricCode,
        template.metricName,
        template.metricSortOrder,
        template.weight,
        template.inputType,
        template.normText,
        template.minValue,
        template.maxValue,
        template.targetValue
      );
    }
  }
}

function applySchemaMigrations() {
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_full_name_unique ON employees(full_name);

    CREATE TABLE IF NOT EXISTS position_kpi_metric_assignments (
      id INTEGER PRIMARY KEY,
      position_title TEXT NOT NULL,
      metric_id INTEGER NOT NULL REFERENCES kpi_metrics(id) ON DELETE CASCADE,
      weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
      target_value REAL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (position_title, metric_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_position_assignments_position
      ON position_kpi_metric_assignments(position_title);

    CREATE INDEX IF NOT EXISTS idx_position_assignments_metric
      ON position_kpi_metric_assignments(metric_id);

    CREATE TABLE IF NOT EXISTS project_manager_export_object_values (
      id INTEGER PRIMARY KEY,
      period_id INTEGER NOT NULL REFERENCES kpi_periods(id) ON DELETE CASCADE,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      source_object_key TEXT NOT NULL,
      source_object_name TEXT NOT NULL,
      object_id INTEGER REFERENCES objects(id) ON DELETE SET NULL,
      cash_in_plan REAL NOT NULL DEFAULT 0,
      cash_in_fact REAL NOT NULL DEFAULT 0,
      cash_in_score_ratio REAL NOT NULL DEFAULT 0,
      cash_out_plan REAL NOT NULL DEFAULT 0,
      cash_out_fact REAL NOT NULL DEFAULT 0,
      cash_out_score_ratio REAL NOT NULL DEFAULT 0,
      work_plan REAL NOT NULL DEFAULT 0,
      work_fact REAL NOT NULL DEFAULT 0,
      work_score_ratio REAL NOT NULL DEFAULT 0,
      import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (period_id, employee_id, source_object_key)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_project_manager_export_period
      ON project_manager_export_object_values(period_id);

    CREATE INDEX IF NOT EXISTS idx_project_manager_export_employee
      ON project_manager_export_object_values(employee_id);
  `);

  if (!tableHasColumn('objects', 'manager_name')) {
    db.exec(`
      ALTER TABLE objects
      ADD COLUMN manager_name TEXT;
    `);
  }

  if (!tableHasColumn('position_kpi_metric_assignments', 'target_value')) {
    db.exec(`
      ALTER TABLE position_kpi_metric_assignments
      ADD COLUMN target_value REAL;
    `);
  }

  if (!tableHasColumn('employee_kpi_records', 'created_by_user_id')) {
    db.exec(`
      ALTER TABLE employee_kpi_records
      ADD COLUMN created_by_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL;
    `);
  }

  if (!tableHasColumn('employee_kpi_records', 'updated_by_user_id')) {
    db.exec(`
      ALTER TABLE employee_kpi_records
      ADD COLUMN updated_by_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL;
    `);
  }

  if (!tableHasColumn('employee_kpi_records', 'request_status')) {
    db.exec(`
      ALTER TABLE employee_kpi_records
      ADD COLUMN request_status TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_records', 'position_title_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_records
      ADD COLUMN position_title_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'group_id_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN group_id_snapshot INTEGER;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'group_code_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN group_code_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'group_name_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN group_name_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'group_max_percent_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN group_max_percent_snapshot REAL;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'metric_code_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN metric_code_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'metric_name_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN metric_name_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'metric_sort_order_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN metric_sort_order_snapshot INTEGER;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'weight_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN weight_snapshot REAL;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'input_type_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN input_type_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'norm_text_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN norm_text_snapshot TEXT;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'min_value_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN min_value_snapshot REAL;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'max_value_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN max_value_snapshot REAL;
    `);
  }

  if (!tableHasColumn('employee_kpi_metric_values', 'target_value_snapshot')) {
    db.exec(`
      ALTER TABLE employee_kpi_metric_values
      ADD COLUMN target_value_snapshot REAL;
    `);
  }

  db.exec(`
    UPDATE employee_kpi_records
    SET request_status = CASE
      WHEN is_approved = 1 THEN 'approved'
      ELSE 'draft'
    END
    WHERE request_status IS NULL OR TRIM(request_status) = '';

    CREATE INDEX IF NOT EXISTS idx_employee_kpi_records_created_by
      ON employee_kpi_records(created_by_user_id);

    CREATE INDEX IF NOT EXISTS idx_employee_kpi_records_updated_by
      ON employee_kpi_records(updated_by_user_id);
  `);

  ensureCalendarPeriods();
  migrateCashflowPlanMetricToBlockB();
  backfillKpiSnapshotData();
  db.exec(KPI_VIEW_SQL);
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(String(password ?? ''), salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedHex] = String(storedHash ?? '').split('$');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) {
    return false;
  }

  const expected = Buffer.from(expectedHex, 'hex');
  const actual = scryptSync(String(password ?? ''), salt, expected.length);
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function ensureAuthSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      employee_short_name TEXT NOT NULL DEFAULT '',
      role_code TEXT NOT NULL DEFAULT 'admin',
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_auth_users_active
      ON auth_users(is_active);

    CREATE INDEX IF NOT EXISTS idx_auth_users_role
      ON auth_users(role_code);

    CREATE INDEX IF NOT EXISTS idx_auth_users_employee_short_name
      ON auth_users(employee_short_name);

    CREATE TABLE IF NOT EXISTS app_action_logs (
      id INTEGER PRIMARY KEY,
      actor_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
      actor_login TEXT,
      actor_display_name TEXT,
      actor_role_code TEXT,
      action_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_app_action_logs_created_at
      ON app_action_logs(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_app_action_logs_actor_user
      ON app_action_logs(actor_user_id);
  `);

  if (!tableHasColumn('auth_users', 'employee_short_name')) {
    db.exec(`
      ALTER TABLE auth_users
      ADD COLUMN employee_short_name TEXT;
    `);
  }

  if (!tableHasColumn('auth_users', 'role_code')) {
    db.exec(`
      ALTER TABLE auth_users
      ADD COLUMN role_code TEXT;
    `);
  }

  if (!tableHasColumn('objects', 'manager_user_id')) {
    db.exec(`
      ALTER TABLE objects
      ADD COLUMN manager_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL;
    `);
  }

  db.exec(`
    UPDATE auth_users
    SET role_code = COALESCE(NULLIF(TRIM(role_code), ''), '${DEFAULT_AUTH_ROLE_CODE}')
    WHERE role_code IS NULL OR TRIM(role_code) = '';

    UPDATE auth_users
    SET employee_short_name = COALESCE(NULLIF(TRIM(employee_short_name), ''), NULLIF(TRIM(display_name), ''), login)
    WHERE employee_short_name IS NULL OR TRIM(employee_short_name) = '';

    CREATE INDEX IF NOT EXISTS idx_objects_manager_user
      ON objects(manager_user_id);
  `);

  syncObjectManagerLinks();

  const existingUsersCount = Number(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM auth_users
    `).get()?.count || 0
  );

  if (existingUsersCount > 0) {
    return;
  }

  db.prepare(`
    INSERT INTO auth_users (login, display_name, employee_short_name, role_code, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    String(DEFAULT_AUTH_LOGIN).trim().toLowerCase(),
    String(DEFAULT_AUTH_DISPLAY_NAME).trim() || 'Администратор системы',
    String(DEFAULT_AUTH_SHORT_NAME).trim() || 'Администратор',
    DEFAULT_AUTH_ROLE_CODE,
    hashPassword(DEFAULT_AUTH_PASSWORD)
  );
}

applySchemaMigrations();
ensureAuthSchema();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const getPeriodsStmt = db.prepare(`
  SELECT
    code,
    label,
    year_num,
    month_num,
    status
  FROM kpi_periods
  ORDER BY year_num DESC, month_num DESC
`);

const getDefaultPeriodStmt = db.prepare(`
  SELECT code
  FROM kpi_periods
  ORDER BY
    CASE status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
    year_num DESC,
    month_num DESC
  LIMIT 1
`);

const getPeriodByCodeStmt = db.prepare(`
  SELECT id, code, label, year_num, month_num, status
  FROM kpi_periods
  WHERE code = ?
`);

const getPreviousPeriodByYearMonthStmt = db.prepare(`
  SELECT id, code, label, year_num, month_num, status
  FROM kpi_periods
  WHERE year_num < ?
     OR (year_num = ? AND month_num < ?)
  ORDER BY year_num DESC, month_num DESC
  LIMIT 1
`);

const getAuthUserByIdStmt = db.prepare(`
  SELECT
    id,
    login,
    display_name,
    employee_short_name,
    role_code,
    password_hash,
    is_active,
    last_login_at
  FROM auth_users
  WHERE id = ?
`);

const getAuthUserByLoginStmt = db.prepare(`
  SELECT
    id,
    login,
    display_name,
    employee_short_name,
    role_code,
    password_hash,
    is_active,
    last_login_at
  FROM auth_users
  WHERE login = ?
`);

const updateAuthUserLastLoginStmt = db.prepare(`
  UPDATE auth_users
  SET
    last_login_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getUsersDirectoryStmt = db.prepare(`
  SELECT
    id,
    login,
    display_name,
    employee_short_name,
    role_code,
    is_active,
    created_at,
    updated_at,
    last_login_at
  FROM auth_users
  ORDER BY
    CASE role_code
      WHEN 'admin' THEN 1
      WHEN 'boss' THEN 2
      WHEN 'manager' THEN 3
      ELSE 9
    END,
    login COLLATE NOCASE
`);

const getUserDirectoryByIdStmt = db.prepare(`
  SELECT
    id,
    login,
    display_name,
    employee_short_name,
    role_code,
    is_active,
    created_at,
    updated_at,
    last_login_at
  FROM auth_users
  WHERE id = ?
`);

const getProjectAccessUsersStmt = db.prepare(`
  SELECT
    id,
    display_name,
    employee_short_name,
    role_code,
    is_active
  FROM auth_users
  WHERE is_active = 1
    AND role_code IN ('boss', 'manager')
  ORDER BY
    CASE role_code WHEN 'boss' THEN 1 WHEN 'manager' THEN 2 ELSE 9 END,
    employee_short_name COLLATE NOCASE,
    display_name COLLATE NOCASE
`);

const getProjectAccessUserByIdStmt = db.prepare(`
  SELECT
    id,
    display_name,
    employee_short_name,
    role_code,
    is_active
  FROM auth_users
  WHERE id = ?
`);

const insertAuthUserStmt = db.prepare(`
  INSERT INTO auth_users (
    login,
    display_name,
    employee_short_name,
    role_code,
    password_hash,
    is_active
  )
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateAuthUserStmt = db.prepare(`
  UPDATE auth_users
  SET
    login = ?,
    display_name = ?,
    employee_short_name = ?,
    role_code = ?,
    is_active = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const updateAuthUserPasswordStmt = db.prepare(`
  UPDATE auth_users
  SET
    password_hash = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const deleteAuthUserStmt = db.prepare(`
  DELETE FROM auth_users
  WHERE id = ?
`);

const countActiveAdminsStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM auth_users
  WHERE role_code = 'admin'
    AND is_active = 1
    AND (? IS NULL OR id <> ?)
`);

const insertActionLogStmt = db.prepare(`
  INSERT INTO app_action_logs (
    actor_user_id,
    actor_login,
    actor_display_name,
    actor_role_code,
    action_type,
    entity_type,
    entity_id,
    message,
    details_json
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getActionLogsStmt = db.prepare(`
  SELECT
    id,
    actor_user_id,
    actor_login,
    actor_display_name,
    actor_role_code,
    action_type,
    entity_type,
    entity_id,
    message,
    details_json,
    created_at
  FROM app_action_logs
  ORDER BY created_at DESC, id DESC
  LIMIT ?
`);

const getSummaryStmt = db.prepare(`
  SELECT
    COUNT(*) AS employees_count,
    SUM(CASE WHEN status = 'Выполнено' THEN 1 ELSE 0 END) AS done_count,
    SUM(CASE WHEN status = 'Частично' THEN 1 ELSE 0 END) AS partial_count,
    SUM(CASE WHEN status = 'Не выполнено' THEN 1 ELSE 0 END) AS failed_count,
    SUM(CASE WHEN is_approved = 1 THEN 1 ELSE 0 END) AS approved_count,
    ROUND(AVG(block_a_percent), 3) AS avg_block_a_percent,
    ROUND(AVG(block_b_percent), 3) AS avg_block_b_percent,
    ROUND(AVG(final_total_percent), 3) AS avg_total_percent,
    ROUND(SUM(COALESCE(bonus_rub, 0)), 2) AS total_bonus_rub
  FROM v_employee_kpi_totals
  WHERE period_code = ?
    AND employee_id IN (SELECT id FROM employees WHERE is_active = 1)
`);

const getObjectsStmt = db.prepare(`
  SELECT
    t.object_id,
    t.object_name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    COUNT(*) AS employees_count,
    SUM(CASE WHEN is_approved = 1 THEN 1 ELSE 0 END) AS approved_count,
    ROUND(AVG(final_total_percent), 3) AS avg_total_percent
  FROM v_employee_kpi_totals t
  JOIN objects o ON o.id = t.object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE t.period_code = ?
    AND t.employee_id IN (SELECT id FROM employees WHERE is_active = 1)
  GROUP BY
    t.object_id,
    t.object_name,
    o.manager_name,
    o.manager_user_id,
    manager_user.display_name,
    manager_user.employee_short_name
  ORDER BY t.object_name COLLATE NOCASE
`);

const getEmployeesStmt = db.prepare(`
  SELECT
    t.record_id,
    t.employee_id,
    t.full_name,
    t.position_title,
    t.object_id,
    t.object_name,
    COALESCE(NULLIF(TRIM(t.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    r.created_by_user_id,
    r.created_at,
    r.updated_by_user_id,
    r.updated_at,
    r.request_status,
    t.salary_rub,
    t.block_a_percent,
    t.block_b_percent,
    t.calculated_total_percent,
    t.final_total_percent,
    t.bonus_rub,
    t.status,
    t.is_approved,
    t.approved_at
  FROM v_employee_kpi_totals t
  JOIN employee_kpi_records r ON r.id = t.record_id
  JOIN objects o ON o.id = t.object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE t.period_code = ?
    AND t.employee_id IN (SELECT id FROM employees WHERE is_active = 1)
  ORDER BY t.full_name COLLATE NOCASE
`);

const getEmployeeHeaderStmt = db.prepare(`
  SELECT
    t.record_id,
    t.period_id,
    t.period_code,
    t.period_label,
    t.employee_id,
    t.full_name,
    t.position_title,
    t.object_id,
    t.object_name,
    COALESCE(NULLIF(TRIM(t.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    r.created_by_user_id,
    COALESCE(creator.employee_short_name, creator.display_name, '') AS created_by_display_name,
    r.created_at,
    r.updated_by_user_id,
    COALESCE(editor.employee_short_name, editor.display_name, '') AS updated_by_display_name,
    r.updated_at,
    r.request_status,
    t.salary_rub,
    t.block_a_percent,
    t.block_b_percent,
    t.calculated_total_percent,
    t.final_total_percent,
    t.bonus_rub,
    t.status,
    t.agreed_total_percent,
    t.is_approved,
    t.approved_at
  FROM v_employee_kpi_totals t
  JOIN employee_kpi_records r ON r.id = t.record_id
  JOIN objects o ON o.id = t.object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  LEFT JOIN auth_users creator ON creator.id = r.created_by_user_id
  LEFT JOIN auth_users editor ON editor.id = r.updated_by_user_id
  WHERE t.employee_id = ? AND t.period_code = ?
`);

const getEmployeeMetricsStmt = db.prepare(`
  SELECT
    vmc.metric_id,
    vmc.group_code,
    vmc.group_name,
    vmc.group_max_percent,
    vmc.metric_code,
    vmc.metric_name,
    vmc.metric_sort_order,
    vmc.weight,
    vmc.input_type,
    vmc.norm_text,
    vmc.raw_value,
    vmc.agreed_percent,
    vmc.calculated_percent,
    vmc.effective_percent,
    vmc.min_value,
    vmc.max_value
  FROM v_kpi_metric_calculations vmc
  WHERE vmc.employee_id = ? AND vmc.period_code = ?
  ORDER BY
    CASE vmc.group_code WHEN 'block_a' THEN 1 WHEN 'block_b' THEN 2 ELSE 9 END,
    vmc.metric_sort_order
`);

const getEmployeeMetricValueStmt = db.prepare(`
  SELECT
    mv.record_id,
    mv.metric_id,
    mv.raw_value,
    mv.agreed_percent,
    COALESCE(NULLIF(TRIM(mv.input_type_snapshot), ''), m.input_type) AS input_type,
    COALESCE(mv.min_value_snapshot, m.min_value) AS min_value,
    COALESCE(mv.max_value_snapshot, m.max_value) AS max_value,
    COALESCE(mv.group_max_percent_snapshot, g.max_percent) AS group_max_percent,
    CASE
      WHEN mv.metric_name_snapshot IS NOT NULL AND TRIM(mv.metric_name_snapshot) <> '' THEN 1
      ELSE 0
    END AS is_active
  FROM employee_kpi_metric_values mv
  LEFT JOIN kpi_metrics m ON m.id = mv.metric_id
  LEFT JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE mv.record_id = ? AND mv.metric_id = ?
`);

const getKpiRecordAccessByIdStmt = db.prepare(`
  SELECT
    r.id,
    r.period_id,
    p.code AS period_code,
    r.employee_id,
    r.object_id,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    r.created_by_user_id,
    r.updated_by_user_id,
    COALESCE(r.request_status, 'draft') AS request_status,
    r.is_approved
  FROM employee_kpi_records r
  JOIN kpi_periods p ON p.id = r.period_id
  JOIN objects o ON o.id = r.object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE r.id = ?
`);

const getExecutionDisciplineMetricRowsStmt = db.prepare(`
  SELECT
    r.id AS record_id,
    mv.metric_id,
    e.id AS employee_id,
    e.full_name,
    COALESCE(mv.min_value_snapshot, m.min_value) AS min_value,
    COALESCE(mv.max_value_snapshot, m.max_value) AS max_value
  FROM employee_kpi_records r
  JOIN employees e ON e.id = r.employee_id
  JOIN employee_kpi_metric_values mv ON mv.record_id = r.id
  LEFT JOIN kpi_metrics m ON m.id = mv.metric_id
  WHERE r.period_id = ?
    AND LOWER(TRIM(e.full_name)) = LOWER(TRIM(?))
    AND e.is_active = 1
    AND COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) = 'Исполнительская дисциплина'
  ORDER BY mv.metric_id
`);

const getContractApprovalMetricRowsStmt = db.prepare(`
  SELECT
    r.id AS record_id,
    mv.metric_id,
    e.id AS employee_id,
    e.full_name,
    COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) AS metric_name,
    COALESCE(mv.min_value_snapshot, m.min_value) AS min_value,
    COALESCE(mv.max_value_snapshot, m.max_value) AS max_value
  FROM employee_kpi_records r
  JOIN employees e ON e.id = r.employee_id
  JOIN employee_kpi_metric_values mv ON mv.record_id = r.id
  LEFT JOIN kpi_metrics m ON m.id = mv.metric_id
  WHERE r.period_id = ?
    AND LOWER(TRIM(e.full_name)) = LOWER(TRIM(?))
    AND e.is_active = 1
    AND COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) IN ('Исполнение сроков согласования договоров', 'Соблюдение сроков заключения договоров')
  ORDER BY mv.metric_id
`);

const getProjectManagerExportMetricRowsStmt = db.prepare(`
  SELECT
    r.id AS record_id,
    mv.metric_id,
    mv.raw_value,
    mv.agreed_percent,
    COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) AS metric_name
  FROM employee_kpi_records r
  JOIN employees e ON e.id = r.employee_id
  JOIN employee_kpi_metric_values mv ON mv.record_id = r.id
  LEFT JOIN kpi_metrics m ON m.id = mv.metric_id
  WHERE r.period_id = ?
    AND e.id = ?
    AND e.is_active = 1
    AND COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) IN (
      'Исполнение Плана поступления ДС',
      'Исполнение Плана расходования ДС',
      'Исполнение Плана выполнения СМР, руб.'
    )
  ORDER BY mv.metric_id
`);

const deleteProjectManagerImportRowsByPeriodStmt = db.prepare(`
  DELETE FROM project_manager_export_object_values
  WHERE period_id = ?
`);

const insertProjectManagerImportObjectValueStmt = db.prepare(`
  INSERT INTO project_manager_export_object_values (
    period_id,
    employee_id,
    source_object_key,
    source_object_name,
    object_id,
    cash_in_plan,
    cash_in_fact,
    cash_in_score_ratio,
    cash_out_plan,
    cash_out_fact,
    cash_out_score_ratio,
    work_plan,
    work_fact,
    work_score_ratio,
    import_batch_id,
    imported_at,
    updated_at
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
`);

const getProjectManagerImportSummaryByEmployeeStmt = db.prepare(`
  SELECT
    COUNT(*) AS object_count,
    ROUND(COALESCE(SUM(cash_in_plan), 0), 4) AS cash_in_plan_total,
    ROUND(COALESCE(SUM(cash_in_fact), 0), 4) AS cash_in_fact_total,
    ROUND(COALESCE(AVG(cash_in_score_ratio), 0), 6) AS cash_in_score_ratio_avg,
    ROUND(COALESCE(SUM(cash_out_plan), 0), 4) AS cash_out_plan_total,
    ROUND(COALESCE(SUM(cash_out_fact), 0), 4) AS cash_out_fact_total,
    ROUND(COALESCE(AVG(cash_out_score_ratio), 0), 6) AS cash_out_score_ratio_avg,
    ROUND(COALESCE(SUM(work_plan), 0), 4) AS work_plan_total,
    ROUND(COALESCE(SUM(work_fact), 0), 4) AS work_fact_total,
    ROUND(COALESCE(AVG(work_score_ratio), 0), 6) AS work_score_ratio_avg,
    MAX(imported_at) AS imported_at
  FROM project_manager_export_object_values
  WHERE employee_id = ? AND period_id = ?
`);

const getProjectManagerImportObjectsByEmployeeStmt = db.prepare(`
  SELECT
    COALESCE(NULLIF(TRIM(source_object_name), ''), '—') AS source_object_name,
    cash_in_plan,
    cash_in_fact,
    cash_in_score_ratio,
    cash_out_plan,
    cash_out_fact,
    cash_out_score_ratio,
    work_plan,
    work_fact,
    work_score_ratio
  FROM project_manager_export_object_values
  WHERE employee_id = ? AND period_id = ?
  ORDER BY source_object_name COLLATE NOCASE
`);

const getProjectManagerImportRowsCountByPeriodStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM project_manager_export_object_values
  WHERE period_id = ?
`);

const copyProjectManagerImportRowsToPeriodStmt = db.prepare(`
  INSERT INTO project_manager_export_object_values (
    period_id,
    employee_id,
    source_object_key,
    source_object_name,
    object_id,
    cash_in_plan,
    cash_in_fact,
    cash_in_score_ratio,
    cash_out_plan,
    cash_out_fact,
    cash_out_score_ratio,
    work_plan,
    work_fact,
    work_score_ratio,
    import_batch_id,
    imported_at,
    updated_at
  )
  SELECT
    ?,
    employee_id,
    source_object_key,
    source_object_name,
    object_id,
    cash_in_plan,
    cash_in_fact,
    cash_in_score_ratio,
    cash_out_plan,
    cash_out_fact,
    cash_out_score_ratio,
    work_plan,
    work_fact,
    work_score_ratio,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM project_manager_export_object_values
  WHERE period_id = ?
`);

const updateEmployeeMetricValueStmt = db.prepare(`
  UPDATE employee_kpi_metric_values
  SET
    raw_value = ?,
    agreed_percent = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE record_id = ? AND metric_id = ?
`);

const getEmployeeRecordApprovalBaseStmt = db.prepare(`
  SELECT
    r.id AS record_id,
    r.object_id,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    r.created_by_user_id,
    r.updated_by_user_id,
    COALESCE(r.request_status, 'draft') AS request_status,
    r.is_approved,
    ROUND(COALESCE(SUM(vmc.effective_percent), 0), 4) AS effective_total_percent
  FROM employee_kpi_records r
  JOIN objects o ON o.id = r.object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  LEFT JOIN v_kpi_metric_calculations vmc ON vmc.record_id = r.id
  WHERE r.id = ?
  GROUP BY
    r.id,
    r.object_id,
    o.manager_name,
    o.manager_user_id,
    manager_user.display_name,
    manager_user.employee_short_name,
    r.created_by_user_id,
    r.updated_by_user_id,
    r.request_status,
    r.is_approved
`);

const resetEmployeeRecordApprovalStmt = db.prepare(`
  UPDATE employee_kpi_records
  SET
    agreed_total_percent = NULL,
    is_approved = 0,
    approved_at = NULL,
    request_status = 'draft',
    updated_by_user_id = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const approveEmployeeRecordStmt = db.prepare(`
  UPDATE employee_kpi_records
  SET
    agreed_total_percent = ?,
    is_approved = 1,
    approved_at = CURRENT_TIMESTAMP,
    request_status = 'approved',
    updated_by_user_id = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getObjectByNameStmt = db.prepare(`
  SELECT
    o.id,
    o.name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    o.is_active
  FROM objects o
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE name = ?
`);

const insertObjectStmt = db.prepare(`
  INSERT INTO objects (name, manager_name, manager_user_id)
  VALUES (?, ?, ?)
`);

const getReferenceObjectsStmt = db.prepare(`
  SELECT
    o.id,
    o.name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id
  FROM objects o
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE o.is_active = 1
  ORDER BY o.name COLLATE NOCASE
`);

const getObjectsDirectoryStmt = db.prepare(`
  SELECT
    o.id,
    o.name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    (
      SELECT COUNT(*)
      FROM employees e
      WHERE e.current_object_id = o.id
        AND e.is_active = 1
    ) AS employees_count,
    o.is_active,
    o.created_at
  FROM objects o
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE (? = 1 OR o.is_active = 1)
  ORDER BY o.is_active DESC, o.name COLLATE NOCASE
`);

const getObjectCoreStmt = db.prepare(`
  SELECT
    o.id,
    o.name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    o.is_active
  FROM objects o
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE o.id = ?
`);

const updateObjectStmt = db.prepare(`
  UPDATE objects
  SET
    name = ?,
    manager_name = ?,
    manager_user_id = ?,
    is_active = ?
  WHERE id = ?
`);

const getObjectUsageStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM employees WHERE current_object_id = ?) AS employees_count,
    (SELECT COUNT(*) FROM employee_kpi_records WHERE object_id = ?) AS records_count
`);

const deleteObjectStmt = db.prepare(`
  DELETE FROM objects
  WHERE id = ?
`);

const getReferencePositionsStmt = db.prepare(`
  SELECT DISTINCT
    position_title
  FROM employees
  WHERE position_title <> ''
  ORDER BY position_title COLLATE NOCASE
`);

const getEmployeeCoreStmt = db.prepare(`
  SELECT
    e.id,
    e.full_name,
    e.position_title,
    e.current_object_id,
    e.is_active,
    o.name AS object_name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id
  FROM employees e
  LEFT JOIN objects o ON o.id = e.current_object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE e.id = ?
`);

const insertEmployeeStmt = db.prepare(`
  INSERT INTO employees (full_name, position_title, current_object_id)
  VALUES (?, ?, ?)
`);

const insertEmployeeRecordStmt = db.prepare(`
  INSERT INTO employee_kpi_records (
    period_id,
    employee_id,
    object_id,
    position_title_snapshot,
    created_by_user_id,
    updated_by_user_id,
    request_status,
    salary_rub,
    agreed_total_percent,
    is_approved,
    approved_at,
    note
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, 'Created from localhost viewer')
`);

const insertMetricValueStmt = db.prepare(`
  INSERT INTO employee_kpi_metric_values (
    record_id,
    metric_id,
    raw_value,
    agreed_percent,
    import_batch_id,
    note,
    group_id_snapshot,
    group_code_snapshot,
    group_name_snapshot,
    group_max_percent_snapshot,
    metric_code_snapshot,
    metric_name_snapshot,
    metric_sort_order_snapshot,
    weight_snapshot,
    input_type_snapshot,
    norm_text_snapshot,
    min_value_snapshot,
    max_value_snapshot,
    target_value_snapshot
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateEmployeeCoreStmt = db.prepare(`
  UPDATE employees
  SET
    position_title = ?,
    current_object_id = ?
  WHERE id = ?
`);

const updateEmployeeCurrentObjectStmt = db.prepare(`
  UPDATE employees
  SET
    current_object_id = ?
  WHERE id = ?
`);

const updateEmployeeRecordsObjectStmt = db.prepare(`
  UPDATE employee_kpi_records
  SET
    object_id = ?,
    updated_by_user_id = ?,
    request_status = 'draft',
    updated_at = CURRENT_TIMESTAMP
  WHERE employee_id = ?
`);

const updateEmployeeRecordObjectByIdStmt = db.prepare(`
  UPDATE employee_kpi_records
  SET
    object_id = ?,
    updated_by_user_id = ?,
    request_status = 'draft',
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const updateEmployeeRecordScopeStmt = db.prepare(`
  UPDATE employee_kpi_records
  SET
    object_id = ?,
    position_title_snapshot = ?,
    agreed_total_percent = NULL,
    is_approved = 0,
    approved_at = NULL,
    request_status = 'draft',
    updated_by_user_id = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const getEmployeeByFullNameStmt = db.prepare(`
  SELECT id
  FROM employees
  WHERE full_name = ?
`);

const getActiveEmployeeByIdStmt = db.prepare(`
  SELECT
    id,
    full_name,
    is_active
  FROM employees
  WHERE id = ?
`);

const getEmployeeRecordByPeriodStmt = db.prepare(`
  SELECT
    r.id,
    r.object_id,
    r.position_title_snapshot,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id,
    r.created_by_user_id,
    r.updated_by_user_id,
    COALESCE(r.request_status, 'draft') AS request_status,
    r.is_approved,
    p.status AS period_status
  FROM employee_kpi_records r
  JOIN kpi_periods p ON p.id = r.period_id
  JOIN objects o ON o.id = r.object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE r.period_id = ? AND r.employee_id = ?
`);

const getEmployeeRecordsForPeriodStmt = db.prepare(`
  SELECT
    id,
    employee_id,
    object_id,
    position_title_snapshot,
    created_by_user_id,
    salary_rub,
    note
  FROM employee_kpi_records
  WHERE period_id = ?
  ORDER BY employee_id
`);

const getEmployeeOpenRecordsByEmployeeStmt = db.prepare(`
  SELECT
    r.id,
    r.object_id,
    r.position_title_snapshot,
    r.is_approved,
    p.code AS period_code,
    p.status AS period_status
  FROM employee_kpi_records r
  JOIN kpi_periods p ON p.id = r.period_id
  WHERE r.employee_id = ?
    AND p.status = 'open'
  ORDER BY p.year_num, p.month_num
`);

const getEmployeeRecordCountByPeriodStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM employee_kpi_records
  WHERE period_id = ?
`);

const getMetricValuesByRecordStmt = db.prepare(`
  SELECT
    mv.metric_id,
    mv.raw_value,
    mv.agreed_percent,
    mv.import_batch_id,
    mv.note,
    COALESCE(mv.group_id_snapshot, m.group_id) AS group_id,
    COALESCE(NULLIF(TRIM(mv.group_code_snapshot), ''), g.code) AS group_code,
    COALESCE(NULLIF(TRIM(mv.group_name_snapshot), ''), g.name) AS group_name,
    COALESCE(mv.group_max_percent_snapshot, g.max_percent) AS group_max_percent,
    COALESCE(NULLIF(TRIM(mv.metric_code_snapshot), ''), m.code) AS metric_code,
    COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), m.name) AS metric_name,
    COALESCE(mv.metric_sort_order_snapshot, m.sort_order) AS metric_sort_order,
    COALESCE(mv.weight_snapshot, m.weight) AS weight,
    COALESCE(NULLIF(TRIM(mv.input_type_snapshot), ''), m.input_type) AS input_type,
    COALESCE(NULLIF(TRIM(mv.norm_text_snapshot), ''), m.norm_text) AS norm_text,
    COALESCE(mv.min_value_snapshot, m.min_value) AS min_value,
    COALESCE(mv.max_value_snapshot, m.max_value) AS max_value,
    mv.target_value_snapshot AS target_value
  FROM employee_kpi_metric_values mv
  LEFT JOIN kpi_metrics m ON m.id = mv.metric_id
  LEFT JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE mv.record_id = ?
    AND COALESCE(NULLIF(TRIM(mv.metric_name_snapshot), ''), NULLIF(TRIM(m.name), '')) IS NOT NULL
  ORDER BY metric_id
`);

const insertCopiedEmployeeRecordStmt = db.prepare(`
  INSERT INTO employee_kpi_records (
    period_id,
    employee_id,
    object_id,
    position_title_snapshot,
    created_by_user_id,
    updated_by_user_id,
    request_status,
    salary_rub,
    agreed_total_percent,
    is_approved,
    approved_at,
    note
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?)
`);

const updateCopiedEmployeeRecordStmt = db.prepare(`
  UPDATE employee_kpi_records
  SET
    object_id = ?,
    position_title_snapshot = ?,
    salary_rub = ?,
    updated_by_user_id = ?,
    request_status = ?,
    agreed_total_percent = NULL,
    is_approved = 0,
    approved_at = NULL,
    note = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const deleteMetricValuesByRecordStmt = db.prepare(`
  DELETE FROM employee_kpi_metric_values
  WHERE record_id = ?
`);

const insertCopiedMetricValueStmt = db.prepare(`
  INSERT INTO employee_kpi_metric_values (
    record_id,
    metric_id,
    raw_value,
    agreed_percent,
    import_batch_id,
    note,
    group_id_snapshot,
    group_code_snapshot,
    group_name_snapshot,
    group_max_percent_snapshot,
    metric_code_snapshot,
    metric_name_snapshot,
    metric_sort_order_snapshot,
    weight_snapshot,
    input_type_snapshot,
    norm_text_snapshot,
    min_value_snapshot,
    max_value_snapshot,
    target_value_snapshot
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getReferenceEmployeesStmt = db.prepare(`
  SELECT
    e.id,
    e.full_name,
    e.position_title,
    e.current_object_id,
    COALESCE(o.name, '') AS object_name,
    COALESCE(NULLIF(TRIM(o.manager_name), ''), NULLIF(TRIM(manager_user.display_name), ''), manager_user.employee_short_name, '') AS manager_name,
    o.manager_user_id
  FROM employees e
  LEFT JOIN objects o ON o.id = e.current_object_id
  LEFT JOIN auth_users manager_user ON manager_user.id = o.manager_user_id
  WHERE e.is_active = 1
  ORDER BY e.full_name COLLATE NOCASE
`);

const getMetricGroupsDirectoryStmt = db.prepare(`
  SELECT
    id,
    code,
    name,
    max_percent,
    sort_order
  FROM kpi_metric_groups
  ORDER BY sort_order
`);

const getMetricGroupByCodeStmt = db.prepare(`
  SELECT
    id,
    code,
    name,
    max_percent,
    sort_order
  FROM kpi_metric_groups
  WHERE code = ?
`);

const getMetricsDirectoryStmt = db.prepare(`
  SELECT
    m.id,
    m.group_id,
    g.code AS group_code,
    g.name AS group_name,
    g.max_percent AS group_max_percent,
    m.code,
    m.name,
    m.weight,
    m.input_type,
    m.norm_text,
    m.min_value,
    m.max_value,
    m.sort_order,
    m.is_active
  FROM kpi_metrics m
  JOIN kpi_metric_groups g ON g.id = m.group_id
  ORDER BY g.sort_order, m.sort_order, m.name COLLATE NOCASE
`);

const getMetricByIdStmt = db.prepare(`
  SELECT
    m.id,
    m.group_id,
    g.code AS group_code,
    m.code,
    m.name,
    m.weight,
    m.input_type,
    m.norm_text,
    m.min_value,
    m.max_value,
    m.sort_order,
    m.is_active
  FROM kpi_metrics m
  JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE m.id = ?
`);

const getMaxMetricSortOrderStmt = db.prepare(`
  SELECT COALESCE(MAX(sort_order), 0) AS max_sort_order
  FROM kpi_metrics
  WHERE group_id = ?
`);

const insertMetricStmt = db.prepare(`
  INSERT INTO kpi_metrics (
    group_id,
    code,
    name,
    weight,
    input_type,
    norm_text,
    min_value,
    max_value,
    sort_order,
    is_active
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
`);

const insertMetricValuesForExistingRecordsStmt = db.prepare(`
  INSERT INTO employee_kpi_metric_values (
    record_id,
    metric_id,
    raw_value,
    agreed_percent,
    import_batch_id,
    note
  )
  SELECT
    id,
    ?,
    0,
    NULL,
    NULL,
    'Default values for new metric'
  FROM employee_kpi_records
`);

const updateMetricStmt = db.prepare(`
  UPDATE kpi_metrics
  SET
    group_id = ?,
    name = ?,
    weight = ?,
    input_type = ?,
    norm_text = ?,
    min_value = ?,
    max_value = ?,
    sort_order = ?
  WHERE id = ?
`);

const deleteMetricValuesByMetricIdStmt = db.prepare(`
  DELETE FROM employee_kpi_metric_values
  WHERE metric_id = ?
`);

const deleteMetricStmt = db.prepare(`
  DELETE FROM kpi_metrics
  WHERE id = ?
`);

const getKnownPositionStmt = db.prepare(`
  SELECT position_title
  FROM employees
  WHERE position_title = ?
  LIMIT 1
`);

const getPositionProfilePositionsStmt = db.prepare(`
  SELECT DISTINCT
    position_title
  FROM employees
  WHERE position_title <> ''
  ORDER BY position_title COLLATE NOCASE
`);

const getPositionCatalogMetricsStmt = db.prepare(`
  SELECT
    m.id AS metric_id,
    g.id AS group_id,
    g.code AS group_code,
    g.name AS group_name,
    g.max_percent AS group_max_percent,
    m.name AS metric_name,
    m.input_type,
    m.norm_text,
    m.max_value,
    m.sort_order
  FROM kpi_metrics m
  JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE m.is_active = 1
  ORDER BY g.sort_order, m.sort_order, m.name COLLATE NOCASE
`);

const getPositionAssignmentsStmt = db.prepare(`
  SELECT
    a.id AS assignment_id,
    a.position_title,
    a.metric_id,
    a.weight,
    a.target_value,
    a.sort_order,
    g.id AS group_id,
    g.code AS group_code,
    g.name AS group_name,
    g.max_percent AS group_max_percent,
    m.name AS metric_name,
    m.input_type,
    m.norm_text
  FROM position_kpi_metric_assignments a
  JOIN kpi_metrics m ON m.id = a.metric_id
  JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE a.position_title = ?
  ORDER BY g.sort_order, a.sort_order, m.name COLLATE NOCASE
`);

const getPositionAssignmentByIdStmt = db.prepare(`
  SELECT
    a.id,
    a.position_title,
    a.metric_id,
    a.weight,
    a.target_value,
    a.sort_order,
    g.id AS group_id,
    g.code AS group_code,
    m.name AS metric_name,
    m.input_type,
    m.norm_text
  FROM position_kpi_metric_assignments a
  JOIN kpi_metrics m ON m.id = a.metric_id
  JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE a.id = ?
`);

const getPositionAssignmentByPositionMetricStmt = db.prepare(`
  SELECT id
  FROM position_kpi_metric_assignments
  WHERE position_title = ?
    AND metric_id = ?
`);

const getMaxPositionAssignmentSortOrderStmt = db.prepare(`
  SELECT COALESCE(MAX(a.sort_order), 0) AS max_sort_order
  FROM position_kpi_metric_assignments a
  JOIN kpi_metrics m ON m.id = a.metric_id
  JOIN kpi_metric_groups g ON g.id = m.group_id
  WHERE a.position_title = ?
    AND g.code = ?
`);

const insertPositionAssignmentStmt = db.prepare(`
  INSERT INTO position_kpi_metric_assignments (
    position_title,
    metric_id,
    weight,
    target_value,
    sort_order
  )
  VALUES (?, ?, ?, ?, ?)
`);

const updatePositionAssignmentStmt = db.prepare(`
  UPDATE position_kpi_metric_assignments
  SET
    weight = ?,
    target_value = ?,
    sort_order = ?,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const deletePositionAssignmentStmt = db.prepare(`
  DELETE FROM position_kpi_metric_assignments
  WHERE id = ?
`);

const getStaffDirectoryStmt = db.prepare(`
  SELECT
    e.id AS employee_id,
    e.full_name,
    e.position_title,
    e.is_active,
    e.created_at,
    o.id AS object_id,
    COALESCE(o.name, '') AS object_name
  FROM employees e
  LEFT JOIN objects o ON o.id = e.current_object_id
  WHERE (? = 1 OR e.is_active = 1)
  ORDER BY e.is_active DESC, e.full_name COLLATE NOCASE
`);

const updateEmployeeActiveStmt = db.prepare(`
  UPDATE employees
  SET is_active = ?
  WHERE id = ?
`);

const deleteEmployeeRecordsStmt = db.prepare(`
  DELETE FROM employee_kpi_records
  WHERE employee_id = ?
`);

const deleteEmployeeStmt = db.prepare(`
  DELETE FROM employees
  WHERE id = ?
`);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function sendRedirect(res, location) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end();
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(html);
}

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeCredential(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeRoleCode(value, fallbackRoleCode = '') {
  const normalized = normalizeCredential(value);
  if (normalized === ROLE_CODES.ADMIN || normalized === 'administrator') {
    return ROLE_CODES.ADMIN;
  }
  if (normalized === ROLE_CODES.BOSS) {
    return ROLE_CODES.BOSS;
  }
  if (normalized === ROLE_CODES.MANAGER || normalized === 'leader') {
    return ROLE_CODES.MANAGER;
  }

  return fallbackRoleCode ? normalizeRoleCode(fallbackRoleCode) : '';
}

function getRoleLabel(roleCode) {
  return ROLE_LABELS[normalizeRoleCode(roleCode, ROLE_CODES.MANAGER)] || roleCode;
}

function normalizeEmployeeShortName(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length >= 3) {
    const surname = parts[0];
    const initials = parts
      .slice(1)
      .map((part) => part[0] ? `${part[0].toUpperCase()}.` : '')
      .join('');
    return `${surname} ${initials}`.trim();
  }

  if (parts.length === 2 && /[.\p{L}]+/u.test(parts[1])) {
    const surname = parts[0];
    const initials = parts[1]
      .replace(/[^\p{L}]/gu, '')
      .split('')
      .slice(0, 2)
      .map((letter) => `${letter.toUpperCase()}.`)
      .join('');
    if (initials) {
      return `${surname} ${initials}`.trim();
    }
  }

  return normalized;
}

function buildShortNameAccessKey(value) {
  const normalized = normalizeEmployeeShortName(value);
  if (!normalized) {
    return '';
  }

  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const surname = parts[0].toLowerCase();
    const initials = parts
      .slice(1)
      .join('')
      .replace(/[^\p{L}]/gu, '')
      .toLowerCase();
    return `${surname}|${initials}`;
  }

  return normalized.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

function getProjectAccessUserKeys(userRow) {
  return [
    buildShortNameAccessKey(userRow?.employee_short_name || userRow?.employeeShortName),
    buildShortNameAccessKey(userRow?.display_name || userRow?.displayName),
  ].filter(Boolean);
}

function getPreferredManagerNameFromUser(userRow) {
  const displayName = normalizeText(userRow?.display_name || userRow?.displayName);
  if (displayName) {
    return displayName;
  }

  return normalizeEmployeeShortName(userRow?.employee_short_name || userRow?.employeeShortName);
}

function listProjectAccessUsersRaw() {
  return db.prepare(`
    SELECT
      id,
      display_name,
      employee_short_name,
      role_code
    FROM auth_users
    WHERE is_active = 1
      AND role_code IN ('boss', 'manager')
    ORDER BY
      CASE role_code WHEN 'boss' THEN 1 WHEN 'manager' THEN 2 ELSE 9 END,
      employee_short_name COLLATE NOCASE,
      display_name COLLATE NOCASE
  `).all();
}

function findProjectAccessUserByName(managerName, projectUsers = null) {
  const managerAccessKey = buildShortNameAccessKey(managerName);
  if (!managerAccessKey) {
    return null;
  }

  const matches = (Array.isArray(projectUsers) ? projectUsers : listProjectAccessUsersRaw())
    .filter((userRow) => getProjectAccessUserKeys(userRow).includes(managerAccessKey));
  return matches.length === 1 ? matches[0] : null;
}

function syncObjectManagerLinks() {
  const projectUsers = listProjectAccessUsersRaw();
  const objects = db.prepare(`
    SELECT
      id,
      manager_user_id,
      COALESCE(manager_name, '') AS manager_name
    FROM objects
  `).all();

  if (!objects.length) {
    return;
  }

  const updateObjectManagerUserStmt = db.prepare(`
    UPDATE objects
    SET manager_user_id = ?
    WHERE id = ?
  `);
  const syncObjectManagerNameStmt = db.prepare(`
    UPDATE objects
    SET manager_name = ?
    WHERE id = ?
  `);

  for (const objectRow of objects) {
    if (objectRow.manager_user_id) {
      const linkedUser = projectUsers.find((userRow) => Number(userRow.id) === Number(objectRow.manager_user_id));
      if (linkedUser) {
        const preferredManagerName = getPreferredManagerNameFromUser(linkedUser);
        const shouldSyncManagerName = !normalizeText(objectRow.manager_name) || (
          buildShortNameAccessKey(objectRow.manager_name) === buildShortNameAccessKey(preferredManagerName)
        );

        if (preferredManagerName && shouldSyncManagerName) {
          syncObjectManagerNameStmt.run(preferredManagerName, objectRow.id);
        }
      }

      if (!linkedUser) {
        updateObjectManagerUserStmt.run(null, objectRow.id);
      } else {
        continue;
      }
    }

    const matchedUser = findProjectAccessUserByName(objectRow.manager_name, projectUsers);
    if (matchedUser) {
      updateObjectManagerUserStmt.run(matchedUser.id, objectRow.id);
      const preferredManagerName = getPreferredManagerNameFromUser(matchedUser);
      if (preferredManagerName) {
        syncObjectManagerNameStmt.run(preferredManagerName, objectRow.id);
      }
    }
  }
}

function isAdminUser(user) {
  return normalizeRoleCode(user?.roleCode || user?.role_code) === ROLE_CODES.ADMIN;
}

function isBossUser(user) {
  return normalizeRoleCode(user?.roleCode || user?.role_code) === ROLE_CODES.BOSS;
}

function isProjectScopedUser(user) {
  const roleCode = normalizeRoleCode(user?.roleCode || user?.role_code);
  return roleCode === ROLE_CODES.BOSS || roleCode === ROLE_CODES.MANAGER;
}

function buildUserPermissions(user) {
  const roleCode = normalizeRoleCode(user?.roleCode || user?.role_code);
  const isAdmin = roleCode === ROLE_CODES.ADMIN;
  const isScopedUser = roleCode === ROLE_CODES.BOSS || roleCode === ROLE_CODES.MANAGER;
  const visiblePages = isAdmin
    ? ['/index.html', '/staff.html', '/objects.html', '/upload.html', '/metrics.html', '/position-kpi.html', '/users.html', '/logs.html']
    : (isScopedUser ? ['/index.html', '/objects.html'] : ['/index.html']);

  return {
    roleCode,
    roleLabel: getRoleLabel(roleCode),
    visiblePages,
    canViewKpi: true,
    canManageKpi: true,
    canCreateKpiRecord: true,
    canAssignObject: true,
    canSelectPeriod: true,
    canUseKpiFilters: true,
    canApproveCards: true,
    canPrint: true,
    canViewRecordAudit: true,
    canCopyPeriodData: isAdmin,
    canManageDirectories: isAdmin,
    canManageUsers: isAdmin,
    canViewLogs: isAdmin,
  };
}

function formatAuthenticatedUser(user) {
  const roleCode = normalizeRoleCode(user.role_code || user.roleCode, DEFAULT_AUTH_ROLE_CODE);
  return {
    id: user.id,
    login: user.login,
    displayName: user.display_name || user.displayName || normalizeEmployeeShortName(user.employee_short_name),
    employeeShortName: normalizeEmployeeShortName(user.employee_short_name || user.display_name || user.displayName),
    roleCode,
    roleLabel: getRoleLabel(roleCode),
    isActive: Boolean(user.is_active ?? user.isActive),
    lastLoginAt: user.last_login_at ?? user.lastLoginAt ?? null,
  };
}

function canAccessPage(user, pathname) {
  if (isAdminUser(user)) {
    return true;
  }

  return pathname === '/index.html' || (isProjectScopedUser(user) && pathname === '/objects.html');
}

function isEmployeeObjectUnassigned(employeeRow) {
  if (!employeeRow) {
    return true;
  }

  if (!employeeRow.current_object_id) {
    return true;
  }

  return normalizeText(employeeRow.object_name || employeeRow.objectName) === DEFAULT_EMPLOYEE_OBJECT_NAME;
}

function canAccessObjectForScopedUser(user, managerName, managerUserId = null) {
  if (isAdminUser(user)) {
    return true;
  }

  if (isBossUser(user)) {
    return true;
  }

  if (!isProjectScopedUser(user)) {
    return false;
  }

  const scopedUserId = Number(user?.id || 0);
  const linkedManagerUserId = Number(managerUserId || 0);
  if (scopedUserId > 0 && linkedManagerUserId > 0 && scopedUserId === linkedManagerUserId) {
    return true;
  }

  const userAccessKeys = getProjectAccessUserKeys(user);
  const managerAccessKey = buildShortNameAccessKey(managerName);
  return Boolean(
    managerAccessKey &&
    userAccessKeys.length &&
    userAccessKeys.includes(managerAccessKey)
  );
}

function canAccessKpiRecord(user, recordScope) {
  if (!recordScope) {
    return false;
  }

  if (isAdminUser(user)) {
    return true;
  }

  return (
    canAccessObjectForScopedUser(
      user,
      recordScope.manager_name || recordScope.managerName,
      recordScope.manager_user_id || recordScope.managerUserId
    ) ||
    Number(recordScope.created_by_user_id || recordScope.createdByUserId || 0) === Number(user.id)
  );
}

function buildRecordPermissions(user, recordScope) {
  const canAccess = canAccessKpiRecord(user, recordScope);
  return {
    canView: canAccess,
    canEdit: canAccess,
    canApprove: canAccess,
    canPrint: Boolean(buildUserPermissions(user).canPrint),
    canViewAudit: canAccess,
  };
}

function assertAccessAllowed(isAllowed) {
  if (!isAllowed) {
    throw new Error(ACCESS_DENIED_MESSAGE);
  }
}

function writeActionLog(actorUser, actionType, entityType, entityId, message, details = null) {
  const formattedUser = actorUser ? formatAuthenticatedUser(actorUser) : null;
  insertActionLogStmt.run(
    formattedUser?.id || null,
    formattedUser?.login || null,
    formattedUser?.displayName || null,
    formattedUser?.roleCode || null,
    actionType,
    entityType,
    entityId === undefined || entityId === null ? null : String(entityId),
    message,
    details ? JSON.stringify(details) : null
  );
}

function formatDirectoryUser(row) {
  const roleCode = normalizeRoleCode(row.role_code || row.roleCode, ROLE_CODES.MANAGER);
  return {
    userId: row.id,
    login: row.login,
    displayName: row.display_name || row.displayName,
    employeeShortName: normalizeEmployeeShortName(row.employee_short_name || row.employeeShortName),
    roleCode,
    roleLabel: getRoleLabel(roleCode),
    isActive: Boolean(row.is_active ?? row.isActive),
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt ?? null,
  };
}

function clampLogLimit(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 200;
  }

  return Math.min(500, Math.max(1, Math.trunc(numericValue)));
}

function buildSetCookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  parts.push(`Path=${options.path || '/'}`);

  if (options.httpOnly !== false) {
    parts.push('HttpOnly');
  }

  parts.push(`SameSite=${options.sameSite || 'Strict'}`);
  return parts.join('; ');
}

function appendSetCookieHeader(res, cookieValue) {
  const currentHeader = res.getHeader('Set-Cookie');
  if (!currentHeader) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }

  if (Array.isArray(currentHeader)) {
    res.setHeader('Set-Cookie', [...currentHeader, cookieValue]);
    return;
  }

  res.setHeader('Set-Cookie', [currentHeader, cookieValue]);
}

function setSessionCookie(res, sessionId) {
  appendSetCookieHeader(
    res,
    buildSetCookieHeader(SESSION_COOKIE_NAME, sessionId, {
      maxAge: SESSION_TTL_MS / 1000,
    })
  );
}

function clearSessionCookie(res) {
  appendSetCookieHeader(
    res,
    buildSetCookieHeader(SESSION_COOKIE_NAME, '', {
      maxAge: 0,
    })
  );
}

function parseCookies(req) {
  const rawCookieHeader = req.headers.cookie || '';
  const cookies = {};

  for (const part of rawCookieHeader.split(';')) {
    const [rawName, ...rawValueParts] = part.split('=');
    const name = String(rawName || '').trim();
    if (!name) {
      continue;
    }

    const value = rawValueParts.join('=').trim();
    cookies[name] = decodeURIComponent(value);
  }

  return cookies;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(sessionId);
    }
  }
}

function createSession(userId) {
  pruneExpiredSessions();
  const sessionId = randomUUID();
  sessions.set(sessionId, {
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessionId;
}

function destroySession(sessionId) {
  if (sessionId) {
    sessions.delete(sessionId);
  }
}

function getSessionFromRequest(req) {
  pruneExpiredSessions();
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { sessionId, session };
}

function getAuthenticatedRequestContext(req) {
  const sessionEntry = getSessionFromRequest(req);
  if (!sessionEntry) {
    return null;
  }

  const user = getAuthUserByIdStmt.get(sessionEntry.session.userId);
  if (!user || !user.is_active) {
    destroySession(sessionEntry.sessionId);
    return null;
  }

  const formattedUser = formatAuthenticatedUser(user);
  return {
    sessionId: sessionEntry.sessionId,
    session: sessionEntry.session,
    user: formattedUser,
    permissions: buildUserPermissions(formattedUser),
  };
}

function requireAuthenticatedApiRequest(req, res) {
  const authContext = getAuthenticatedRequestContext(req);
  if (!authContext) {
    clearSessionCookie(res);
    sendError(res, 401, 'Требуется авторизация.');
    return null;
  }

  setSessionCookie(res, authContext.sessionId);
  req.auth = authContext;
  return authContext;
}

function getRequestClientKey(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return normalizeText(req.socket?.remoteAddress || 'localhost') || 'localhost';
}

function clearExpiredLoginAttemptState(record, attemptKey) {
  if (!record) {
    return null;
  }

  const now = Date.now();
  if (record.lockedUntil && record.lockedUntil > now) {
    return record;
  }

  if (record.windowStartedAt + LOGIN_ATTEMPT_WINDOW_MS <= now) {
    loginAttempts.delete(attemptKey);
    return null;
  }

  if (record.lockedUntil && record.lockedUntil <= now) {
    loginAttempts.set(attemptKey, {
      count: 0,
      windowStartedAt: now,
      lockedUntil: 0,
    });
    return loginAttempts.get(attemptKey);
  }

  return record;
}

function isLoginBlocked(req) {
  const attemptKey = getRequestClientKey(req);
  const currentRecord = clearExpiredLoginAttemptState(loginAttempts.get(attemptKey), attemptKey);
  return Boolean(currentRecord && currentRecord.lockedUntil && currentRecord.lockedUntil > Date.now());
}

function registerFailedLoginAttempt(req) {
  const attemptKey = getRequestClientKey(req);
  const now = Date.now();
  const currentRecord = clearExpiredLoginAttemptState(loginAttempts.get(attemptKey), attemptKey);
  const nextRecord = currentRecord && currentRecord.windowStartedAt + LOGIN_ATTEMPT_WINDOW_MS > now
    ? {
        count: currentRecord.count + 1,
        windowStartedAt: currentRecord.windowStartedAt,
        lockedUntil: currentRecord.lockedUntil || 0,
      }
    : {
        count: 1,
        windowStartedAt: now,
        lockedUntil: 0,
      };

  if (nextRecord.count >= MAX_LOGIN_ATTEMPTS) {
    nextRecord.lockedUntil = now + LOGIN_LOCK_DURATION_MS;
  }

  loginAttempts.set(attemptKey, nextRecord);
  return nextRecord;
}

function clearLoginAttemptState(req) {
  loginAttempts.delete(getRequestClientKey(req));
}

const METRIC_INPUT_TYPES = new Set(['score', 'pct', 'disc']);

function normalizeIncomingText(payload, key, fallback = '') {
  if (payload && Object.prototype.hasOwnProperty.call(payload, key)) {
    return normalizeText(payload[key]);
  }
  return normalizeText(fallback);
}

function getMetricDefaults(inputType) {
  if (inputType === 'score') {
    return {
      minValue: 0,
      maxValue: 5,
      normText: '0-5 б.',
    };
  }

  return {
    minValue: 0,
    maxValue: 100,
    normText: '0-100%',
  };
}

function resolveRequestedPeriodCode(periodCode) {
  const requestedCode = normalizeText(periodCode);
  if (requestedCode) {
    const requestedPeriod = getPeriodByCodeStmt.get(requestedCode);
    if (requestedPeriod) {
      return requestedPeriod.code;
    }
  }

  const fallbackPeriod = getDefaultPeriodStmt.get();
  return fallbackPeriod ? fallbackPeriod.code : null;
}

function buildDashboardLocation(periodCode = '') {
  const resolvedPeriodCode = resolveRequestedPeriodCode(periodCode);
  if (!resolvedPeriodCode) {
    return '/index.html';
  }

  return `/index.html?period=${encodeURIComponent(resolvedPeriodCode)}`;
}

function getSelectedPeriodCode(urlObj) {
  return resolveRequestedPeriodCode(urlObj.searchParams.get('period'));
}

function getPeriodRow(periodCode) {
  const selectedCode = normalizeText(periodCode) || (getDefaultPeriodStmt.get() || {}).code || null;
  if (!selectedCode) {
    return null;
  }
  return getPeriodByCodeStmt.get(selectedCode) || null;
}

function getPreviousPeriodRow(periodRow) {
  if (!periodRow) {
    return null;
  }

  return getPreviousPeriodByYearMonthStmt.get(
    Number(periodRow.year_num || 0),
    Number(periodRow.year_num || 0),
    Number(periodRow.month_num || 0)
  ) || null;
}

function canAutoSeedPeriodFromPrevious(periodRow) {
  if (!periodRow) {
    return false;
  }

  const periodYear = Number(periodRow.year_num || 0);
  const periodMonth = Number(periodRow.month_num || 0);
  if (!periodYear || !periodMonth) {
    return false;
  }

  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;
  return periodYear < currentYear || (periodYear === currentYear && periodMonth <= currentMonth);
}

function formatDashboardEmployee(row) {
  return {
    recordId: row.record_id,
    employeeId: row.employee_id,
    fullName: row.full_name,
    positionTitle: row.position_title,
    objectId: row.object_id,
    objectName: row.object_name,
    managerName: row.manager_name,
    managerUserId: row.manager_user_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedByUserId: row.updated_by_user_id,
    updatedAt: row.updated_at,
    requestStatus: row.request_status || 'draft',
    salaryRub: row.salary_rub,
    blockAPercent: row.block_a_percent,
    blockBPercent: row.block_b_percent,
    calculatedTotalPercent: row.calculated_total_percent,
    finalTotalPercent: row.final_total_percent,
    bonusRub: row.bonus_rub,
    status: row.status,
    isApproved: Boolean(row.is_approved),
    approvedAt: row.approved_at,
  };
}

function filterDashboardEmployeesForUser(user, employeeRows) {
  if (isAdminUser(user)) {
    return employeeRows.map(formatDashboardEmployee);
  }

  return employeeRows
    .filter((row) => canAccessKpiRecord(user, row))
    .map(formatDashboardEmployee);
}

function buildDashboardSummaryFromEmployees(employees) {
  const summary = {
    employeesCount: employees.length,
    doneCount: 0,
    partialCount: 0,
    failedCount: 0,
    approvedCount: 0,
    avgBlockAPercent: 0,
    avgBlockBPercent: 0,
    avgTotalPercent: 0,
    totalBonusRub: 0,
  };

  if (!employees.length) {
    return summary;
  }

  let blockASum = 0;
  let blockBSum = 0;
  let totalPercentSum = 0;
  let totalBonusSum = 0;

  for (const employee of employees) {
    if (employee.status === 'Выполнено') {
      summary.doneCount += 1;
    } else if (employee.status === 'Частично') {
      summary.partialCount += 1;
    } else {
      summary.failedCount += 1;
    }

    if (employee.isApproved) {
      summary.approvedCount += 1;
    }

    blockASum += Number(employee.blockAPercent || 0);
    blockBSum += Number(employee.blockBPercent || 0);
    totalPercentSum += Number(employee.finalTotalPercent || 0);
    totalBonusSum += Number(employee.bonusRub || 0);
  }

  summary.avgBlockAPercent = Number((blockASum / employees.length).toFixed(3));
  summary.avgBlockBPercent = Number((blockBSum / employees.length).toFixed(3));
  summary.avgTotalPercent = Number((totalPercentSum / employees.length).toFixed(3));
  summary.totalBonusRub = Number(totalBonusSum.toFixed(2));
  return summary;
}

function buildDashboardObjectsFromEmployees(employees, fallbackObjects = []) {
  const objectMap = new Map();

  for (const objectItem of fallbackObjects) {
    const objectId = Number(objectItem.objectId);
    if (!objectId || objectMap.has(objectId)) {
      continue;
    }

    objectMap.set(objectId, {
      objectId,
      objectName: objectItem.objectName,
      managerName: objectItem.managerName,
      managerUserId: objectItem.managerUserId,
      employeesCount: 0,
      approvedCount: 0,
      avgTotalPercent: 0,
      _totalPercentSum: 0,
    });
  }

  for (const employee of employees) {
    const objectId = Number(employee.objectId);
    const currentObject = objectMap.get(objectId) || {
      objectId,
      objectName: employee.objectName,
      managerName: employee.managerName,
      managerUserId: employee.managerUserId,
      employeesCount: 0,
      approvedCount: 0,
      avgTotalPercent: 0,
      _totalPercentSum: 0,
    };

    currentObject.employeesCount += 1;
    currentObject.approvedCount += employee.isApproved ? 1 : 0;
    currentObject._totalPercentSum += Number(employee.finalTotalPercent || 0);
    objectMap.set(objectId, currentObject);
  }

  return [...objectMap.values()]
    .map((objectItem) => ({
      objectId: objectItem.objectId,
      objectName: objectItem.objectName,
      managerName: objectItem.managerName,
      managerUserId: objectItem.managerUserId,
      employeesCount: objectItem.employeesCount,
      approvedCount: objectItem.approvedCount,
      avgTotalPercent: objectItem.employeesCount
        ? Number((objectItem._totalPercentSum / objectItem.employeesCount).toFixed(3))
        : 0,
    }))
    .sort((left, right) => String(left.objectName).localeCompare(String(right.objectName), 'ru'));
}

function formatEmployeeDetail(header, metrics, actorUser, projectManagerImportSummary = null) {
  const groups = [];
  const groupMap = new Map();
  const isProjectManager = isProjectManagerPosition(header.position_title);

  for (const metric of metrics) {
    let group = groupMap.get(metric.group_code);
    if (!group) {
      group = {
        code: metric.group_code,
        name: metric.group_name,
        maxPercent: metric.group_max_percent,
        metrics: [],
      };
      groupMap.set(metric.group_code, group);
      groups.push(group);
    }

    group.metrics.push({
      metricId: metric.metric_id,
      code: metric.metric_code,
      name: metric.metric_name,
      weight: metric.weight,
      inputType: metric.input_type,
      normText: metric.norm_text,
      rawValue: metric.raw_value,
      agreedPercent: metric.agreed_percent,
      calculatedPercent: metric.calculated_percent,
      effectivePercent: metric.effective_percent,
      minValue: metric.min_value,
      maxValue: metric.max_value,
    });
  }

  return {
    recordId: header.record_id,
    periodId: header.period_id,
    periodCode: header.period_code,
    periodLabel: header.period_label,
    employeeId: header.employee_id,
    fullName: header.full_name,
    positionTitle: header.position_title,
    isProjectManager,
    object: {
      id: header.object_id,
      name: header.object_name,
      managerName: header.manager_name,
      managerUserId: header.manager_user_id,
    },
    salaryRub: header.salary_rub,
    blockAPercent: header.block_a_percent,
    blockBPercent: header.block_b_percent,
    calculatedTotalPercent: header.calculated_total_percent,
    finalTotalPercent: header.final_total_percent,
    bonusRub: header.bonus_rub,
    status: header.status,
    agreedTotalPercent: header.agreed_total_percent,
    isApproved: Boolean(header.is_approved),
    approvedAt: header.approved_at,
    createdByUserId: header.created_by_user_id,
    createdByDisplayName: header.created_by_display_name,
    createdAt: header.created_at,
    updatedByUserId: header.updated_by_user_id,
    updatedByDisplayName: header.updated_by_display_name,
    updatedAt: header.updated_at,
    requestStatus: header.request_status || 'draft',
    permissions: buildRecordPermissions(actorUser, header),
    projectManagerImport: isProjectManager
      ? (projectManagerImportSummary || getProjectManagerImportSummaryForEmployee(header.period_id, header.employee_id))
      : null,
    groups,
  };
}

function withTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  }
}

function insertMetricSnapshotValue(recordId, snapshot, overrides = {}) {
  insertMetricValueStmt.run(...buildMetricSnapshotInsertValues(recordId, snapshot, overrides));
}

function createMetricSnapshotValuesForRecord(recordId, positionTitle, options = {}) {
  const templates = listMetricSnapshotTemplatesForPosition(positionTitle);
  const preservedMetricValues = options.preservedMetricValues || new Map();
  const defaultNote = options.defaultNote ?? 'Default values for new employee';

  for (const template of templates) {
    const preservedValue = preservedMetricValues.get(template.metricId);
    insertMetricSnapshotValue(recordId, template, {
      rawValue: preservedValue ? preservedValue.rawValue : 0,
      agreedPercent: preservedValue ? preservedValue.agreedPercent : null,
      importBatchId: preservedValue ? preservedValue.importBatchId : null,
      note: preservedValue ? preservedValue.note : defaultNote,
    });
  }
}

function createEmployeeRecordWithSnapshots(periodId, employeeId, objectId, positionTitle, actorUser, requestStatus = 'draft') {
  const recordInsert = insertEmployeeRecordStmt.run(
    periodId,
    employeeId,
    objectId,
    positionTitle,
    actorUser.id,
    actorUser.id,
    requestStatus
  );
  const recordId = Number(recordInsert.lastInsertRowid);
  createMetricSnapshotValuesForRecord(recordId, positionTitle);
  return recordId;
}

function rebuildRecordMetricSnapshots(recordId, positionTitle, options = {}) {
  const preservedMetricValues = new Map(
    getMetricValuesByRecordStmt
      .all(recordId)
      .map((row) => [Number(row.metric_id), mapStoredMetricSnapshotRow(row)])
  );

  deleteMetricValuesByRecordStmt.run(recordId);
  createMetricSnapshotValuesForRecord(recordId, positionTitle, {
    preservedMetricValues,
    defaultNote: options.defaultNote ?? 'Default values after employee position update',
  });
}

function syncRecordScopeToEmployee(recordRow, employeeRow, objectId, actorUser, options = {}) {
  const desiredObjectId = Number(objectId || 0);
  const currentObjectId =
    recordRow.object_id === null || recordRow.object_id === undefined
      ? null
      : Number(recordRow.object_id);
  const desiredPositionTitle = String(employeeRow.position_title || '');
  const currentPositionTitle = normalizeText(recordRow.position_title_snapshot);
  const nextPositionTitle = normalizeText(desiredPositionTitle);
  const positionChanged = currentPositionTitle !== nextPositionTitle;
  const objectChanged = currentObjectId !== desiredObjectId;
  const shouldRebuildMetrics = Boolean(options.forceMetricRebuild) || positionChanged;

  if (!objectChanged && !positionChanged && !shouldRebuildMetrics) {
    return {
      updated: false,
      objectChanged: false,
      positionChanged: false,
      approvalReset: false,
    };
  }

  updateEmployeeRecordScopeStmt.run(desiredObjectId, desiredPositionTitle, actorUser.id, recordRow.id);
  if (shouldRebuildMetrics) {
    rebuildRecordMetricSnapshots(recordRow.id, desiredPositionTitle, {
      defaultNote: options.defaultNote,
    });
  }

  return {
    updated: true,
    objectChanged,
    positionChanged,
    approvalReset: Boolean(recordRow.is_approved),
  };
}

function ensureObject(objectName) {
  const normalizedName = normalizeText(objectName);
  if (!normalizedName) {
    throw new Error('Название объекта обязательно.');
  }

  const existing = getObjectByNameStmt.get(normalizedName);
  if (existing) {
    return existing;
  }

  const result = insertObjectStmt.run(normalizedName, null, null);
  return {
    id: Number(result.lastInsertRowid),
    name: normalizedName,
    manager_name: null,
    manager_user_id: null,
  };
}

function ensureActiveObject(objectName) {
  const normalizedName = normalizeText(objectName);
  if (!normalizedName) {
    throw new Error('Название объекта обязательно.');
  }

  const existing = getObjectByNameStmt.get(normalizedName);
  if (existing) {
    if (!existing.is_active) {
      throw new Error('Объект находится в архиве. Верните его на листе "Объекты".');
    }
    return existing;
  }

  const result = insertObjectStmt.run(normalizedName, null, null);
  return {
    id: Number(result.lastInsertRowid),
    name: normalizedName,
    manager_name: null,
    manager_user_id: null,
    is_active: 1,
  };
}

function validateObjectName(payload, fallbackName = '') {
  const objectName = normalizeIncomingText(payload, 'objectName', fallbackName);
  if (!objectName) {
    throw new Error('Название объекта обязательно.');
  }
  return objectName;
}

function validateObjectManagerNames(payload, fallbackManagerNames = []) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'managerNames')) {
    return normalizeManagerNameList(payload.managerNames);
  }

  if (payload && Object.prototype.hasOwnProperty.call(payload, 'managerName')) {
    return normalizeManagerNameList(payload.managerName);
  }

  return normalizeManagerNameList(fallbackManagerNames);
}

function parseOptionalReferenceId(value, errorMessage) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 1) {
    throw new Error(errorMessage);
  }
  return numericValue;
}

function parseOptionalReferenceIdList(values, errorMessage) {
  const sourceValues = Array.isArray(values) ? values : [values];
  const parsedValues = [];

  for (const value of sourceValues) {
    const parsedValue = parseOptionalReferenceId(value, errorMessage);
    if (parsedValue !== null) {
      parsedValues.push(parsedValue);
    }
  }

  return normalizeManagerUserIdList(parsedValues);
}

function resolveObjectManagerAssignment(payload, currentObject = null) {
  const hasManagerUserIds = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerUserIds'));
  const hasManagerUserId = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerUserId'));
  const hasManagerNames = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerNames'));
  const hasManagerName = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerName'));
  const currentSnapshot = currentObject ? getObjectManagerSnapshot(currentObject) : {
    managerUserIds: [],
    managerNames: [],
    primaryManagerUserId: null,
    displayManagerName: '',
  };

  if (!hasManagerUserIds && !hasManagerUserId && !hasManagerNames && !hasManagerName) {
    return {
      managerUserIds: [...currentSnapshot.managerUserIds],
      managerNames: [...currentSnapshot.managerNames],
      managerUserId: currentSnapshot.primaryManagerUserId,
      managerName: currentSnapshot.displayManagerName,
    };
  }

  const requestedManagerUserIds = hasManagerUserIds
    ? parseOptionalReferenceIdList(
      payload.managerUserIds,
      'Выберите корректного руководителя из списка пользователей.'
    )
    : (hasManagerUserId
      ? parseOptionalReferenceIdList(
        payload.managerUserId,
        'Выберите корректного руководителя из списка пользователей.'
      )
      : []);
  const requestedManagerNames = validateObjectManagerNames(
    payload,
    []
  );
  const projectUsers = getProjectAccessUsersStmt.all();
  const managerUserIds = [];
  const managerNames = [];
  const seenUserIds = new Set();
  const seenManagerKeys = new Set();

  const addManager = (userId, managerName) => {
    const normalizedUserId = Number(userId || 0);
    const normalizedManagerName = normalizeEmployeeShortName(managerName);
    if (normalizedUserId > 0 && !seenUserIds.has(normalizedUserId)) {
      seenUserIds.add(normalizedUserId);
      managerUserIds.push(normalizedUserId);
    }
    if (!normalizedManagerName) {
      return;
    }

    const identityKey = buildManagerIdentityKey(normalizedManagerName);
    if (seenManagerKeys.has(identityKey)) {
      return;
    }

    seenManagerKeys.add(identityKey);
    managerNames.push(normalizedManagerName);
  };

  for (const requestedManagerUserId of requestedManagerUserIds) {
    const managerUser = getProjectAccessUserByIdStmt.get(requestedManagerUserId);
    if (!managerUser || !managerUser.is_active || !isProjectScopedUser(managerUser)) {
      throw new Error('Выберите активного пользователя с ролью Boss или Руководитель.');
    }

    addManager(
      managerUser.id,
      managerUser.employee_short_name || managerUser.display_name
    );
  }

  for (const requestedManagerName of requestedManagerNames) {
    const matchedUser = findProjectAccessUserByName(requestedManagerName, projectUsers);
    if (matchedUser) {
      addManager(
        matchedUser.id,
        matchedUser.employee_short_name || matchedUser.display_name
      );
      continue;
    }

    addManager(null, requestedManagerName);
  }

  return {
    managerUserIds,
    managerNames,
    managerUserId: managerUserIds[0] || null,
    managerName: joinManagerNames(managerNames),
  };
}

function assertUniqueObjectName(objectName, excludedObjectId = null) {
  const existing = getObjectByNameStmt.get(objectName);
  if (!existing || Number(existing.id) === Number(excludedObjectId)) {
    return;
  }

  if (!existing.is_active) {
    throw new Error('Объект с таким названием уже есть в архиве. Верните его из архива.');
  }

  throw new Error('Объект с таким названием уже существует.');
}

function validateEmployeePayload(payload) {
  const fullName = normalizeIncomingText(payload, 'fullName');
  const objectName = normalizeIncomingText(payload, 'objectName', DEFAULT_EMPLOYEE_OBJECT_NAME);
  const positionTitle = normalizeIncomingText(payload, 'positionTitle');

  if (!fullName) {
    throw new Error('ФИО обязательно.');
  }

  if (!positionTitle) {
    throw new Error('Должность обязательна.');
  }

  return { fullName, objectName, positionTitle };
}

function parseReferenceId(value, errorMessage) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 1) {
    throw new Error(errorMessage);
  }
  return numericValue;
}

function validateUserLogin(payload, fallbackLogin = '') {
  const login = normalizeCredential(payload?.login ?? fallbackLogin);
  if (!login) {
    throw new Error('Логин обязателен.');
  }

  if (!/^[a-z0-9._-]{3,64}$/i.test(login)) {
    throw new Error('Логин должен содержать от 3 до 64 символов: буквы, цифры, точку, дефис или _.');
  }

  return login;
}

function validateUserPassword(value, { required = false } = {}) {
  const password = String(value ?? '');
  if (!password.trim()) {
    if (required) {
      throw new Error('Пароль обязателен.');
    }
    return '';
  }

  if (password.length < 8) {
    throw new Error('Пароль должен содержать минимум 8 символов.');
  }

  return password;
}

function validateUserRoleCode(value, fallbackRoleCode = '') {
  const roleCode = normalizeRoleCode(value, fallbackRoleCode);
  if (!roleCode) {
    throw new Error('Выберите корректную роль пользователя.');
  }

  return roleCode;
}

function ensureUniqueAuthLogin(login, excludedUserId = null) {
  const existing = getAuthUserByLoginStmt.get(login);
  if (existing && Number(existing.id) !== Number(excludedUserId)) {
    throw new Error('Пользователь с таким логином уже существует.');
  }
}

function validateUserAccountPayload(payload, currentUser = null, options = {}) {
  const requirePassword = Boolean(options.requirePassword);
  const login = validateUserLogin(payload, currentUser?.login || '');
  const displayName = normalizeIncomingText(payload, 'displayName', currentUser?.display_name || currentUser?.displayName || '');
  if (!displayName) {
    throw new Error('Имя пользователя обязательно.');
  }

  const employeeShortName = normalizeEmployeeShortName(
    payload && Object.prototype.hasOwnProperty.call(payload, 'employeeShortName')
      ? payload.employeeShortName
      : (currentUser?.employee_short_name || currentUser?.employeeShortName || displayName)
  );
  if (!employeeShortName) {
    throw new Error('Краткое ФИО сотрудника обязательно.');
  }

  const roleCode = validateUserRoleCode(payload?.roleCode, currentUser?.role_code || currentUser?.roleCode || '');
  const isActive = typeof payload?.isActive === 'boolean'
    ? payload.isActive
    : Boolean(currentUser?.is_active ?? currentUser?.isActive ?? true);
  const password = validateUserPassword(payload?.password, { required: requirePassword });

  return {
    login,
    displayName,
    employeeShortName,
    roleCode,
    isActive,
    password,
  };
}

function assertUniqueFullName(fullName, excludedEmployeeId = null) {
  const existing = getEmployeeByFullNameStmt.get(fullName);
  if (existing && Number(existing.id) !== Number(excludedEmployeeId)) {
    throw new Error('Сотрудник с таким ФИО уже существует.');
  }
}

function assertAdminAccess(actorUser) {
  assertAccessAllowed(isAdminUser(actorUser));
}

function assertCanLeaveAtLeastOneActiveAdmin(excludedUserId = null) {
  const count = Number(countActiveAdminsStmt.get(excludedUserId ?? null, excludedUserId ?? null)?.count || 0);
  if (count < 1) {
    throw new Error('В системе должен оставаться хотя бы один активный администратор.');
  }
}

function assertCanAccessEmployeeAssignment(actorUser, employeeRow, targetObjectRow, existingRecord = null) {
  if (isAdminUser(actorUser)) {
    return;
  }

  assertAccessAllowed(
    canAccessObjectForScopedUser(actorUser, targetObjectRow.manager_name, targetObjectRow.manager_user_id)
  );

  if (existingRecord) {
    assertAccessAllowed(canAccessKpiRecord(actorUser, existingRecord));
    return;
  }

  const currentObjectAccessible =
    isEmployeeObjectUnassigned(employeeRow) ||
    canAccessObjectForScopedUser(actorUser, employeeRow.manager_name, employeeRow.manager_user_id);
  assertAccessAllowed(currentObjectAccessible);
}

function assertCanManageKpiRecord(actorUser, recordId) {
  const recordScope = getKpiRecordAccessByIdStmt.get(recordId);
  if (!recordScope) {
    throw new Error('Строка KPI не найдена.');
  }

  assertAccessAllowed(canAccessKpiRecord(actorUser, recordScope));
  return recordScope;
}

function createEmployee(payload, actorUser) {
  assertAdminAccess(actorUser);
  const { fullName, objectName, positionTitle } = validateEmployeePayload(payload);
  const periodRow = getPeriodRow(payload.periodCode);

  if (!periodRow) {
    throw new Error('Не найден период KPI для создания сотрудника.');
  }

  return withTransaction(() => {
    assertUniqueFullName(fullName, null);
    const objectRow = ensureActiveObject(objectName);
    const employeeInsert = insertEmployeeStmt.run(fullName, positionTitle, objectRow.id);
    const employeeId = Number(employeeInsert.lastInsertRowid);

    const recordId = createEmployeeRecordWithSnapshots(
      periodRow.id,
      employeeId,
      objectRow.id,
      positionTitle,
      actorUser
    );

    writeActionLog(actorUser, 'create', 'employee', employeeId, 'Создан сотрудник и стартовая KPI-запись.', {
      employeeId,
      recordId,
      periodCode: periodRow.code,
      objectId: objectRow.id,
    });

    return {
      employeeId,
      periodCode: periodRow.code,
    };
  });
}

function createEmployeeRecord(payload, actorUser) {
  const periodRow = getPeriodRow(payload?.periodCode);
  if (!periodRow) {
    throw new Error('Не найден период KPI для назначения объекта сотруднику.');
  }

  const employeeId = parseReferenceId(payload?.employeeId, 'Выберите сотрудника из справочника.');
  const objectId = parseReferenceId(payload?.objectId, 'Выберите объект из справочника.');

  const employeeRow = getEmployeeCoreStmt.get(employeeId);
  if (!employeeRow) {
    throw new Error('Сотрудник не найден.');
  }
  if (!employeeRow.is_active) {
    throw new Error('Сотрудник находится в архиве. Верните его на листе "Сотрудники".');
  }

  const objectRow = getObjectCoreStmt.get(objectId);
  if (!objectRow) {
    throw new Error('Объект не найден.');
  }
  if (!objectRow.is_active) {
    throw new Error('Объект находится в архиве. Верните его на листе "Объекты".');
  }

  return withTransaction(() => {
    const existingRecord = getEmployeeRecordByPeriodStmt.get(periodRow.id, employeeId);
    assertCanAccessEmployeeAssignment(actorUser, employeeRow, objectRow, existingRecord);
    const previousEmployeeObjectId =
      employeeRow.current_object_id === null || employeeRow.current_object_id === undefined
        ? null
        : Number(employeeRow.current_object_id);
    const employeeObjectChanged = previousEmployeeObjectId !== objectId;

    if (employeeObjectChanged) {
      updateEmployeeCurrentObjectStmt.run(objectId, employeeId);
    }

    if (existingRecord) {
      const recordId = Number(existingRecord.id);
      const previousObjectId =
        existingRecord.object_id === null || existingRecord.object_id === undefined
          ? null
          : Number(existingRecord.object_id);
      const periodObjectChanged = previousObjectId !== objectId;
      const canSyncOpenRecord = periodRow.status === 'open';
      const syncResult = canSyncOpenRecord
        ? syncRecordScopeToEmployee(existingRecord, employeeRow, objectId, actorUser)
        : { updated: false, objectChanged: false, positionChanged: false, approvalReset: false };
      const action = canSyncOpenRecord
        ? syncResult.positionChanged
          ? 'profile-updated'
          : syncResult.objectChanged
            ? 'reassigned'
            : employeeObjectChanged
              ? 'employee-updated'
              : 'unchanged'
        : periodObjectChanged
          ? 'reassigned'
          : employeeObjectChanged
            ? 'employee-updated'
            : 'unchanged';

      if (!canSyncOpenRecord && periodObjectChanged) {
        updateEmployeeRecordObjectByIdStmt.run(objectId, actorUser.id, recordId);
        resetEmployeeRecordApprovalStmt.run(actorUser.id, recordId);
      }

      writeActionLog(actorUser, 'update', 'employee_kpi_record', recordId, 'Назначение объекта сотруднику обновлено.', {
        employeeId,
        objectId,
        previousObjectId,
        previousEmployeeObjectId,
        periodCode: periodRow.code,
        action,
        positionTitle: employeeRow.position_title,
      });

      return {
        recordId,
        employeeId,
        objectId,
        previousObjectId,
        previousEmployeeObjectId,
        periodCode: periodRow.code,
        action,
        employeeObjectChanged,
        periodObjectChanged: canSyncOpenRecord ? syncResult.objectChanged : periodObjectChanged,
        positionChanged: canSyncOpenRecord ? syncResult.positionChanged : false,
        approvalReset: canSyncOpenRecord
          ? syncResult.approvalReset
          : periodObjectChanged && Boolean(existingRecord.is_approved),
      };
    }

    const recordId = createEmployeeRecordWithSnapshots(
      periodRow.id,
      employeeId,
      objectId,
      employeeRow.position_title,
      actorUser
    );

    writeActionLog(actorUser, 'create', 'employee_kpi_record', recordId, 'Создана KPI-запись сотрудника.', {
      employeeId,
      objectId,
      previousEmployeeObjectId,
      periodCode: periodRow.code,
      positionTitle: employeeRow.position_title,
    });

    return {
      recordId,
      employeeId,
      objectId,
      previousEmployeeObjectId,
      periodCode: periodRow.code,
      action: 'assigned',
      employeeObjectChanged,
      periodObjectChanged: false,
      approvalReset: false,
    };
  });
}

function copyPeriodData(payload, actorUser) {
  assertAdminAccess(actorUser);
  const sourcePeriod = getPeriodRow(payload?.sourcePeriodCode);
  if (!sourcePeriod) {
    throw new Error('Не найден период-источник для копирования.');
  }

  const targetPeriod = getPeriodRow(payload?.targetPeriodCode);
  if (!targetPeriod) {
    throw new Error('Не найден период назначения для копирования.');
  }

  if (sourcePeriod.code === targetPeriod.code) {
    throw new Error('Периоды источника и назначения должны отличаться.');
  }

  return withTransaction(() => {
    const sourceRecords = getEmployeeRecordsForPeriodStmt.all(sourcePeriod.id);
    const sourceProjectManagerImportRows = Number(getProjectManagerImportRowsCountByPeriodStmt.get(sourcePeriod.id)?.count || 0);
    let createdCount = 0;
    let updatedCount = 0;
    let metricValuesCopied = 0;

    for (const sourceRecord of sourceRecords) {
      const existingTargetRecord = getEmployeeRecordByPeriodStmt.get(targetPeriod.id, sourceRecord.employee_id);
      let targetRecordId = null;

      if (existingTargetRecord) {
        targetRecordId = Number(existingTargetRecord.id);
        updateCopiedEmployeeRecordStmt.run(
          sourceRecord.object_id,
          sourceRecord.position_title_snapshot,
          sourceRecord.salary_rub,
          actorUser.id,
          'draft',
          sourceRecord.note || null,
          targetRecordId
        );
        deleteMetricValuesByRecordStmt.run(targetRecordId);
        updatedCount += 1;
      } else {
        const insertResult = insertCopiedEmployeeRecordStmt.run(
          targetPeriod.id,
          sourceRecord.employee_id,
          sourceRecord.object_id,
          sourceRecord.position_title_snapshot,
          sourceRecord.created_by_user_id || actorUser.id,
          actorUser.id,
          'draft',
          sourceRecord.salary_rub,
          sourceRecord.note || null
        );
        targetRecordId = Number(insertResult.lastInsertRowid);
        createdCount += 1;
      }

      const metricValues = getMetricValuesByRecordStmt.all(sourceRecord.id);
      for (const metricValue of metricValues) {
        insertCopiedMetricValueStmt.run(
          ...buildMetricSnapshotInsertValues(targetRecordId, mapStoredMetricSnapshotRow(metricValue))
        );
        metricValuesCopied += 1;
      }
    }

    deleteProjectManagerImportRowsByPeriodStmt.run(targetPeriod.id);
    if (sourceProjectManagerImportRows > 0) {
      copyProjectManagerImportRowsToPeriodStmt.run(targetPeriod.id, sourcePeriod.id);
    }

    writeActionLog(actorUser, 'copy', 'kpi_period', targetPeriod.code, 'Скопированы KPI-данные между периодами.', {
      sourcePeriodCode: sourcePeriod.code,
      targetPeriodCode: targetPeriod.code,
      createdCount,
      updatedCount,
      metricValuesCopied,
      projectManagerImportRowsCopied: sourceProjectManagerImportRows,
    });

    return {
      sourcePeriodCode: sourcePeriod.code,
      sourcePeriodLabel: sourcePeriod.label,
      targetPeriodCode: targetPeriod.code,
      targetPeriodLabel: targetPeriod.label,
      totalEmployees: sourceRecords.length,
      createdCount,
      updatedCount,
      metricValuesCopied,
      projectManagerImportRowsCopied: sourceProjectManagerImportRows,
      approvalReset: true,
    };
  });
}

function clonePeriodDataInternal(sourcePeriod, targetPeriod, actorUser, options = {}) {
  const actionType = String(options.actionType || 'copy').trim() || 'copy';
  const logMessage = String(options.logMessage || 'Copied KPI data between periods.');
  const isAutomatic = Boolean(options.automatic);
  const sourceRecords = getEmployeeRecordsForPeriodStmt.all(sourcePeriod.id);
  const sourceProjectManagerImportRows = Number(getProjectManagerImportRowsCountByPeriodStmt.get(sourcePeriod.id)?.count || 0);
  let createdCount = 0;
  let updatedCount = 0;
  let metricValuesCopied = 0;

  for (const sourceRecord of sourceRecords) {
    const existingTargetRecord = getEmployeeRecordByPeriodStmt.get(targetPeriod.id, sourceRecord.employee_id);
    let targetRecordId = null;

    if (existingTargetRecord) {
      targetRecordId = Number(existingTargetRecord.id);
        updateCopiedEmployeeRecordStmt.run(
          sourceRecord.object_id,
          sourceRecord.position_title_snapshot,
          sourceRecord.salary_rub,
          actorUser.id,
          'draft',
        sourceRecord.note || null,
        targetRecordId
      );
      deleteMetricValuesByRecordStmt.run(targetRecordId);
      updatedCount += 1;
    } else {
        const insertResult = insertCopiedEmployeeRecordStmt.run(
          targetPeriod.id,
          sourceRecord.employee_id,
          sourceRecord.object_id,
          sourceRecord.position_title_snapshot,
          sourceRecord.created_by_user_id || actorUser.id,
          actorUser.id,
          'draft',
        sourceRecord.salary_rub,
        sourceRecord.note || null
      );
      targetRecordId = Number(insertResult.lastInsertRowid);
      createdCount += 1;
    }

    const metricValues = getMetricValuesByRecordStmt.all(sourceRecord.id);
    for (const metricValue of metricValues) {
      insertCopiedMetricValueStmt.run(
        ...buildMetricSnapshotInsertValues(targetRecordId, mapStoredMetricSnapshotRow(metricValue))
      );
      metricValuesCopied += 1;
    }
  }

  deleteProjectManagerImportRowsByPeriodStmt.run(targetPeriod.id);
  if (sourceProjectManagerImportRows > 0) {
    copyProjectManagerImportRowsToPeriodStmt.run(targetPeriod.id, sourcePeriod.id);
  }

  writeActionLog(actorUser, actionType, 'kpi_period', targetPeriod.code, logMessage, {
    sourcePeriodCode: sourcePeriod.code,
    targetPeriodCode: targetPeriod.code,
    createdCount,
    updatedCount,
    metricValuesCopied,
    projectManagerImportRowsCopied: sourceProjectManagerImportRows,
    automatic: isAutomatic,
  });

  return {
    sourcePeriodCode: sourcePeriod.code,
    sourcePeriodLabel: sourcePeriod.label,
    targetPeriodCode: targetPeriod.code,
    targetPeriodLabel: targetPeriod.label,
    totalEmployees: sourceRecords.length,
    createdCount,
    updatedCount,
    metricValuesCopied,
    projectManagerImportRowsCopied: sourceProjectManagerImportRows,
    approvalReset: true,
    automatic: isAutomatic,
  };
}

function seedPeriodDataFromPreviousPeriod(periodRow, actorUser, visitedPeriodCodes = new Set()) {
  const periodCode = normalizeText(periodRow?.code);
  if (!periodCode || visitedPeriodCodes.has(periodCode)) {
    return null;
  }

  visitedPeriodCodes.add(periodCode);

  const targetRecordCount = Number(getEmployeeRecordCountByPeriodStmt.get(periodRow.id)?.count || 0);
  if (targetRecordCount > 0 || !canAutoSeedPeriodFromPrevious(periodRow)) {
    return null;
  }

  const previousPeriod = getPreviousPeriodRow(periodRow);
  if (!previousPeriod) {
    return null;
  }

  seedPeriodDataFromPreviousPeriod(previousPeriod, actorUser, visitedPeriodCodes);

  const sourceRecordCount = Number(getEmployeeRecordCountByPeriodStmt.get(previousPeriod.id)?.count || 0);
  if (sourceRecordCount <= 0) {
    return null;
  }

  return clonePeriodDataInternal(previousPeriod, periodRow, actorUser, {
    actionType: 'auto_seed',
    logMessage: 'Automatically seeded KPI data from the previous month.',
    automatic: true,
  });
}

function ensurePeriodDataAvailable(periodCode, actorUser) {
  const periodRow = getPeriodRow(periodCode);
  if (!periodRow) {
    return null;
  }

  return withTransaction(() => seedPeriodDataFromPreviousPeriod(periodRow, actorUser, new Set()));
}

function copyPeriodDataV2(payload, actorUser) {
  assertAdminAccess(actorUser);
  const sourcePeriod = getPeriodRow(payload?.sourcePeriodCode);
  if (!sourcePeriod) {
    throw new Error('Period source was not found.');
  }

  const targetPeriod = getPeriodRow(payload?.targetPeriodCode);
  if (!targetPeriod) {
    throw new Error('Period target was not found.');
  }

  if (sourcePeriod.code === targetPeriod.code) {
    throw new Error('Source and target periods must be different.');
  }

  return withTransaction(() => clonePeriodDataInternal(sourcePeriod, targetPeriod, actorUser));
}

function updateEmployee(employeeId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const current = getEmployeeCoreStmt.get(employeeId);
  if (!current) {
    throw new Error('Сотрудник не найден.');
  }

  const requestedFullName = normalizeIncomingText(payload, 'fullName', current.full_name);
  if (requestedFullName !== normalizeText(current.full_name)) {
    throw new Error('ФИО нельзя менять после создания сотрудника.');
  }

  const objectName = normalizeIncomingText(payload, 'objectName', current.object_name);
  const positionTitle = normalizeIncomingText(payload, 'positionTitle', current.position_title);

  if (!objectName) {
    throw new Error('Название объекта обязательно.');
  }

  if (!positionTitle) {
    throw new Error('Должность обязательна.');
  }

  return withTransaction(() => {
    const currentObjectName = normalizeText(current.object_name);
    const objectRow = objectName === currentObjectName
      ? { id: current.current_object_id }
      : ensureActiveObject(objectName);
    const positionChanged = normalizeText(current.position_title) !== normalizeText(positionTitle);
    const objectChanged = Number(current.current_object_id || 0) !== Number(objectRow.id || 0);
    const syncOpenPeriods = Boolean(payload?.syncOpenPeriods);
    let updatedOpenRecordCount = 0;
    let rebuiltOpenRecordCount = 0;
    let approvalResetCount = 0;

    updateEmployeeCoreStmt.run(positionTitle, objectRow.id, employeeId);

    if (syncOpenPeriods && (positionChanged || objectChanged)) {
      const desiredEmployeeRow = {
        ...current,
        position_title: positionTitle,
      };

      for (const recordRow of getEmployeeOpenRecordsByEmployeeStmt.all(employeeId)) {
        const syncResult = syncRecordScopeToEmployee(recordRow, desiredEmployeeRow, objectRow.id, actorUser);
        if (!syncResult.updated) {
          continue;
        }

        updatedOpenRecordCount += 1;
        rebuiltOpenRecordCount += syncResult.positionChanged ? 1 : 0;
        approvalResetCount += syncResult.approvalReset ? 1 : 0;
      }
    }
    if (typeof payload.isActive === 'boolean') {
      updateEmployeeActiveStmt.run(payload.isActive ? 1 : 0, employeeId);
    }

    writeActionLog(actorUser, 'update', 'employee', employeeId, 'Данные сотрудника обновлены.', {
      employeeId,
      objectId: objectRow.id,
      positionTitle,
      positionChanged,
      objectChanged,
      syncOpenPeriods,
      updatedOpenRecordCount,
      rebuiltOpenRecordCount,
      approvalResetCount,
      isActive: typeof payload.isActive === 'boolean' ? payload.isActive : Boolean(current.is_active),
    });

    return {
      employeeId,
    };
  });
}

function updateEmployeePositionForPeriod(employeeId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const current = getEmployeeCoreStmt.get(employeeId);
  if (!current) {
    throw new Error('РЎРѕС‚СЂСѓРґРЅРёРє РЅРµ РЅР°Р№РґРµРЅ.');
  }

  const requestedPeriodCode = normalizeText(payload?.periodCode);
  if (!requestedPeriodCode) {
    throw new Error('Р’С‹Р±РµСЂРёС‚Рµ KPI-РїРµСЂРёРѕРґ.');
  }

  const periodRow = getPeriodRow(requestedPeriodCode);
  if (!periodRow) {
    throw new Error('KPI-РїРµСЂРёРѕРґ РЅРµ РЅР°Р№РґРµРЅ.');
  }

  if (String(periodRow.status) !== 'open') {
    throw new Error('РЎРјРµРЅР° РґРѕР»Р¶РЅРѕСЃС‚Рё С‡РµСЂРµР· СЌС‚РѕС‚ РјРµС…Р°РЅРёР·Рј РґРѕСЃС‚СѓРїРЅР° С‚РѕР»СЊРєРѕ РІ РѕС‚РєСЂС‹С‚РѕРј KPI-РїРµСЂРёРѕРґРµ.');
  }

  const positionTitle = normalizeIncomingText(payload, 'positionTitle', current.position_title);
  if (!positionTitle) {
    throw new Error('Р”РѕР»Р¶РЅРѕСЃС‚СЊ РѕР±СЏР·Р°С‚РµР»СЊРЅР°.');
  }

  return withTransaction(() => {
    let recordRow = getEmployeeRecordByPeriodStmt.get(periodRow.id, employeeId);
    const positionChangedInRecord = recordRow
      ? normalizeText(recordRow.position_title_snapshot) !== normalizeText(positionTitle)
      : true;

    if (!recordRow) {
      const objectId = Number(current.current_object_id || 0);
      if (!objectId) {
        throw new Error('Р”Р»СЏ СЃРѕС‚СЂСѓРґРЅРёРєР° РЅРµ Р·Р°РґР°РЅ С‚РµРєСѓС‰РёР№ РѕР±СЉРµРєС‚. РЎРЅР°С‡Р°Р»Р° РЅР°Р·РЅР°С‡СЊС‚Рµ РѕР±СЉРµРєС‚ РІ KPI.');
      }

      const recordId = createEmployeeRecordWithSnapshots(
        periodRow.id,
        employeeId,
        objectId,
        positionTitle,
        actorUser
      );

      writeActionLog(actorUser, 'create', 'employee_kpi_record', recordId, 'РЎРѕР·РґР°РЅР° KPI-Р·Р°РїРёСЃСЊ РґР»СЏ РїРµСЂРёРѕРґР° РїСЂРё СЃРјРµРЅРµ РґРѕР»Р¶РЅРѕСЃС‚Рё.', {
        employeeId,
        periodCode: periodRow.code,
        positionTitle,
        objectId,
      });

      return {
        employeeId,
        periodCode: periodRow.code,
        periodLabel: periodRow.label,
        positionTitle,
        recordId,
        action: 'created',
        positionChanged: true,
        approvalReset: false,
      };
    }

    const desiredEmployeeRow = {
      ...current,
      position_title: positionTitle,
    };
    const syncResult = syncRecordScopeToEmployee(recordRow, desiredEmployeeRow, recordRow.object_id, actorUser);

    writeActionLog(actorUser, 'update', 'employee_kpi_record', recordRow.id, 'Р”РѕР»Р¶РЅРѕСЃС‚СЊ СЃРѕС‚СЂСѓРґРЅРёРєР° РѕР±РЅРѕРІР»РµРЅР° РґР»СЏ РІС‹Р±СЂР°РЅРЅРѕРіРѕ KPI-РїРµСЂРёРѕРґР°.', {
      employeeId,
      periodCode: periodRow.code,
      positionTitle,
      previousPositionTitle: recordRow.position_title_snapshot,
      positionChanged: syncResult.positionChanged,
      approvalReset: syncResult.approvalReset,
    });

    return {
      employeeId,
      periodCode: periodRow.code,
      periodLabel: periodRow.label,
      positionTitle,
      recordId: Number(recordRow.id),
      action: syncResult.updated ? 'updated' : 'unchanged',
      positionChanged: syncResult.positionChanged || positionChangedInRecord,
      approvalReset: syncResult.approvalReset,
    };
  });
}

function parseMetricRawValue(value, currentMetric) {
  const normalizedValue = String(value ?? '').trim().replace(',', '.');
  const numericValue = Number(normalizedValue);

  if (!Number.isFinite(numericValue)) {
    throw new Error('Значение показателя должно быть числом.');
  }

  const minValue = Number(currentMetric.min_value ?? 0);
  const maxValue = Number(currentMetric.max_value ?? 0);
  if (numericValue < minValue || numericValue > maxValue) {
    if (currentMetric.input_type === 'score') {
      throw new Error('Оценка должна быть в диапазоне от 0 до 5.');
    }
    throw new Error(`Факт должен быть в диапазоне от ${minValue} до ${maxValue}.`);
  }

  return numericValue;
}

function parseMetricAgreedPercent(value, groupMaxPercent) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === '') {
    return null;
  }

  const normalizedValue = String(value).trim().replace(',', '.');
  const numericValue = Number(normalizedValue);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > Number(groupMaxPercent || 40)) {
    throw new Error(`Согл.% должен быть в диапазоне от 0 до ${Number(groupMaxPercent || 40)}.`);
  }

  return numericValue;
}

function updateEmployeeMetricValue(recordId, metricId, payload, actorUser) {
  const currentMetric = getEmployeeMetricValueStmt.get(recordId, metricId);
  if (!currentMetric || !currentMetric.is_active) {
    throw new Error('Строка KPI не найдена.');
  }

  assertCanManageKpiRecord(actorUser, recordId);

  const hasRawValue = Object.prototype.hasOwnProperty.call(payload || {}, 'rawValue');
  const hasAgreedPercent = Object.prototype.hasOwnProperty.call(payload || {}, 'agreedPercent');
  if (!hasRawValue && !hasAgreedPercent) {
    throw new Error('Нет данных для обновления строки KPI.');
  }

  const rawValue = hasRawValue
    ? parseMetricRawValue(payload.rawValue, currentMetric)
    : Number(currentMetric.raw_value);
  const agreedPercent = hasAgreedPercent
    ? parseMetricAgreedPercent(payload.agreedPercent, currentMetric.group_max_percent)
    : currentMetric.agreed_percent;

  return withTransaction(() => {
    updateEmployeeMetricValueStmt.run(rawValue, agreedPercent, recordId, metricId);
    resetEmployeeRecordApprovalStmt.run(actorUser.id, recordId);
    writeActionLog(actorUser, 'update', 'employee_kpi_metric_value', `${recordId}:${metricId}`, 'Изменено значение KPI-показателя.', {
      recordId,
      metricId,
      rawValue,
      agreedPercent,
    });
    return {
      recordId,
      metricId,
    };
  });
}

function approveEmployeeRecord(recordId, actorUser) {
  const currentRecord = getEmployeeRecordApprovalBaseStmt.get(recordId);
  if (!currentRecord) {
    throw new Error('Строка KPI не найдена.');
  }

  assertAccessAllowed(canAccessKpiRecord(actorUser, currentRecord));

  return withTransaction(() => {
    approveEmployeeRecordStmt.run(currentRecord.effective_total_percent, actorUser.id, recordId);
    writeActionLog(actorUser, 'approve', 'employee_kpi_record', recordId, 'KPI-карточка согласована.', {
      recordId,
      agreedTotalPercent: currentRecord.effective_total_percent,
    });
    return {
      recordId,
      agreedTotalPercent: currentRecord.effective_total_percent,
      isApproved: true,
    };
  });
}

function unapproveEmployeeRecord(recordId, actorUser) {
  const currentRecord = getEmployeeRecordApprovalBaseStmt.get(recordId);
  if (!currentRecord) {
    throw new Error('Строка KPI не найдена.');
  }

  assertAccessAllowed(canAccessKpiRecord(actorUser, currentRecord));

  return withTransaction(() => {
    resetEmployeeRecordApprovalStmt.run(actorUser.id, recordId);
    writeActionLog(actorUser, 'unapprove', 'employee_kpi_record', recordId, 'Согласование KPI-карточки снято.', {
      recordId,
    });
    return {
      recordId,
      agreedTotalPercent: null,
      isApproved: false,
    };
  });
}

function deleteEmployee(employeeId, actorUser) {
  assertAdminAccess(actorUser);
  const current = getEmployeeCoreStmt.get(employeeId);
  if (!current) {
    throw new Error('Сотрудник не найден.');
  }

  return withTransaction(() => {
    deleteEmployeeRecordsStmt.run(employeeId);
    deleteEmployeeStmt.run(employeeId);
    writeActionLog(actorUser, 'delete', 'employee', employeeId, 'Сотрудник удален из справочника.', {
      employeeId,
      fullName: current.full_name,
    });

    return {
      employeeId,
    };
  });
}

function createObjectEntry(payload, actorUser) {
  assertAdminAccess(actorUser);
  const objectName = validateObjectName(payload);
  const managerAssignment = resolveObjectManagerAssignment(payload);

  return withTransaction(() => {
    assertUniqueObjectName(objectName, null);
    const result = insertObjectStmt.run(
      objectName,
      managerAssignment.managerName || null,
      managerAssignment.managerUserId
    );
    const objectId = Number(result.lastInsertRowid);
    replaceObjectManagerAssignments(objectId, managerAssignment.managerUserIds);
    writeActionLog(actorUser, 'create', 'object', objectId, 'Объект добавлен в справочник.', {
      objectId,
      objectName,
      managerName: managerAssignment.managerName || null,
      managerUserId: managerAssignment.managerUserId,
      managerNames: managerAssignment.managerNames,
      managerUserIds: managerAssignment.managerUserIds,
    });
    return {
      objectId,
    };
  });
}

function updateObjectEntry(objectId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const current = getObjectCoreStmt.get(objectId);
  if (!current) {
    throw new Error('Объект не найден.');
  }

  const objectName = validateObjectName(payload, current.name);
  const managerAssignment = resolveObjectManagerAssignment(payload, current);
  const isActive = typeof payload.isActive === 'boolean' ? payload.isActive : Boolean(current.is_active);

  return withTransaction(() => {
    assertUniqueObjectName(objectName, objectId);
    updateObjectStmt.run(
      objectName,
      managerAssignment.managerName || null,
      managerAssignment.managerUserId,
      isActive ? 1 : 0,
      objectId
    );
    replaceObjectManagerAssignments(objectId, managerAssignment.managerUserIds);
    writeActionLog(actorUser, 'update', 'object', objectId, 'Данные объекта обновлены.', {
      objectId,
      objectName,
      managerName: managerAssignment.managerName || null,
      managerUserId: managerAssignment.managerUserId,
      managerNames: managerAssignment.managerNames,
      managerUserIds: managerAssignment.managerUserIds,
      isActive,
    });
    return {
      objectId,
    };
  });
}

function deleteObjectEntry(objectId, actorUser) {
  assertAdminAccess(actorUser);
  const current = getObjectCoreStmt.get(objectId);
  if (!current) {
    throw new Error('Объект не найден.');
  }

  const usage = getObjectUsageStmt.get(objectId, objectId);
  if ((usage?.employees_count || 0) > 0 || (usage?.records_count || 0) > 0) {
    throw new Error('Объект нельзя удалить: он используется в сотрудниках или KPI-записях.');
  }

  return withTransaction(() => {
    deleteObjectStmt.run(objectId);
    writeActionLog(actorUser, 'delete', 'object', objectId, 'Объект удален из справочника.', {
      objectId,
      objectName: current.name,
    });
    return {
      objectId,
    };
  });
}

function listObjects(includeArchived) {
  return getObjectsDirectoryStmt.all(includeArchived ? 1 : 0).map((row) => {
    const managerSnapshot = getObjectManagerSnapshot(row);
    return {
      objectId: row.id,
      objectName: row.name,
      managerName: managerSnapshot.displayManagerName,
      managerUserId: managerSnapshot.primaryManagerUserId,
      managerNames: managerSnapshot.managerNames,
      managerUserIds: managerSnapshot.managerUserIds,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
    };
  });
}

function listStaff(includeArchived) {
  return getStaffDirectoryStmt.all(includeArchived ? 1 : 0).map((row) => ({
    employeeId: row.employee_id,
    fullName: row.full_name,
    positionTitle: row.position_title,
    objectId: row.object_id,
    objectName: row.object_name,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
  }));
}

function listReferenceData(actorUser) {
  const objects = getReferenceObjectsStmt.all()
    .filter((row) => (
      isAdminUser(actorUser) ||
      canAccessObjectForScopedUser(actorUser, row.manager_name, row.manager_user_id, row.id)
    ))
    .map((row) => ({
      objectId: row.id,
      objectName: row.name,
      managerName: row.manager_name,
      managerUserId: row.manager_user_id,
    }));

  const employees = getReferenceEmployeesStmt.all()
    .filter((row) => {
      if (isAdminUser(actorUser)) {
        return true;
      }

      return (
        isEmployeeObjectUnassigned(row) ||
        canAccessObjectForScopedUser(actorUser, row.manager_name, row.manager_user_id, row.current_object_id)
      );
    })
    .map((row) => ({
      employeeId: row.id,
      fullName: row.full_name,
      positionTitle: row.position_title,
      objectId: row.current_object_id,
      objectName: row.object_name,
      managerName: row.manager_name,
      managerUserId: row.manager_user_id,
    }));

  const positions = getReferencePositionsStmt.all().map((row) => row.position_title);
  const periods = getPeriodsStmt.all().map((row) => ({
    code: row.code,
    label: row.label,
    yearNum: row.year_num,
    monthNum: row.month_num,
    status: row.status,
  }));
  const projectUsers = isAdminUser(actorUser)
    ? getProjectAccessUsersStmt.all().map((row) => ({
        userId: row.id,
        displayName: row.display_name,
        employeeShortName: normalizeEmployeeShortName(row.employee_short_name || row.display_name),
        roleCode: normalizeRoleCode(row.role_code, ROLE_CODES.MANAGER),
        roleLabel: getRoleLabel(row.role_code),
      }))
    : [];

  return {
    objects,
    employees,
    positions,
    periods,
    projectUsers,
  };
}

function validateObjectManager(payload, fallbackManagerName = '') {
  return normalizeIncomingText(payload, 'managerName', fallbackManagerName);
}

function resolveObjectManagerAssignment(payload, currentObject = null) {
  const hasManagerEmployeeId = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerEmployeeId'));
  const hasManagerUserId = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerUserId'));
  const hasManagerName = Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'managerName'));
  const fallbackManagerUserId = currentObject?.manager_user_id ?? currentObject?.managerUserId ?? null;
  const fallbackManagerName = currentObject?.manager_name ?? currentObject?.managerName ?? '';

  if (!hasManagerEmployeeId && !hasManagerUserId && !hasManagerName) {
    return {
      managerUserId: fallbackManagerUserId ? Number(fallbackManagerUserId) : null,
      managerName: normalizeText(fallbackManagerName),
    };
  }

  const requestedManagerEmployeeId = hasManagerEmployeeId
    ? parseOptionalReferenceId(payload.managerEmployeeId, 'Выберите корректного руководителя из списка сотрудников.')
    : null;

  if (requestedManagerEmployeeId !== null) {
    const managerEmployee = getActiveEmployeeByIdStmt.get(requestedManagerEmployeeId);
    if (!managerEmployee || !managerEmployee.is_active) {
      throw new Error('Выберите активного сотрудника из списка сотрудников.');
    }

    const managerName = normalizeText(managerEmployee.full_name);
    const matchedUser = findProjectAccessUserByName(managerName, getProjectAccessUsersStmt.all());
    return {
      managerUserId: matchedUser ? Number(matchedUser.id) : null,
      managerName,
    };
  }

  const requestedManagerUserId = hasManagerUserId
    ? parseOptionalReferenceId(payload.managerUserId, 'Выберите корректного руководителя из списка пользователей.')
    : null;

  if (requestedManagerUserId !== null) {
    const managerUser = getProjectAccessUserByIdStmt.get(requestedManagerUserId);
    if (!managerUser || !managerUser.is_active || !isProjectScopedUser(managerUser)) {
      throw new Error('Выберите активного пользователя с ролью Boss или Руководитель.');
    }

    return {
      managerUserId: Number(managerUser.id),
      managerName: getPreferredManagerNameFromUser(managerUser),
    };
  }

  const managerName = validateObjectManager(payload, fallbackManagerName);
  if (!managerName) {
    return {
      managerUserId: null,
      managerName: '',
    };
  }

  const matchedUser = findProjectAccessUserByName(managerName, getProjectAccessUsersStmt.all());
  return {
    managerUserId: matchedUser ? Number(matchedUser.id) : null,
    managerName,
  };
}

function createObjectEntry(payload, actorUser) {
  assertAdminAccess(actorUser);
  const objectName = validateObjectName(payload);
  const managerAssignment = resolveObjectManagerAssignment(payload);

  return withTransaction(() => {
    assertUniqueObjectName(objectName, null);
    const result = insertObjectStmt.run(
      objectName,
      managerAssignment.managerName || null,
      managerAssignment.managerUserId
    );
    const objectId = Number(result.lastInsertRowid);
    writeActionLog(actorUser, 'create', 'object', objectId, 'Объект добавлен в справочник.', {
      objectId,
      objectName,
      managerName: managerAssignment.managerName || null,
      managerUserId: managerAssignment.managerUserId,
    });
    return {
      objectId,
    };
  });
}

function updateObjectEntry(objectId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const current = getObjectCoreStmt.get(objectId);
  if (!current) {
    throw new Error('Объект не найден.');
  }

  const objectName = validateObjectName(payload, current.name);
  const managerAssignment = resolveObjectManagerAssignment(payload, current);
  const isActive = typeof payload.isActive === 'boolean' ? payload.isActive : Boolean(current.is_active);

  return withTransaction(() => {
    assertUniqueObjectName(objectName, objectId);
    updateObjectStmt.run(
      objectName,
      managerAssignment.managerName || null,
      managerAssignment.managerUserId,
      isActive ? 1 : 0,
      objectId
    );
    writeActionLog(actorUser, 'update', 'object', objectId, 'Данные объекта обновлены.', {
      objectId,
      objectName,
      managerName: managerAssignment.managerName || null,
      managerUserId: managerAssignment.managerUserId,
      isActive,
    });
    return {
      objectId,
    };
  });
}

function listObjects(includeArchived, actorUser = null) {
  return getObjectsDirectoryStmt.all(includeArchived ? 1 : 0)
    .filter((row) => (
      !actorUser ||
      isAdminUser(actorUser) ||
      (
        canAccessObjectForScopedUser(actorUser, row.manager_name, row.manager_user_id)
        && (
          !isProjectScopedUser(actorUser)
          || Number(row.employees_count || 0) > 0
        )
      )
    ))
    .map((row) => ({
      objectId: row.id,
      objectName: row.name,
      managerName: row.manager_name,
      managerUserId: row.manager_user_id,
      employeesCount: Number(row.employees_count || 0),
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
    }));
}

function listReferenceData(actorUser) {
  const objects = getReferenceObjectsStmt.all()
    .filter((row) => isAdminUser(actorUser) || canAccessObjectForScopedUser(actorUser, row.manager_name, row.manager_user_id))
    .map((row) => ({
      objectId: row.id,
      objectName: row.name,
      managerName: row.manager_name,
      managerUserId: row.manager_user_id,
    }));

  const employees = getReferenceEmployeesStmt.all()
    .filter((row) => {
      if (isAdminUser(actorUser)) {
        return true;
      }

      return (
        isEmployeeObjectUnassigned(row) ||
        canAccessObjectForScopedUser(actorUser, row.manager_name, row.manager_user_id)
      );
    })
    .map((row) => ({
      employeeId: row.id,
      fullName: row.full_name,
      positionTitle: row.position_title,
      objectId: row.current_object_id,
      objectName: row.object_name,
      managerName: row.manager_name,
      managerUserId: row.manager_user_id,
    }));

  const positions = getReferencePositionsStmt.all().map((row) => row.position_title);
  const periods = getPeriodsStmt.all().map((row) => ({
    code: row.code,
    label: row.label,
    yearNum: row.year_num,
    monthNum: row.month_num,
    status: row.status,
  }));
  const projectUsers = isAdminUser(actorUser)
    ? getProjectAccessUsersStmt.all().map((row) => ({
        userId: row.id,
        displayName: row.display_name,
        employeeShortName: normalizeEmployeeShortName(row.employee_short_name || row.display_name),
        roleCode: normalizeRoleCode(row.role_code, ROLE_CODES.MANAGER),
        roleLabel: getRoleLabel(row.role_code),
      }))
    : [];

  return {
    objects,
    employees,
    positions,
    periods,
    projectUsers,
  };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function resolvePowerShellCommand() {
  const explicitCommand = String(process.env.POWERSHELL_BIN || '').trim();
  const windowsPowerShellPath = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  if (explicitCommand) {
    return explicitCommand;
  }

  return process.platform === 'win32' ? windowsPowerShellPath : 'pwsh';
}

function runExecutionDisciplineParser(workbookPath) {
  return parseExecutionDisciplineUpload(workbookPath);
  const result = spawnSync(
    POWERSHELL_COMMAND,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      EXECUTION_DISCIPLINE_PARSER_PATH,
      workbookPath,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Не удалось обработать Excel-файл.').trim());
  }

  return JSON.parse(stripBom(result.stdout));
}

function runContractApprovalsParser(workbookPath) {
  return parseContractApprovalsUpload(workbookPath);
  const result = spawnSync(
    POWERSHELL_COMMAND,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      CONTRACT_APPROVALS_PARSER_PATH,
      workbookPath,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Не удалось обработать Excel-файл.').trim());
  }

  return JSON.parse(stripBom(result.stdout));
}

function writeBase64UploadTempFile(fileName, fileContentBase64) {
  const normalizedFileName = path.basename(normalizeText(fileName) || 'upload.xlsx');
  const extension = path.extname(normalizedFileName).toLowerCase() || '.xlsx';
  if (!['.xlsx', '.xls', '.xlsm', '.xltx', '.xltm'].includes(extension)) {
    throw new Error('Поддерживаются только Excel-файлы формата .xlsx.');
  }

  if (!fileContentBase64) {
    throw new Error('Файл для загрузки не передан.');
  }

  let buffer;
  try {
    buffer = Buffer.from(String(fileContentBase64), 'base64');
  } catch {
    throw new Error('Не удалось прочитать содержимое файла.');
  }

  if (!buffer.length) {
    throw new Error('Файл пустой.');
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-discipline-upload-'));
  const tempPath = path.join(tempDir, normalizedFileName);
  fs.writeFileSync(tempPath, buffer);

  return {
    tempDir,
    tempPath,
    fileName: normalizedFileName,
  };
}

function parseExecutionDisciplinePercent(value) {
  const rawValue = String(value ?? '').trim();
  const normalized = rawValue.replace('%', '').replace(',', '.');
  let numericValue = Number(normalized);
  const looksLikeFraction = !rawValue.includes('%') && /[.,]/.test(rawValue) && numericValue >= 0 && numericValue <= 1;
  if (looksLikeFraction) {
    numericValue *= 100;
  }
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 100) {
    throw new Error('Значение % должно быть числом от 0 до 100.');
  }
  return numericValue;
}

function getRequiredUploadPeriodRow(periodCode, actorUser = null) {
  const normalizedPeriodCode = normalizeText(periodCode);
  if (!normalizedPeriodCode) {
    throw new Error('Не выбран месяц для загрузки.');
  }

  const periodRow = getPeriodRow(normalizedPeriodCode);
  if (!periodRow) {
    return null;
  }

  if (actorUser) {
    ensurePeriodDataAvailable(periodRow.code, actorUser);
    return getPeriodRow(periodRow.code);
  }

  return periodRow;
}

function importExecutionDisciplineValues(payload, actorUser) {
  assertAdminAccess(actorUser);
  const periodRow = getRequiredUploadPeriodRow(payload?.periodCode, actorUser);
  if (!periodRow) {
    throw new Error('Не найден период KPI для загрузки значений.');
  }

  const uploadFile = writeBase64UploadTempFile(payload?.fileName, payload?.fileContentBase64);

  try {
    const parsed = runExecutionDisciplineParser(uploadFile.tempPath);
    const sourceRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!sourceRows.length) {
      throw new Error('В Excel-файле не найдены строки для загрузки.');
    }

    return withTransaction(() => {
      const seenNames = new Set();
      const results = [];
      let updatedCount = 0;

      for (const sourceRow of sourceRows) {
        const fullName = normalizeText(sourceRow.fullName);
        const resultRow = {
          fullName,
          percent: sourceRow.percent,
          status: 'skipped',
          message: '',
        };

        if (!fullName) {
          resultRow.message = 'Не заполнено ФИО.';
          results.push(resultRow);
          continue;
        }

        if (seenNames.has(fullName.toLowerCase())) {
          resultRow.message = 'Дубликат ФИО в файле.';
          results.push(resultRow);
          continue;
        }
        seenNames.add(fullName.toLowerCase());

        let percentValue;
        try {
          percentValue = parseExecutionDisciplinePercent(sourceRow.percent);
        } catch (error) {
          resultRow.message = error.message;
          results.push(resultRow);
          continue;
        }

        const metricRows = getExecutionDisciplineMetricRowsStmt.all(periodRow.id, fullName);
        if (!metricRows.length) {
          resultRow.message = 'Для сотрудника нет KPI-строки "Исполнительская дисциплина" в выбранном периоде.';
          results.push(resultRow);
          continue;
        }

        for (const metricRow of metricRows) {
          updateEmployeeMetricValueStmt.run(percentValue, null, metricRow.record_id, metricRow.metric_id);
          resetEmployeeRecordApprovalStmt.run(actorUser.id, metricRow.record_id);
        }

        updatedCount += 1;
        resultRow.status = 'updated';
        resultRow.message = metricRows.length > 1
          ? `Обновлено строк: ${metricRows.length}.`
          : 'Обновлено.';
        resultRow.percent = percentValue;
        results.push(resultRow);
      }

      const summary = {
        importLabel: 'Исполнительская дисциплина',
        metricLabel: 'Исполнительская дисциплина',
        sheetName: parsed?.sheetName || '',
        periodCode: periodRow.code,
        periodLabel: periodRow.label,
        fileName: uploadFile.fileName,
        totalRows: results.length,
        updatedCount,
        skippedCount: results.length - updatedCount,
        results,
      };
      writeActionLog(actorUser, 'import', 'execution_discipline', uploadFile.fileName, 'Загружены значения исполнительской дисциплины.', {
        periodCode: periodRow.code,
        totalRows: summary.totalRows,
        updatedCount: summary.updatedCount,
        skippedCount: summary.skippedCount,
      });
      return summary;
    });
  } finally {
    fs.rmSync(uploadFile.tempDir, { recursive: true, force: true });
  }
}

function importContractApprovalValues(payload, actorUser) {
  assertAdminAccess(actorUser);
  const periodRow = getRequiredUploadPeriodRow(payload?.periodCode, actorUser);
  if (!periodRow) {
    throw new Error('Не найден период KPI для загрузки значений.');
  }

  const uploadFile = writeBase64UploadTempFile(payload?.fileName, payload?.fileContentBase64);

  try {
    const parsed = runContractApprovalsParser(uploadFile.tempPath);
    const sourceRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!sourceRows.length) {
      throw new Error('В Excel-файле не найдены строки для загрузки.');
    }

    return withTransaction(() => {
      const seenNames = new Set();
      const results = [];
      let updatedCount = 0;

      for (const sourceRow of sourceRows) {
        const fullName = normalizeText(sourceRow.fullName);
        const resultRow = {
          fullName,
          percent: sourceRow.percent,
          status: 'skipped',
          message: '',
        };

        if (!fullName) {
          resultRow.message = 'Не заполнено ФИО.';
          results.push(resultRow);
          continue;
        }

        if (seenNames.has(fullName.toLowerCase())) {
          resultRow.message = 'Дубликат ФИО в файле.';
          results.push(resultRow);
          continue;
        }
        seenNames.add(fullName.toLowerCase());

        let percentValue;
        try {
          percentValue = parseExecutionDisciplinePercent(sourceRow.percent);
        } catch (error) {
          resultRow.message = error.message;
          results.push(resultRow);
          continue;
        }

        const metricRows = getContractApprovalMetricRowsStmt.all(periodRow.id, fullName);
        if (!metricRows.length) {
          resultRow.message = 'Для сотрудника нет KPI-строки "Исполнение сроков согласования договоров" или "Соблюдение сроков заключения договоров" в выбранном периоде.';
          results.push(resultRow);
          continue;
        }

        for (const metricRow of metricRows) {
          updateEmployeeMetricValueStmt.run(percentValue, null, metricRow.record_id, metricRow.metric_id);
          resetEmployeeRecordApprovalStmt.run(actorUser.id, metricRow.record_id);
        }

        updatedCount += 1;
        resultRow.status = 'updated';
        resultRow.message = metricRows.length > 1
          ? `Обновлено строк: ${metricRows.length}.`
          : 'Обновлено.';
        resultRow.percent = percentValue;
        results.push(resultRow);
      }

      const summary = {
        importLabel: 'Согласование договоров',
        metricLabel: CONTRACT_APPROVAL_METRIC_NAMES.join(' / '),
        sheetName: parsed?.sheetName || '',
        periodCode: periodRow.code,
        periodLabel: periodRow.label,
        fileName: uploadFile.fileName,
        totalRows: results.length,
        updatedCount,
        skippedCount: results.length - updatedCount,
        results,
      };
      writeActionLog(actorUser, 'import', 'contract_approvals', uploadFile.fileName, 'Загружены значения по согласованию договоров.', {
        periodCode: periodRow.code,
        totalRows: summary.totalRows,
        updatedCount: summary.updatedCount,
        skippedCount: summary.skippedCount,
      });
      return summary;
    });
  } finally {
    fs.rmSync(uploadFile.tempDir, { recursive: true, force: true });
  }
}

const PROJECT_MANAGER_EXPORT_OBJECT_STOP_WORDS = new Set([
  'в',
  'г',
  'п',
  'ул',
  'им',
  'на',
  'по',
  'из',
  'для',
  'с',
  'смр',
  'этап',
  'очередь',
  'года',
]);

function runProjectManagerExportParser(workbookPath) {
  return parseProjectManagerExport(workbookPath);
}

function stripTrailingAnnotation(value) {
  return normalizeText(value).replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

function normalizeLookupKey(value) {
  return stripTrailingAnnotation(value)
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[."«»'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeObjectLookup(value) {
  return normalizeLookupKey(value)
    .split(' ')
    .filter((token) => token.length > 1 && !PROJECT_MANAGER_EXPORT_OBJECT_STOP_WORDS.has(token));
}

function buildEmployeeShortName(fullName) {
  const parts = normalizeText(stripTrailingAnnotation(fullName)).split(' ').filter(Boolean);
  if (parts.length < 2) {
    return normalizeText(fullName);
  }

  const initials = parts
    .slice(1)
    .map((part) => (part ? `${part[0].toUpperCase()}.` : ''))
    .join('');
  return `${parts[0]} ${initials}`.trim();
}

function isProjectManagerPosition(positionTitle) {
  return normalizeLookupKey(positionTitle) === normalizeLookupKey(PROJECT_MANAGER_POSITION_TITLE);
}

function pushLookupCandidate(map, key, value) {
  if (!key) {
    return;
  }

  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
}

function dedupeRowsById(rows) {
  const uniqueRows = [];
  const seenIds = new Set();

  for (const row of rows) {
    const rowId = Number(row?.id);
    if (!rowId || seenIds.has(rowId)) {
      continue;
    }
    seenIds.add(rowId);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

function scoreObjectNameMatch(sourceObjectName, candidateObjectName) {
  const sourceTokens = tokenizeObjectLookup(sourceObjectName);
  const candidateTokens = tokenizeObjectLookup(candidateObjectName);
  if (!sourceTokens.length || !candidateTokens.length) {
    return 0;
  }

  const candidateTokenSet = new Set(candidateTokens);
  const overlapCount = sourceTokens.filter((token) => candidateTokenSet.has(token)).length;
  return overlapCount / Math.max(sourceTokens.length, candidateTokens.length);
}

function resolveSourceObject(sourceObjectName, referenceObjects) {
  const normalizedSourceName = normalizeLookupKey(sourceObjectName);
  if (!normalizedSourceName) {
    return null;
  }

  const exactMatch = referenceObjects.find((row) => row.normalized_name === normalizedSourceName);
  if (exactMatch) {
    return exactMatch;
  }

  let bestMatch = null;
  let bestScore = 0;
  let secondBestScore = 0;

  for (const referenceObject of referenceObjects) {
    const matchScore = scoreObjectNameMatch(sourceObjectName, referenceObject.name);
    if (matchScore > bestScore) {
      secondBestScore = bestScore;
      bestScore = matchScore;
      bestMatch = referenceObject;
      continue;
    }
    if (matchScore > secondBestScore) {
      secondBestScore = matchScore;
    }
  }

  if (!bestMatch || bestScore < 0.55 || bestScore - secondBestScore < 0.2) {
    return null;
  }

  return bestMatch;
}

function buildProjectManagerLookupContext() {
  const referenceEmployees = getReferenceEmployeesStmt.all().map((row) => ({
    ...row,
    normalized_full_name: normalizeLookupKey(row.full_name),
    normalized_short_name: normalizeLookupKey(buildEmployeeShortName(row.full_name)),
    is_project_manager: isProjectManagerPosition(row.position_title),
  }));
  const referenceObjects = getReferenceObjectsStmt.all().map((row) => ({
    ...row,
    normalized_name: normalizeLookupKey(row.name),
  }));
  const projectManagersByShortName = new Map();
  const projectManagersByFullName = new Map();
  const projectManagersByObjectId = new Map();

  for (const employeeRow of referenceEmployees) {
    if (!employeeRow.is_project_manager) {
      continue;
    }

    pushLookupCandidate(projectManagersByShortName, employeeRow.normalized_short_name, employeeRow);
    pushLookupCandidate(projectManagersByFullName, employeeRow.normalized_full_name, employeeRow);

    const objectId = Number(employeeRow.current_object_id || 0);
    if (!objectId) {
      continue;
    }

    if (!projectManagersByObjectId.has(objectId)) {
      projectManagersByObjectId.set(objectId, []);
    }
    projectManagersByObjectId.get(objectId).push(employeeRow);
  }

  return {
    referenceEmployees,
    referenceObjects,
    projectManagersByShortName,
    projectManagersByFullName,
    projectManagersByObjectId,
  };
}

function resolveProjectManagerCandidates(context, managerKey) {
  return dedupeRowsById([
    ...(context.projectManagersByShortName.get(managerKey) || []),
    ...(context.projectManagersByFullName.get(managerKey) || []),
  ]);
}

function resolveProjectManagerEmployee(sourceObjectGroup, context) {
  const normalizedManagerKeys = Array.from(sourceObjectGroup.manager_names)
    .map((value) => normalizeLookupKey(value))
    .filter((value) => value && value !== '0');

  for (const managerKey of normalizedManagerKeys) {
    const candidates = resolveProjectManagerCandidates(context, managerKey);
    if (candidates.length === 1) {
      return {
        employeeRow: candidates[0],
        objectRow: resolveSourceObject(sourceObjectGroup.object_name, context.referenceObjects),
        resolution: 'manager_name',
      };
    }
  }

  const objectRow = resolveSourceObject(sourceObjectGroup.object_name, context.referenceObjects);
  if (objectRow) {
    const objectCandidates = dedupeRowsById(context.projectManagersByObjectId.get(Number(objectRow.id)) || []);
    if (objectCandidates.length === 1) {
      return {
        employeeRow: objectCandidates[0],
        objectRow,
        resolution: 'object_owner',
      };
    }

    const objectManagerKey = normalizeLookupKey(objectRow.manager_name);
    if (objectManagerKey) {
      const managerCandidates = resolveProjectManagerCandidates(context, objectManagerKey);
      if (managerCandidates.length === 1) {
        return {
          employeeRow: managerCandidates[0],
          objectRow,
          resolution: 'object_manager',
        };
      }
    }
  }

  const managerLabel = Array.from(sourceObjectGroup.manager_names).find((value) => normalizeLookupKey(value) && normalizeLookupKey(value) !== '0') || '';
  return {
    employeeRow: null,
    objectRow,
    resolution: '',
    message: managerLabel
      ? `Не удалось сопоставить руководителя "${managerLabel}" с активным сотрудником.`
      : `Не удалось определить текущего руководителя для объекта "${sourceObjectGroup.object_name || '—'}".`,
  };
}

function parseProjectManagerExportNumber(value) {
  const normalizedValue = String(value ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  if (!normalizedValue || normalizedValue === '-' || normalizedValue === '—') {
    return 0;
  }

  const numericValue = Number(normalizedValue);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function calculatePlanExecutionScoreRatio(planValue, factValue, targetPercent) {
  const planNumericValue = parseProjectManagerExportNumber(planValue);
  const factNumericValue = parseProjectManagerExportNumber(factValue);
  if (planNumericValue <= 0) {
    return 1;
  }
  if (factNumericValue <= 0) {
    return 0;
  }

  return Math.min(Math.max((factNumericValue / planNumericValue) * 100, 0) / targetPercent, 1);
}

function calculateCashInExecutionScoreRatio(planValue, factValue, targetPercent = 90) {
  const planNumericValue = parseProjectManagerExportNumber(planValue);
  const factNumericValue = parseProjectManagerExportNumber(factValue);
  if (planNumericValue <= 0) {
    return factNumericValue > 0 ? 1 : 0;
  }
  if (factNumericValue <= 0) {
    return 0;
  }

  const actualPercent = (factNumericValue / planNumericValue) * 100;
  if (!Number.isFinite(actualPercent) || actualPercent <= 0) {
    return 0;
  }
  if (actualPercent >= targetPercent) {
    return 1;
  }

  return Math.min(actualPercent / targetPercent, 1);
}

function calculateExpenseExecutionScoreRatio(planValue, factValue) {
  const planNumericValue = parseProjectManagerExportNumber(planValue);
  const factNumericValue = parseProjectManagerExportNumber(factValue);
  if (planNumericValue <= 0) {
    return factNumericValue <= 0 ? 1 : 0;
  }
  if (factNumericValue <= 0) {
    return 0;
  }

  const actualPercent = (factNumericValue / planNumericValue) * 100;
  if (!Number.isFinite(actualPercent) || actualPercent <= 0) {
    return 0;
  }
  if (actualPercent < 100) {
    return actualPercent / 100;
  }
  if (actualPercent <= 110) {
    return 1;
  }

  return Math.min(110 / actualPercent, 1);
}

function calculateProjectManagerActualPercent(metricKey, planValue, factValue) {
  const planNumericValue = parseProjectManagerExportNumber(planValue);
  const factNumericValue = parseProjectManagerExportNumber(factValue);
  if (planNumericValue <= 0) {
    if (metricKey === 'cashIn') {
      return factNumericValue > 0 ? 100 : 0;
    }
    if (metricKey === 'cashOut') {
      return factNumericValue > 0 ? 0 : 100;
    }
    if (metricKey === 'work') {
      return 100;
    }
    return null;
  }

  return roundImportNumber((factNumericValue / planNumericValue) * 100);
}

function buildProjectManagerObjectMetricSnapshot(typeValues) {
  const cashInPlanValue = parseProjectManagerExportNumber(typeValues[PROJECT_MANAGER_EXPORT_TYPE_CODES.cashInPlan]);
  const cashInFactValue = parseProjectManagerExportNumber(typeValues[PROJECT_MANAGER_EXPORT_TYPE_CODES.cashInFact]);
  const cashOutPlanValue = parseProjectManagerExportNumber(typeValues[PROJECT_MANAGER_EXPORT_TYPE_CODES.cashOutPlan]);
  const cashOutFactValue = parseProjectManagerExportNumber(typeValues[PROJECT_MANAGER_EXPORT_TYPE_CODES.cashOutFact]);
  const workPlanValue = parseProjectManagerExportNumber(typeValues[PROJECT_MANAGER_EXPORT_TYPE_CODES.workPlan]);
  const workFactValue = parseProjectManagerExportNumber(typeValues[PROJECT_MANAGER_EXPORT_TYPE_CODES.workFact]);

  return {
    cashIn: {
      planValue: cashInPlanValue,
      factValue: cashInFactValue,
      scoreRatio: calculateCashInExecutionScoreRatio(cashInPlanValue, cashInFactValue, 90),
    },
    cashOut: {
      planValue: cashOutPlanValue,
      factValue: cashOutFactValue,
      scoreRatio: calculateExpenseExecutionScoreRatio(cashOutPlanValue, cashOutFactValue),
    },
    work: {
      planValue: workPlanValue,
      factValue: workFactValue,
      scoreRatio: calculatePlanExecutionScoreRatio(workPlanValue, workFactValue, 80),
    },
  };
}

function isProjectManagerObjectMetricSnapshotEmpty(metricSnapshot) {
  if (!metricSnapshot) {
    return true;
  }

  return PROJECT_MANAGER_IMPORT_METRIC_ORDER.every((metricKey) => {
    const metric = metricSnapshot[metricKey];
    return parseProjectManagerExportNumber(metric?.planValue) <= 0
      && parseProjectManagerExportNumber(metric?.factValue) <= 0;
  });
}

function summarizeProjectManagerImportObjects(objects) {
  const filteredObjects = Array.isArray(objects)
    ? objects.filter((objectItem) => !isProjectManagerObjectMetricSnapshotEmpty(objectItem))
    : [];
  const objectCount = filteredObjects.length;

  if (!objectCount) {
    return null;
  }

  const metrics = PROJECT_MANAGER_IMPORT_METRIC_ORDER.map((metricKey) => {
    const metricName = PROJECT_MANAGER_EXPORT_METRIC_NAMES[metricKey];
    const planValue = filteredObjects.reduce(
      (total, objectItem) => total + Number(objectItem?.[metricKey]?.planValue || 0),
      0
    );
    const factValue = filteredObjects.reduce(
      (total, objectItem) => total + Number(objectItem?.[metricKey]?.factValue || 0),
      0
    );
    const averageScoreRatio = averageNumbers(
      filteredObjects.map((objectItem) => Number(objectItem?.[metricKey]?.scoreRatio || 0))
    );

    return {
      metricKey,
      metricName,
      planValue: roundImportNumber(planValue),
      factValue: roundImportNumber(factValue),
      actualPercent: calculateProjectManagerActualPercent(metricKey, planValue, factValue),
      averageScoreRatio: roundImportNumber(averageScoreRatio, 6),
    };
  });

  return {
    objectCount,
    metrics,
    objects: filteredObjects,
  };
}

function averageNumbers(values) {
  if (!Array.isArray(values) || !values.length) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + Number(value || 0), 0);
  return sum / values.length;
}

function roundImportNumber(value, precision = 4) {
  return Number(Number(value || 0).toFixed(precision));
}

function getProjectManagerMetricDefaultRawValue(summaryMetric) {
  const actualPercent = Number(summaryMetric?.actualPercent);
  return roundImportNumber(Number.isFinite(actualPercent) ? actualPercent : 0);
}

function areProjectManagerMetricValuesEqual(left, right, epsilon = 0.0005) {
  return Math.abs(Number(left || 0) - Number(right || 0)) < epsilon;
}

function syncProjectManagerImportMetricDefaults(periodId, employeeId) {
  const summary = getProjectManagerImportSummaryForEmployee(periodId, employeeId);
  if (!summary) {
    return null;
  }

  const metricRows = getProjectManagerExportMetricRowsStmt.all(periodId, employeeId);
  if (!metricRows.length) {
    return summary;
  }

  const summaryMetricByName = new Map(
    (summary.metrics || []).map((metric) => [metric.metricName, metric])
  );

  let hasChanges = false;
  for (const metricRow of metricRows) {
    const summaryMetric = summaryMetricByName.get(metricRow.metric_name);
    if (!summaryMetric) {
      continue;
    }

    const desiredRawValue = getProjectManagerMetricDefaultRawValue(summaryMetric);
    const currentRawValue = Number(metricRow.raw_value);
    const hasCurrentRawValue = metricRow.raw_value !== null && metricRow.raw_value !== undefined && Number.isFinite(currentRawValue);

    if (hasCurrentRawValue && areProjectManagerMetricValuesEqual(currentRawValue, desiredRawValue)) {
      continue;
    }

    updateEmployeeMetricValueStmt.run(desiredRawValue, metricRow.agreed_percent, metricRow.record_id, metricRow.metric_id);
    hasChanges = true;
  }

  return hasChanges ? getProjectManagerImportSummaryForEmployee(periodId, employeeId) : summary;
}

function getProjectManagerImportSummaryForEmployee(periodId, employeeId) {
  const summaryRow = getProjectManagerImportSummaryByEmployeeStmt.get(employeeId, periodId);
  const objects = getProjectManagerImportObjectsByEmployeeStmt.all(employeeId, periodId).map((row) => ({
    objectName: row.source_object_name,
    cashIn: {
      planValue: roundImportNumber(row.cash_in_plan),
      factValue: roundImportNumber(row.cash_in_fact),
      actualPercent: calculateProjectManagerActualPercent('cashIn', row.cash_in_plan, row.cash_in_fact),
      scoreRatio: roundImportNumber(row.cash_in_score_ratio, 6),
    },
    cashOut: {
      planValue: roundImportNumber(row.cash_out_plan),
      factValue: roundImportNumber(row.cash_out_fact),
      actualPercent: calculateProjectManagerActualPercent('cashOut', row.cash_out_plan, row.cash_out_fact),
      scoreRatio: roundImportNumber(row.cash_out_score_ratio, 6),
    },
    work: {
      planValue: roundImportNumber(row.work_plan),
      factValue: roundImportNumber(row.work_fact),
      actualPercent: calculateProjectManagerActualPercent('work', row.work_plan, row.work_fact),
      scoreRatio: roundImportNumber(row.work_score_ratio, 6),
    },
  }));
  const summary = summarizeProjectManagerImportObjects(objects);

  if (!summary) {
    return null;
  }

  return {
    objectCount: summary.objectCount,
    importedAt: summaryRow.imported_at || null,
    sourceMode: 'summed_by_employee',
    metrics: summary.metrics,
    objects: summary.objects,
  };
}

function ensureEmployeeRecordForImport(periodRow, employeeRow, actorUser, fallbackObjectId = null) {
  const existingRecord = getEmployeeRecordByPeriodStmt.get(periodRow.id, employeeRow.id);
  if (existingRecord) {
    if (periodRow.status === 'open') {
      const objectId = Number(employeeRow.current_object_id || fallbackObjectId || existingRecord.object_id || 0);
      if (objectId) {
        syncRecordScopeToEmployee(existingRecord, employeeRow, objectId, actorUser);
        return getEmployeeRecordByPeriodStmt.get(periodRow.id, employeeRow.id) || existingRecord;
      }
    }

    return existingRecord;
  }

  const objectId = Number(employeeRow.current_object_id || fallbackObjectId || 0);
  if (!objectId) {
    throw new Error(`Для сотрудника "${employeeRow.full_name}" не найден объект для создания KPI-карточки.`);
  }

  const recordId = createEmployeeRecordWithSnapshots(
    periodRow.id,
    employeeRow.id,
    objectId,
    employeeRow.position_title,
    actorUser
  );

  return getEmployeeRecordByPeriodStmt.get(periodRow.id, employeeRow.id) || {
    id: recordId,
    object_id: objectId,
    position_title_snapshot: employeeRow.position_title,
  };
}

function importProjectManagerExportValues(payload, actorUser) {
  assertAdminAccess(actorUser);
  const periodRow = getRequiredUploadPeriodRow(payload?.periodCode, actorUser);
  if (!periodRow) {
    throw new Error('Не найден период KPI для загрузки значений.');
  }

  const uploadFile = writeBase64UploadTempFile(payload?.fileName, payload?.fileContentBase64);

  try {
    const parsed = runProjectManagerExportParser(uploadFile.tempPath);
    const sourceRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    if (!sourceRows.length) {
      throw new Error('В Excel-файле не найдены строки для загрузки.');
    }

    return withTransaction(() => {
      const monthCode = String(Number(periodRow.month_num || 0)).padStart(2, '0');
      const lookupContext = buildProjectManagerLookupContext();
      const objectGroups = new Map();
      const results = [];
      const employeeAggregates = new Map();

      deleteProjectManagerImportRowsByPeriodStmt.run(periodRow.id);

      for (const sourceRow of sourceRows) {
        const typeCode = normalizeText(sourceRow.typeCode).toUpperCase();
        if (!Object.values(PROJECT_MANAGER_EXPORT_TYPE_CODES).includes(typeCode)) {
          continue;
        }

        const groupKey = `${normalizeText(sourceRow.sourceId) || normalizeText(sourceRow.objectName)}::${normalizeText(sourceRow.objectName)}`;
        if (!objectGroups.has(groupKey)) {
          objectGroups.set(groupKey, {
            group_key: groupKey,
            source_id: normalizeText(sourceRow.sourceId),
            object_name: normalizeText(sourceRow.objectName),
            manager_names: new Set(),
            type_values: {},
          });
        }

        const group = objectGroups.get(groupKey);
        if (normalizeText(sourceRow.managerName)) {
          group.manager_names.add(normalizeText(sourceRow.managerName));
        }
        group.type_values[typeCode] = sourceRow.monthValues?.[monthCode] ?? '';
      }

      if (!objectGroups.size) {
        throw new Error(`В файле не найдено строк с типами ${Object.values(PROJECT_MANAGER_EXPORT_TYPE_CODES).join(', ')}.`);
      }

      for (const objectGroup of objectGroups.values()) {
        const employeeResolution = resolveProjectManagerEmployee(objectGroup, lookupContext);
        if (!employeeResolution.employeeRow) {
          results.push({
            fullName: Array.from(objectGroup.manager_names).find(Boolean) || objectGroup.object_name || '—',
            percent: '',
            status: 'skipped',
            message: employeeResolution.message,
          });
          continue;
        }

        const metricSnapshot = buildProjectManagerObjectMetricSnapshot(objectGroup.type_values);
        if (!employeeAggregates.has(employeeResolution.employeeRow.id)) {
          employeeAggregates.set(employeeResolution.employeeRow.id, {
            employeeRow: employeeResolution.employeeRow,
            fallbackObjectId: employeeResolution.objectRow ? Number(employeeResolution.objectRow.id) : 0,
            objectCount: 0,
          });
        }

        if (isProjectManagerObjectMetricSnapshotEmpty(metricSnapshot)) {
          continue;
        }

        insertProjectManagerImportObjectValueStmt.run(
          periodRow.id,
          Number(employeeResolution.employeeRow.id),
          objectGroup.group_key,
          objectGroup.object_name || '—',
          employeeResolution.objectRow ? Number(employeeResolution.objectRow.id) : null,
          metricSnapshot.cashIn.planValue,
          metricSnapshot.cashIn.factValue,
          metricSnapshot.cashIn.scoreRatio,
          metricSnapshot.cashOut.planValue,
          metricSnapshot.cashOut.factValue,
          metricSnapshot.cashOut.scoreRatio,
          metricSnapshot.work.planValue,
          metricSnapshot.work.factValue,
          metricSnapshot.work.scoreRatio
        );

        const aggregate = employeeAggregates.get(employeeResolution.employeeRow.id);
        aggregate.objectCount += 1;
      }

      let updatedCount = 0;

      for (const aggregate of employeeAggregates.values()) {
        const recordRow = ensureEmployeeRecordForImport(periodRow, aggregate.employeeRow, actorUser, aggregate.fallbackObjectId);
        const metricRows = getProjectManagerExportMetricRowsStmt.all(periodRow.id, aggregate.employeeRow.id);
        const metricRowByName = new Map(metricRows.map((row) => [row.metric_name, row]));
        const importSummary = getProjectManagerImportSummaryForEmployee(periodRow.id, aggregate.employeeRow.id);
        const importMetricByName = new Map(
          (importSummary?.metrics || []).map((metric) => [metric.metricName, metric])
        );
        const requiredMetricNames = Object.values(PROJECT_MANAGER_EXPORT_METRIC_NAMES);
        const hasAllRequiredMetrics = requiredMetricNames.every((metricName) => metricRowByName.has(metricName));

        if (!hasAllRequiredMetrics) {
          results.push({
            fullName: aggregate.employeeRow.full_name,
            percent: '',
            status: 'skipped',
            message: 'Для сотрудника не найдены все KPI-метрики руководителя проекта в выбранном периоде.',
          });
          continue;
        }

        const updates = [];
        for (const metricName of Object.values(PROJECT_MANAGER_EXPORT_METRIC_NAMES)) {
          const metricRow = metricRowByName.get(metricName);
          const rawValue = getProjectManagerMetricDefaultRawValue(importMetricByName.get(metricName));

          updateEmployeeMetricValueStmt.run(rawValue, null, recordRow.id, metricRow.metric_id);
          updates.push({
            label: metricName,
            rawValue,
          });
        }

        resetEmployeeRecordApprovalStmt.run(actorUser.id, recordRow.id);
        updatedCount += 1;
        results.push({
          fullName: aggregate.employeeRow.full_name,
          percent: updates.map((item) => `${item.label}: ${item.rawValue}%`).join(' | '),
          status: 'updated',
          message: `Объектов усреднено: ${aggregate.objectCount}.`,
        });
      }

      const summary = {
        importLabel: 'Экспорт руководителей проектов',
        metricLabel: Object.values(PROJECT_MANAGER_EXPORT_METRIC_NAMES).join(' / '),
        sheetName: parsed?.sheetName || '',
        periodCode: periodRow.code,
        periodLabel: periodRow.label,
        fileName: uploadFile.fileName,
        totalRows: results.length,
        updatedCount,
        skippedCount: results.length - updatedCount,
        results,
      };

      writeActionLog(
        actorUser,
        'import',
        'project_manager_export',
        uploadFile.fileName,
        'Загружены KPI-показатели руководителей проектов из экспортного файла.',
        {
          periodCode: periodRow.code,
          monthCode,
          totalRows: summary.totalRows,
          updatedCount: summary.updatedCount,
          skippedCount: summary.skippedCount,
        }
      );

      return summary;
    });
  } finally {
    fs.rmSync(uploadFile.tempDir, { recursive: true, force: true });
  }
}

function getMetricUnitLabel(inputType, normText = '') {
  if (normalizeText(normText).toLowerCase().includes('\u0434\u043d')) {
    return '\u0414\u043d\u0438';
  }
  if (inputType === 'score') {
    return '\u0411\u0430\u043b\u043b\u044b 0-5';
  }
  if (inputType === 'pct') {
    return '\u041f\u0440\u043e\u0446\u0435\u043d\u0442';
  }
  return '\u0414\u0438\u0441\u0446\u0438\u043f\u043b\u0438\u043d\u0430 %';
}

function parseMetricTargetValue(value, inputType, fallbackValue = null) {
  const rawValue = value === undefined || value === null || value === '' ? fallbackValue : value;
  const numericValue = Number(rawValue);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    throw new Error('Норма должна быть числом больше 0.');
  }

  const upperLimit = inputType === 'score' ? 5 : 100;
  if (numericValue > upperLimit) {
    throw new Error(inputType === 'score' ? 'Норма для баллов должна быть от 0 до 5.' : 'Норма должна быть от 0 до 100%.');
  }

  return numericValue;
}

function assertKnownPosition(positionTitle) {
  if (!positionTitle) {
    throw new Error('Должность обязательна.');
  }

  const existing = getKnownPositionStmt.get(positionTitle);
  if (!existing) {
    throw new Error('Выберите корректную должность из списка.');
  }
}

function parseMetricWeightPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 100) {
    throw new Error('Вес показателя должен быть числом от 0 до 100.');
  }
  return numericValue;
}

function parseMetricSortOrder(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 1) {
    throw new Error('Порядок должен быть целым числом от 1.');
  }

  return numericValue;
}

function validateMetricPayload(payload, currentMetric = null) {
  const groupCode = normalizeIncomingText(payload, 'groupCode', currentMetric?.group_code);
  const groupRow = getMetricGroupByCodeStmt.get(groupCode);
  if (!groupRow) {
    throw new Error('Выберите корректный блок показателей.');
  }

  const name = normalizeIncomingText(payload, 'name', currentMetric?.name);
  if (!name) {
    throw new Error('Название показателя обязательно.');
  }

  const inputType = normalizeIncomingText(payload, 'inputType', currentMetric?.input_type);
  if (!METRIC_INPUT_TYPES.has(inputType)) {
    throw new Error('Выберите корректный тип показателя.');
  }

  const weightPercent = parseMetricWeightPercent(
    payload?.weightPercent ?? (currentMetric ? Number(currentMetric.weight) * 100 : NaN)
  );
  const defaults = getMetricDefaults(inputType);
  const normText = normalizeIncomingText(payload, 'normText', currentMetric?.norm_text || defaults.normText) || defaults.normText;
  const isMovingToAnotherGroup = currentMetric && Number(currentMetric.group_id) !== Number(groupRow.id);
  const defaultSortOrder =
    currentMetric && !isMovingToAnotherGroup
      ? Number(currentMetric.sort_order)
      : Number(getMaxMetricSortOrderStmt.get(groupRow.id)?.max_sort_order || 0) + 1;
  const sortOrder = parseMetricSortOrder(payload?.sortOrder, defaultSortOrder);
  const weight = weightPercent / 100;

  return {
    groupRow,
    name,
    inputType,
    weight,
    weightPercent,
    normText,
    minValue: defaults.minValue,
    maxValue: defaults.maxValue,
    sortOrder,
  };
}

function parseMetricIdentifier(value) {
  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue < 1) {
    throw new Error('Выберите корректный показатель из справочника.');
  }
  return numericValue;
}

function listPositionKpiProfiles(requestedPositionTitle = '') {
  const positions = getPositionProfilePositionsStmt.all().map((row) => row.position_title);
  const selectedPosition = positions.includes(normalizeText(requestedPositionTitle))
    ? normalizeText(requestedPositionTitle)
    : positions[0] || '';

  const groupTemplates = getMetricGroupsDirectoryStmt.all().map((row) => ({
    groupId: row.id,
    groupCode: row.code,
    groupName: row.name,
    maxPercent: row.max_percent,
    catalogMetrics: [],
    assignments: [],
    totalWeightPercent: 0,
    isWeightBalanced: false,
  }));

  const catalogGroupMap = new Map(groupTemplates.map((group) => [group.groupId, group]));
  for (const row of getPositionCatalogMetricsStmt.all()) {
    const group = catalogGroupMap.get(row.group_id);
    if (!group) {
      continue;
    }

    group.catalogMetrics.push({
      metricId: row.metric_id,
      metricName: row.metric_name,
      inputType: row.input_type,
      normText: row.norm_text,
      defaultTargetValue: row.max_value,
      unitLabel: getMetricUnitLabel(row.input_type, row.norm_text),
      sortOrder: row.sort_order,
    });
  }

  const assignmentGroups = groupTemplates.map((group) => ({
    groupId: group.groupId,
    groupCode: group.groupCode,
    groupName: group.groupName,
    maxPercent: group.maxPercent,
    catalogMetrics: group.catalogMetrics,
    assignments: [],
    totalWeightPercent: 0,
    isWeightBalanced: false,
  }));

  const assignmentGroupMap = new Map(assignmentGroups.map((group) => [group.groupId, group]));
  if (selectedPosition) {
    for (const row of getPositionAssignmentsStmt.all(selectedPosition)) {
      const group = assignmentGroupMap.get(row.group_id);
      if (!group) {
        continue;
      }

      group.assignments.push({
        assignmentId: row.assignment_id,
        metricId: row.metric_id,
        metricName: row.metric_name,
        unitLabel: getMetricUnitLabel(row.input_type, row.norm_text),
        inputType: row.input_type,
        normText: row.norm_text,
        targetValue: row.target_value,
        weightPercent: Number((Number(row.weight) * 100).toFixed(3)),
        sortOrder: row.sort_order,
      });
    }
  }

  for (const group of assignmentGroups) {
    group.totalWeightPercent = Number(
      group.assignments.reduce((total, assignment) => total + Number(assignment.weightPercent || 0), 0).toFixed(3)
    );
    group.isWeightBalanced = Math.abs(group.totalWeightPercent - 100) < 0.0005;
  }

  return {
    positions,
    selectedPosition,
    groups: assignmentGroups,
  };
}

function validatePositionAssignmentPayload(payload, currentAssignment = null) {
  const positionTitle = normalizeIncomingText(payload, 'positionTitle', currentAssignment?.position_title);
  assertKnownPosition(positionTitle);

  const metricId = parseMetricIdentifier(payload?.metricId ?? currentAssignment?.metric_id);
  const metricRow = getMetricByIdStmt.get(metricId);
  if (!metricRow || !metricRow.is_active) {
    throw new Error('Выберите корректный показатель из справочника.');
  }

  const weightPercent = parseMetricWeightPercent(
    payload?.weightPercent ?? (currentAssignment ? Number(currentAssignment.weight) * 100 : NaN)
  );
  const targetValue = parseMetricTargetValue(
    payload?.targetValue,
    metricRow.input_type,
    currentAssignment?.target_value ?? metricRow.max_value
  );

  const defaultSortOrder = currentAssignment
    ? Number(currentAssignment.sort_order)
    : Number(getMaxPositionAssignmentSortOrderStmt.get(positionTitle, metricRow.group_code)?.max_sort_order || 0) + 1;
  const sortOrder = parseMetricSortOrder(payload?.sortOrder, defaultSortOrder);

  return {
    positionTitle,
    metricId,
    metricRow,
    weight: weightPercent / 100,
    weightPercent,
    targetValue,
    sortOrder,
  };
}

function createPositionAssignment(payload, actorUser) {
  assertAdminAccess(actorUser);
  return withTransaction(() => {
    const assignmentData = validatePositionAssignmentPayload(payload);
    const existing = getPositionAssignmentByPositionMetricStmt.get(assignmentData.positionTitle, assignmentData.metricId);
    if (existing) {
      throw new Error('Этот показатель уже добавлен в карточку выбранной должности.');
    }

    const insertResult = insertPositionAssignmentStmt.run(
      assignmentData.positionTitle,
      assignmentData.metricId,
      assignmentData.weight,
      assignmentData.targetValue,
      assignmentData.sortOrder
    );
    const assignmentId = Number(insertResult.lastInsertRowid);
    writeActionLog(actorUser, 'create', 'position_kpi_assignment', assignmentId, 'Показатель добавлен в карточку должности.', {
      assignmentId,
      positionTitle: assignmentData.positionTitle,
      metricId: assignmentData.metricId,
    });

    return {
      assignmentId,
    };
  });
}

function updatePositionAssignment(assignmentId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const currentAssignment = getPositionAssignmentByIdStmt.get(assignmentId);
  if (!currentAssignment) {
    throw new Error('Связка должности и показателя не найдена.');
  }

  const requestedPositionTitle = normalizeIncomingText(payload, 'positionTitle', currentAssignment.position_title);
  if (requestedPositionTitle !== normalizeText(currentAssignment.position_title)) {
    throw new Error('Должность у строки KPI нельзя менять после создания.');
  }

  const requestedMetricId = payload && Object.prototype.hasOwnProperty.call(payload, 'metricId')
    ? parseMetricIdentifier(payload.metricId)
    : Number(currentAssignment.metric_id);
  if (requestedMetricId !== Number(currentAssignment.metric_id)) {
    throw new Error('Показатель у строки KPI нельзя менять после создания.');
  }

  return withTransaction(() => {
    const assignmentData = validatePositionAssignmentPayload(
      {
        ...payload,
        positionTitle: currentAssignment.position_title,
        metricId: currentAssignment.metric_id,
      },
      currentAssignment
    );

    updatePositionAssignmentStmt.run(
      assignmentData.weight,
      assignmentData.targetValue,
      assignmentData.sortOrder,
      assignmentId
    );
    writeActionLog(actorUser, 'update', 'position_kpi_assignment', assignmentId, 'Карточка KPI по должности обновлена.', {
      assignmentId,
      positionTitle: assignmentData.positionTitle,
      metricId: assignmentData.metricId,
      weightPercent: assignmentData.weightPercent,
      targetValue: assignmentData.targetValue,
    });

    return {
      assignmentId,
    };
  });
}

function deletePositionAssignment(assignmentId, actorUser) {
  assertAdminAccess(actorUser);
  const currentAssignment = getPositionAssignmentByIdStmt.get(assignmentId);
  if (!currentAssignment) {
    throw new Error('Связка должности и показателя не найдена.');
  }

  return withTransaction(() => {
    deletePositionAssignmentStmt.run(assignmentId);
    writeActionLog(actorUser, 'delete', 'position_kpi_assignment', assignmentId, 'Показатель удален из карточки должности.', {
      assignmentId,
      positionTitle: currentAssignment.position_title,
      metricId: currentAssignment.metric_id,
    });
    return { assignmentId };
  });
}

function listMetricGroups() {
  const groups = getMetricGroupsDirectoryStmt.all().map((row) => ({
    groupId: row.id,
    groupCode: row.code,
    groupName: row.name,
    maxPercent: row.max_percent,
    metrics: [],
  }));

  const groupMap = new Map(groups.map((group) => [group.groupId, group]));

  for (const row of getMetricsDirectoryStmt.all()) {
    const group = groupMap.get(row.group_id);
    if (!group) {
      continue;
    }

    group.metrics.push({
      metricId: row.id,
      code: row.code,
      name: row.name,
      inputType: row.input_type,
      weightPercent: Number((Number(row.weight) * 100).toFixed(3)),
      normText: row.norm_text,
      minValue: row.min_value,
      maxValue: row.max_value,
      sortOrder: row.sort_order,
      isActive: Boolean(row.is_active),
    });
  }

  return groups;
}

function createMetric(payload, actorUser) {
  assertAdminAccess(actorUser);
  return withTransaction(() => {
    const metricData = validateMetricPayload(payload);
    const metricCode = `${metricData.groupRow.code}_${randomUUID().replaceAll('-', '_')}`;

    const insertResult = insertMetricStmt.run(
      metricData.groupRow.id,
      metricCode,
      metricData.name,
      metricData.weight,
      metricData.inputType,
      metricData.normText,
      metricData.minValue,
      metricData.maxValue,
      metricData.sortOrder
    );

    const metricId = Number(insertResult.lastInsertRowid);
    insertMetricValuesForExistingRecordsStmt.run(metricId);
    writeActionLog(actorUser, 'create', 'kpi_metric', metricId, 'Показатель KPI добавлен.', {
      metricId,
      groupCode: metricData.groupRow.code,
      name: metricData.name,
    });

    return { metricId };
  });
}

function updateMetric(metricId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const currentMetric = getMetricByIdStmt.get(metricId);
  if (!currentMetric) {
    throw new Error('Показатель не найден.');
  }

  const requestedName = normalizeIncomingText(payload, 'name', currentMetric.name);
  if (requestedName !== normalizeText(currentMetric.name)) {
    throw new Error('Название показателя нельзя менять после создания.');
  }

  const requestedGroupCode = normalizeIncomingText(payload, 'groupCode', currentMetric.group_code);
  if (requestedGroupCode !== normalizeText(currentMetric.group_code)) {
    throw new Error('Блок показателя нельзя менять после создания.');
  }

  return withTransaction(() => {
    const metricData = validateMetricPayload(
      {
        ...payload,
        name: currentMetric.name,
        groupCode: currentMetric.group_code,
      },
      currentMetric
    );

    updateMetricStmt.run(
      metricData.groupRow.id,
      metricData.name,
      metricData.weight,
      metricData.inputType,
      metricData.normText,
      metricData.minValue,
      metricData.maxValue,
      metricData.sortOrder,
      metricId
    );
    writeActionLog(actorUser, 'update', 'kpi_metric', metricId, 'Показатель KPI обновлен.', {
      metricId,
      inputType: metricData.inputType,
      weightPercent: metricData.weightPercent,
      sortOrder: metricData.sortOrder,
    });

    return { metricId };
  });
}

function deleteMetric(metricId, actorUser) {
  assertAdminAccess(actorUser);
  const currentMetric = getMetricByIdStmt.get(metricId);
  if (!currentMetric) {
    throw new Error('Показатель не найден.');
  }

  return withTransaction(() => {
    deleteMetricValuesByMetricIdStmt.run(metricId);
    deleteMetricStmt.run(metricId);
    writeActionLog(actorUser, 'delete', 'kpi_metric', metricId, 'Показатель KPI удален.', {
      metricId,
      name: currentMetric.name,
      groupCode: currentMetric.group_code,
    });
    return { metricId };
  });
}

function listUsers(actorUser) {
  assertAdminAccess(actorUser);
  return getUsersDirectoryStmt.all().map(formatDirectoryUser);
}

function createUserAccount(payload, actorUser) {
  assertAdminAccess(actorUser);
  const userData = validateUserAccountPayload(payload, null, { requirePassword: true });

  return withTransaction(() => {
    ensureUniqueAuthLogin(userData.login, null);
    const result = insertAuthUserStmt.run(
      userData.login,
      userData.displayName,
      userData.employeeShortName,
      userData.roleCode,
      hashPassword(userData.password),
      userData.isActive ? 1 : 0
    );
    const userId = Number(result.lastInsertRowid);
    syncObjectManagerLinks();
    writeActionLog(actorUser, 'create', 'auth_user', userId, 'Пользователь добавлен.', {
      userId,
      login: userData.login,
      roleCode: userData.roleCode,
      isActive: userData.isActive,
    });
    return {
      userId,
    };
  });
}

function updateUserAccount(userId, payload, actorUser) {
  assertAdminAccess(actorUser);
  const currentUser = getAuthUserByIdStmt.get(userId);
  if (!currentUser) {
    throw new Error('Пользователь не найден.');
  }

  const userData = validateUserAccountPayload(payload, currentUser, {
    requirePassword: false,
  });
  const isCurrentActiveAdmin =
    normalizeRoleCode(currentUser.role_code, '') === ROLE_CODES.ADMIN && Boolean(currentUser.is_active);

  if (Number(actorUser.id) === Number(userId) && !userData.isActive) {
    throw new Error('Нельзя деактивировать текущего пользователя.');
  }

  if (
    isCurrentActiveAdmin &&
    (userData.roleCode !== ROLE_CODES.ADMIN || !userData.isActive)
  ) {
    assertCanLeaveAtLeastOneActiveAdmin(userId);
  }

  return withTransaction(() => {
    ensureUniqueAuthLogin(userData.login, userId);
    updateAuthUserStmt.run(
      userData.login,
      userData.displayName,
      userData.employeeShortName,
      userData.roleCode,
      userData.isActive ? 1 : 0,
      userId
    );

    const passwordChanged = Boolean(userData.password);
    if (passwordChanged) {
      updateAuthUserPasswordStmt.run(hashPassword(userData.password), userId);
    }

    writeActionLog(actorUser, 'update', 'auth_user', userId, 'Данные пользователя обновлены.', {
      userId,
      login: userData.login,
      roleCode: userData.roleCode,
      isActive: userData.isActive,
      passwordChanged,
    });

    syncObjectManagerLinks();

    return {
      userId,
      passwordChanged,
    };
  });
}

function deleteUserAccount(userId, actorUser) {
  assertAdminAccess(actorUser);
  const currentUser = getAuthUserByIdStmt.get(userId);
  if (!currentUser) {
    throw new Error('Пользователь не найден.');
  }

  if (Number(actorUser.id) === Number(userId)) {
    throw new Error('Нельзя удалить текущего пользователя.');
  }

  if (normalizeRoleCode(currentUser.role_code, '') === ROLE_CODES.ADMIN && Boolean(currentUser.is_active)) {
    assertCanLeaveAtLeastOneActiveAdmin(userId);
  }

  return withTransaction(() => {
    deleteAuthUserStmt.run(userId);
    syncObjectManagerLinks();
    writeActionLog(actorUser, 'delete', 'auth_user', userId, 'Пользователь удален.', {
      userId,
      login: currentUser.login,
      roleCode: currentUser.role_code,
    });
    return {
      userId,
    };
  });
}

function listActionLogs(actorUser, limit = 200) {
  assertAdminAccess(actorUser);
  return getActionLogsStmt.all(clampLogLimit(limit)).map((row) => ({
    logId: row.id,
    actorUserId: row.actor_user_id,
    actorLogin: row.actor_login,
    actorDisplayName: row.actor_display_name,
    actorRoleCode: row.actor_role_code,
    actorRoleLabel: row.actor_role_code ? getRoleLabel(row.actor_role_code) : '',
    actionType: row.action_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    message: row.message,
    details: (() => {
      if (!row.details_json) {
        return null;
      }

      try {
        return JSON.parse(row.details_json);
      } catch {
        return null;
      }
    })(),
    createdAt: row.created_at,
  }));
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error('Слишком большой размер запроса.'));
      }
    });

    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Некорректный JSON в запросе.'));
      }
    });

    req.on('error', reject);
  });
}

function handleAuthPeriods(res) {
  const periods = getPeriodsStmt.all();
  sendJson(res, 200, {
    defaultPeriodCode: resolveRequestedPeriodCode(''),
    periods: periods.map((row) => ({
      code: row.code,
      label: row.label,
      yearNum: row.year_num,
      monthNum: row.month_num,
      status: row.status,
    })),
  });
}

async function handleLogin(req, res) {
  try {
    if (isLoginBlocked(req)) {
      sendError(res, 429, LOGIN_LOCKED_MESSAGE);
      return;
    }

    const payload = await readJsonBody(req, 16 * 1024);
    const login = normalizeCredential(payload.login);
    const password = String(payload.password ?? '');
    const periodCode = resolveRequestedPeriodCode(payload.periodCode);
    const user = login ? getAuthUserByLoginStmt.get(login) : null;
    const isValidCredentials = Boolean(
      user &&
      user.is_active &&
      password &&
      verifyPassword(password, user.password_hash)
    );

    if (!isValidCredentials) {
      const attemptState = registerFailedLoginAttempt(req);
      const isLockedNow = Boolean(attemptState.lockedUntil && attemptState.lockedUntil > Date.now());
      writeActionLog(null, 'login_failed', 'auth_user', login || null, isLockedNow ? LOGIN_LOCKED_MESSAGE : LOGIN_ERROR_MESSAGE, {
        login,
        clientKey: getRequestClientKey(req),
      });
      sendError(res, isLockedNow ? 429 : 401, isLockedNow ? LOGIN_LOCKED_MESSAGE : LOGIN_ERROR_MESSAGE);
      return;
    }

    clearLoginAttemptState(req);

    const existingSession = getSessionFromRequest(req);
    if (existingSession) {
      destroySession(existingSession.sessionId);
    }

    const sessionId = createSession(user.id);
    setSessionCookie(res, sessionId);
    updateAuthUserLastLoginStmt.run(user.id);
    const formattedUser = formatAuthenticatedUser(user);
    writeActionLog(formattedUser, 'login', 'auth_user', user.id, 'Успешный вход в систему.', {
      periodCode,
    });

    sendJson(res, 200, {
      ok: true,
      redirectTo: buildDashboardLocation(periodCode),
      user: formattedUser,
      permissions: buildUserPermissions(formattedUser),
    });
  } catch (error) {
    sendError(res, 400, error.message);
  }
}

function handleLogout(req, res) {
  const existingSession = getSessionFromRequest(req);
  const authContext = getAuthenticatedRequestContext(req);
  if (existingSession) {
    destroySession(existingSession.sessionId);
  }

  clearSessionCookie(res);
  if (authContext?.user) {
    writeActionLog(authContext.user, 'logout', 'auth_user', authContext.user.id, 'Выход из системы.');
  }
  sendJson(res, 200, { ok: true });
}

function handleAuthSession(req, res) {
  const authContext = requireAuthenticatedApiRequest(req, res);
  if (!authContext) {
    return;
  }

  sendJson(res, 200, {
    authenticated: true,
    user: authContext.user,
    permissions: authContext.permissions,
  });
}

function handleDashboard(res, urlObj, actorUser) {
  const periodCode = getSelectedPeriodCode(urlObj);
  if (!periodCode) {
    return sendError(res, 404, 'No KPI periods found in database.');
  }

  ensurePeriodDataAvailable(periodCode, actorUser);

  const periods = getPeriodsStmt.all();
  const employees = filterDashboardEmployeesForUser(actorUser, getEmployeesStmt.all(periodCode));
  const summary = isAdminUser(actorUser)
    ? {
        employeesCount: getSummaryStmt.get(periodCode)?.employees_count || 0,
        doneCount: getSummaryStmt.get(periodCode)?.done_count || 0,
        partialCount: getSummaryStmt.get(periodCode)?.partial_count || 0,
        failedCount: getSummaryStmt.get(periodCode)?.failed_count || 0,
        approvedCount: getSummaryStmt.get(periodCode)?.approved_count || 0,
        avgBlockAPercent: getSummaryStmt.get(periodCode)?.avg_block_a_percent || 0,
        avgBlockBPercent: getSummaryStmt.get(periodCode)?.avg_block_b_percent || 0,
        avgTotalPercent: getSummaryStmt.get(periodCode)?.avg_total_percent || 0,
        totalBonusRub: getSummaryStmt.get(periodCode)?.total_bonus_rub || 0,
      }
    : buildDashboardSummaryFromEmployees(employees);
  const objects = isAdminUser(actorUser)
    ? getObjectsStmt.all(periodCode).map((row) => ({
      objectId: row.object_id,
      objectName: row.object_name,
      managerName: row.manager_name,
      managerUserId: row.manager_user_id,
      employeesCount: row.employees_count,
      approvedCount: row.approved_count,
      avgTotalPercent: row.avg_total_percent,
      }))
    : buildDashboardObjectsFromEmployees(employees, listObjects(false, actorUser));

  sendJson(res, 200, {
    selectedPeriod: periodCode,
    periods: periods.map((row) => ({
      code: row.code,
      label: row.label,
      yearNum: row.year_num,
      monthNum: row.month_num,
      status: row.status,
    })),
    summary,
    objects,
    employees,
  });
}

function handleEmployeeDetail(res, urlObj, employeeId, actorUser) {
  const periodCode = getSelectedPeriodCode(urlObj);
  if (!periodCode) {
    return sendError(res, 404, 'No KPI periods found in database.');
  }

  ensurePeriodDataAvailable(periodCode, actorUser);

  const header = getEmployeeHeaderStmt.get(employeeId, periodCode);
  if (!header) {
    return sendError(res, 404, 'Employee record not found for selected period.');
  }

  if (!canAccessKpiRecord(actorUser, header)) {
    return sendError(res, 403, ACCESS_DENIED_MESSAGE);
  }

  let resolvedHeader = header;
  const projectManagerImport = isProjectManagerPosition(header.position_title)
    ? syncProjectManagerImportMetricDefaults(header.period_id, header.employee_id)
    : null;
  if (projectManagerImport) {
    resolvedHeader = getEmployeeHeaderStmt.get(employeeId, periodCode) || header;
  }
  const metrics = getEmployeeMetricsStmt.all(employeeId, periodCode);
  sendJson(res, 200, formatEmployeeDetail(resolvedHeader, metrics, actorUser, projectManagerImport));
}

function handleObjectsDirectory(res, urlObj, actorUser) {
  const includeArchived = urlObj.searchParams.get('includeArchived') === '1';
  const objects = listObjects(includeArchived, actorUser);
  sendJson(res, 200, { objects });
}

function handleStaffDirectory(res, urlObj) {
  const includeArchived = urlObj.searchParams.get('includeArchived') === '1';
  const staff = listStaff(includeArchived);
  sendJson(res, 200, { staff });
}

function handleReferenceData(res, actorUser) {
  sendJson(res, 200, listReferenceData(actorUser));
}

function handleMetricsDirectory(res) {
  sendJson(res, 200, { groups: listMetricGroups() });
}

function handlePositionKpiDirectory(res, urlObj) {
  const requestedPosition = normalizeText(urlObj.searchParams.get('position'));
  sendJson(res, 200, listPositionKpiProfiles(requestedPosition));
}

function handleUsersDirectory(req, res) {
  sendJson(res, 200, { users: listUsers(req.auth.user) });
}

function handleActionLogs(req, res, urlObj) {
  const limit = clampLogLimit(urlObj.searchParams.get('limit'));
  sendJson(res, 200, { logs: listActionLogs(req.auth.user, limit) });
}

async function handleCreateEmployee(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createEmployee(payload, req.auth.user);
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCreateEmployeeRecord(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createEmployeeRecord(payload, req.auth.user);
    sendJson(res, result.action === 'assigned' ? 201 : 200, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCopyPeriodData(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = copyPeriodDataV2(payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateEmployee(req, res, employeeId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateEmployee(employeeId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Сотрудник не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateEmployeeMetricValue(req, res, recordId, metricId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateEmployeeMetricValue(recordId, metricId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Строка KPI не найдена.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleApproveEmployeeRecord(req, res, recordId) {
  try {
    const result = approveEmployeeRecord(recordId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Строка KPI не найдена.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUnapproveEmployeeRecord(req, res, recordId) {
  try {
    const result = unapproveEmployeeRecord(recordId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Строка KPI не найдена.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCreateStaff(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createEmployee(payload, req.auth.user);
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCreateObject(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createObjectEntry(payload, req.auth.user);
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleExecutionDisciplineUpload(req, res) {
  try {
    const payload = await readJsonBody(req, 12 * 1024 * 1024);
    const result = importExecutionDisciplineValues(payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleContractApprovalsUpload(req, res) {
  try {
    const payload = await readJsonBody(req, 12 * 1024 * 1024);
    const result = importContractApprovalValues(payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleProjectManagerExportUpload(req, res) {
  try {
    const payload = await readJsonBody(req, 12 * 1024 * 1024);
    const result = importProjectManagerExportValues(payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateStaff(req, res, employeeId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateEmployee(employeeId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Сотрудник не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateStaffPeriodPosition(req, res, employeeId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateEmployeePositionForPeriod(employeeId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'РЎРѕС‚СЂСѓРґРЅРёРє РЅРµ РЅР°Р№РґРµРЅ.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateObject(req, res, objectId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateObjectEntry(objectId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Объект не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleDeleteStaff(req, res, employeeId) {
  try {
    const result = deleteEmployee(employeeId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Сотрудник не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleDeleteObject(req, res, objectId) {
  try {
    const result = deleteObjectEntry(objectId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Объект не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCreateMetric(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createMetric(payload, req.auth.user);
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateMetric(req, res, metricId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateMetric(metricId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Показатель не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleDeleteMetric(req, res, metricId) {
  try {
    const result = deleteMetric(metricId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Показатель не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCreatePositionAssignment(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createPositionAssignment(payload, req.auth.user);
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdatePositionAssignment(req, res, assignmentId) {
  try {
    const payload = await readJsonBody(req);
    const result = updatePositionAssignment(assignmentId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Связка должности и показателя не найдена.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleDeletePositionAssignment(req, res, assignmentId) {
  try {
    const result = deletePositionAssignment(assignmentId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Связка должности и показателя не найдена.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleCreateUser(req, res) {
  try {
    const payload = await readJsonBody(req);
    const result = createUserAccount(payload, req.auth.user);
    sendJson(res, 201, result);
  } catch (error) {
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleUpdateUser(req, res, userId) {
  try {
    const payload = await readJsonBody(req);
    const result = updateUserAccount(userId, payload, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Пользователь не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

async function handleDeleteUser(req, res, userId) {
  try {
    const result = deleteUserAccount(userId, req.auth.user);
    sendJson(res, 200, result);
  } catch (error) {
    if (error.message === 'Пользователь не найден.') {
      sendError(res, 404, error.message);
      return;
    }
    sendError(res, error.message === ACCESS_DENIED_MESSAGE ? 403 : 400, error.message);
  }
}

function serveStatic(res, pathname, options = {}) {
  const safePath = pathname === '/' ? '/login.html' : pathname;
  const resolvedPath = path.join(PUBLIC_DIR, safePath.replace(/^\/+/, ''));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    return sendError(res, 403, 'Forbidden.');
  }

  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    return sendError(res, 404, 'File not found.');
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME_TYPES[extension] || 'application/octet-stream';
  const file = fs.readFileSync(resolvedPath);
  const headers = {
    'Content-Type': contentType,
  };

  if (options.noStore || extension === '.html') {
    headers['Cache-Control'] = 'no-store, max-age=0';
    headers.Pragma = 'no-cache';
    headers.Expires = '0';
  }

  res.writeHead(200, headers);
  res.end(file);
}

function serveLoginPage(req, res) {
  const authContext = getAuthenticatedRequestContext(req);
  if (authContext) {
    setSessionCookie(res, authContext.sessionId);
    sendRedirect(res, '/index.html');
    return;
  }

  clearSessionCookie(res);
  serveStatic(res, '/login.html', { noStore: true });
}

function serveAccessDeniedPage(res) {
  sendHtml(res, 403, `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${ACCESS_DENIED_MESSAGE}</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body class="auth-body">
  <main class="auth-shell">
    <section class="auth-card">
      <div class="auth-brand">
        <p class="eyebrow">CRM KPI</p>
        <h1>${ACCESS_DENIED_MESSAGE}</h1>
        <p class="hero-copy">У текущей роли нет прав для открытия этого раздела.</p>
      </div>
      <div class="auth-form-card">
        <div class="employee-form">
          <div>
            <p class="panel-kicker">Ограничение</p>
            <h2>${ACCESS_DENIED_MESSAGE}</h2>
          </div>
          <div class="form-actions auth-form-actions">
            <a class="primary-button" href="/index.html">Вернуться на KPI</a>
          </div>
        </div>
      </div>
    </section>
  </main>
</body>
</html>`);
}

function serveProtectedPage(req, res, pathname) {
  const authContext = getAuthenticatedRequestContext(req);
  if (!authContext) {
    clearSessionCookie(res);
    sendRedirect(res, '/');
    return;
  }

  if (!canAccessPage(authContext.user, pathname)) {
    setSessionCookie(res, authContext.sessionId);
    serveAccessDeniedPage(res);
    return;
  }

  setSessionCookie(res, authContext.sessionId);
  serveStatic(res, pathname, { noStore: true });
}

function ensureAdminApiAccess(res, authContext) {
  if (isAdminUser(authContext.user)) {
    return true;
  }

  sendError(res, 403, ACCESS_DENIED_MESSAGE);
  return false;
}

async function routeRequest(req, res) {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const pathname = urlObj.pathname;

    if ((pathname === '/' || pathname === '/login' || pathname === '/login.html') && req.method === 'GET') {
      serveLoginPage(req, res);
      return;
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/auth/periods' && req.method === 'GET') {
      handleAuthPeriods(res);
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      await handleLogin(req, res);
      return;
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      handleLogout(req, res);
      return;
    }

    if (pathname === '/api/auth/session' && req.method === 'GET') {
      handleAuthSession(req, res);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const authContext = requireAuthenticatedApiRequest(req, res);
      if (!authContext) {
        return;
      }

      if (pathname === '/api/dashboard' && req.method === 'GET') {
        handleDashboard(res, urlObj, authContext.user);
        return;
      }

      if (pathname === '/api/references' && req.method === 'GET') {
        handleReferenceData(res, authContext.user);
        return;
      }

      if (pathname === '/api/objects' && req.method === 'GET') {
        handleObjectsDirectory(res, urlObj, authContext.user);
        return;
      }

      if (pathname === '/api/staff' && req.method === 'GET') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        handleStaffDirectory(res, urlObj);
        return;
      }

      if (pathname === '/api/metrics' && req.method === 'GET') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        handleMetricsDirectory(res);
        return;
      }

      if (pathname === '/api/position-kpi' && req.method === 'GET') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        handlePositionKpiDirectory(res, urlObj);
        return;
      }

      if (pathname === '/api/users' && req.method === 'GET') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        handleUsersDirectory(req, res);
        return;
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        handleActionLogs(req, res, urlObj);
        return;
      }

      if (pathname === '/api/employees' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCreateEmployee(req, res);
        return;
      }

      if (pathname === '/api/employee-records' && req.method === 'POST') {
        await handleCreateEmployeeRecord(req, res);
        return;
      }

      if (pathname === '/api/kpi-periods/copy' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCopyPeriodData(req, res);
        return;
      }

      if (pathname === '/api/staff' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCreateStaff(req, res);
        return;
      }

      if (pathname === '/api/objects' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCreateObject(req, res);
        return;
      }

      if (pathname === '/api/metrics' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCreateMetric(req, res);
        return;
      }

      if (pathname === '/api/uploads/execution-discipline' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleExecutionDisciplineUpload(req, res);
        return;
      }

      if (pathname === '/api/uploads/contract-approvals' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleContractApprovalsUpload(req, res);
        return;
      }

      if (pathname === '/api/uploads/project-manager-export' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleProjectManagerExportUpload(req, res);
        return;
      }

      if (pathname === '/api/position-kpi/assignments' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCreatePositionAssignment(req, res);
        return;
      }

      if (pathname === '/api/users' && req.method === 'POST') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleCreateUser(req, res);
        return;
      }

      const employeeMatch = pathname.match(/^\/api\/employees\/(\d+)$/);
      if (employeeMatch && req.method === 'GET') {
        handleEmployeeDetail(res, urlObj, Number(employeeMatch[1]), authContext.user);
        return;
      }

      if (employeeMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdateEmployee(req, res, Number(employeeMatch[1]));
        return;
      }

      const employeeMetricMatch = pathname.match(/^\/api\/employee-records\/(\d+)\/metrics\/(\d+)$/);
      if (employeeMetricMatch && req.method === 'PATCH') {
        await handleUpdateEmployeeMetricValue(req, res, Number(employeeMetricMatch[1]), Number(employeeMetricMatch[2]));
        return;
      }

      const employeeRecordApproveMatch = pathname.match(/^\/api\/employee-records\/(\d+)\/approve$/);
      if (employeeRecordApproveMatch && req.method === 'PATCH') {
        await handleApproveEmployeeRecord(req, res, Number(employeeRecordApproveMatch[1]));
        return;
      }

      const employeeRecordUnapproveMatch = pathname.match(/^\/api\/employee-records\/(\d+)\/unapprove$/);
      if (employeeRecordUnapproveMatch && req.method === 'PATCH') {
        await handleUnapproveEmployeeRecord(req, res, Number(employeeRecordUnapproveMatch[1]));
        return;
      }

      const staffPeriodPositionMatch = pathname.match(/^\/api\/staff\/(\d+)\/period-position$/);
      if (staffPeriodPositionMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdateStaffPeriodPosition(req, res, Number(staffPeriodPositionMatch[1]));
        return;
      }

      const staffMatch = pathname.match(/^\/api\/staff\/(\d+)$/);
      if (staffMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdateStaff(req, res, Number(staffMatch[1]));
        return;
      }

      if (staffMatch && req.method === 'DELETE') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleDeleteStaff(req, res, Number(staffMatch[1]));
        return;
      }

      const objectMatch = pathname.match(/^\/api\/objects\/(\d+)$/);
      if (objectMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdateObject(req, res, Number(objectMatch[1]));
        return;
      }

      if (objectMatch && req.method === 'DELETE') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleDeleteObject(req, res, Number(objectMatch[1]));
        return;
      }

      const metricMatch = pathname.match(/^\/api\/metrics\/(\d+)$/);
      if (metricMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdateMetric(req, res, Number(metricMatch[1]));
        return;
      }

      if (metricMatch && req.method === 'DELETE') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleDeleteMetric(req, res, Number(metricMatch[1]));
        return;
      }

      const positionAssignmentMatch = pathname.match(/^\/api\/position-kpi\/assignments\/(\d+)$/);
      if (positionAssignmentMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdatePositionAssignment(req, res, Number(positionAssignmentMatch[1]));
        return;
      }

      if (positionAssignmentMatch && req.method === 'DELETE') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleDeletePositionAssignment(req, res, Number(positionAssignmentMatch[1]));
        return;
      }

      const userMatch = pathname.match(/^\/api\/users\/(\d+)$/);
      if (userMatch && req.method === 'PATCH') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleUpdateUser(req, res, Number(userMatch[1]));
        return;
      }

      if (userMatch && req.method === 'DELETE') {
        if (!ensureAdminApiAccess(res, authContext)) {
          return;
        }
        await handleDeleteUser(req, res, Number(userMatch[1]));
        return;
      }

      sendError(res, 404, 'Not found.');
      return;
    }

    if (req.method !== 'GET') {
      sendError(res, 405, 'Method not allowed.');
      return;
    }

    if (PROTECTED_PAGE_PATHS.has(pathname)) {
      serveProtectedPage(req, res, pathname);
      return;
    }

    serveStatic(res, pathname);
  } catch (error) {
    console.error(error);
    sendError(res, 500, 'Internal server error.');
  }
}

const server = http.createServer((req, res) => {
  void routeRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`KPI viewer running at http://${HOST}:${PORT}`);
});
