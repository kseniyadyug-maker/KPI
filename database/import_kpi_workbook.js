const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'kpi.sqlite');
const PARSER_PATH = path.join(__dirname, 'parse_kpi_workbook.ps1');
const OBJECT_ALIAS_MAP = new Map([
  ['«ЦПК «Лопатки турбина» ОДК-ПМ', '«ЦПК «Лопатки турбина» ОДК-ПМ»'],
]);

function normalizeText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseArgs(argv) {
  const args = {
    workbookPath: '',
    periodCode: '',
    parsedJsonPath: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--period') {
      args.periodCode = normalizeText(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === '--parsed-json') {
      args.parsedJsonPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (!args.workbookPath) {
      args.workbookPath = token;
    }
  }

  if (!args.workbookPath && !args.parsedJsonPath) {
    throw new Error('Usage: node database/import_kpi_workbook.js <workbook.xlsx> [--period 2026-04] [--parsed-json parsed.json]');
  }

  return args;
}

function runWorkbookParser(workbookPath) {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      PARSER_PATH,
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
    throw new Error((result.stderr || result.stdout || 'Workbook parser failed.').trim());
  }

  return JSON.parse(stripBom(result.stdout));
}

function readParsedWorkbook(parsedJsonPath) {
  return JSON.parse(stripBom(fs.readFileSync(parsedJsonPath, 'utf8')));
}

function isAtMostNorm(normText) {
  return normalizeText(normText).startsWith('≤');
}

function isScoreNorm(normText) {
  const normalized = normalizeText(normText).toLowerCase();
  return normalized.includes('оценка') || normalized.includes('балл') || /0\s*[–-]\s*5/.test(normalized);
}

function inferMetricInputType(metricName, normText) {
  const normalizedName = normalizeText(metricName).toLowerCase();
  if (normalizedName === 'исполнительская дисциплина') {
    return 'disc';
  }

  if (isScoreNorm(normText)) {
    return 'score';
  }

  return 'pct';
}

function extractNumericTarget(normText) {
  const match = normalizeText(normText).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function inferMetricDefinition(metricName, normText) {
  const inputType = inferMetricInputType(metricName, normText);
  if (inputType === 'score') {
    return {
      inputType,
      targetValue: null,
      maxValue: 5,
    };
  }

  const targetValue = extractNumericTarget(normText);
  return {
    inputType,
    targetValue,
    maxValue: targetValue && Number.isFinite(targetValue) ? targetValue : 100,
  };
}

function canonicalizePositionTitle(positionTitle, unitName) {
  const normalizedPosition = normalizeText(positionTitle);
  const normalizedUnit = normalizeText(unitName);

  const positionMap = new Map([
    ['Мастер / Рук. участка', 'Мастер / Руководитель участка'],
    ['Специалист', normalizedUnit.includes('РФГ') ? 'Специалист (РФГ)' : 'Специалист'],
    ['Руководитель группы', normalizedUnit.includes('РФГ') ? 'Руководитель группы (РФГ)' : 'Руководитель группы'],
    [
      'Специалист по экономике и финансам',
      normalizedUnit.includes('РФГ') ? 'Специалист по экономике и финансам (РФГ)' : 'Специалист по экономике и финансам',
    ],
    ['Менеджер по персоналу', normalizedUnit.includes('ОК') ? 'Менеджер по персоналу (ОК)' : 'Менеджер по персоналу'],
  ]);

  return positionMap.get(normalizedPosition) || normalizedPosition;
}

function canonicalizeUnitName(unitName, positionTitle) {
  const normalizedUnit = normalizeText(unitName);
  if (normalizedUnit && normalizedUnit !== '—' && normalizedUnit !== '-') {
    return normalizedUnit;
  }

  const normalizedPosition = normalizeText(positionTitle);
  if (
    normalizedPosition === 'Начальник ОМТО' ||
    normalizedPosition === 'Логист' ||
    normalizedPosition === 'Закупщик' ||
    normalizedPosition === 'Зав. складом / Кладовщик'
  ) {
    return 'ОМТО';
  }

  return normalizedUnit;
}

function buildMetricCode(groupCode, metricName) {
  const hash = crypto.createHash('sha1').update(`${groupCode}:${normalizeText(metricName)}`).digest('hex').slice(0, 12);
  return `${groupCode}_${hash}`;
}

function cleanupObjectAliases(db, summary) {
  const getObjectByNameStmt = db.prepare(`
    SELECT id
    FROM objects
    WHERE name = ?
  `);
  const insertObjectStmt = db.prepare(`
    INSERT INTO objects (name)
    VALUES (?)
  `);
  const reassignEmployeesStmt = db.prepare(`
    UPDATE employees
    SET current_object_id = ?
    WHERE current_object_id = ?
  `);
  const reassignRecordsStmt = db.prepare(`
    UPDATE employee_kpi_records
    SET
      object_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE object_id = ?
  `);
  const objectInUseStmt = db.prepare(`
    SELECT
      EXISTS(SELECT 1 FROM employees WHERE current_object_id = ?) AS employees_in_use,
      EXISTS(SELECT 1 FROM employee_kpi_records WHERE object_id = ?) AS records_in_use
  `);
  const deleteObjectStmt = db.prepare(`
    DELETE FROM objects
    WHERE id = ?
  `);
  const getUnusedObjectsStmt = db.prepare(`
    SELECT id, name
    FROM objects
    WHERE NOT EXISTS (SELECT 1 FROM employees WHERE current_object_id = objects.id)
      AND NOT EXISTS (SELECT 1 FROM employee_kpi_records WHERE object_id = objects.id)
  `);

  for (const [aliasName, canonicalName] of OBJECT_ALIAS_MAP.entries()) {
    const sourceObject = getObjectByNameStmt.get(aliasName);
    if (!sourceObject) {
      continue;
    }

    let targetObject = getObjectByNameStmt.get(canonicalName);
    if (!targetObject) {
      const insertResult = insertObjectStmt.run(canonicalName);
      targetObject = { id: Number(insertResult.lastInsertRowid) };
      summary.createdObjects += 1;
    }

    reassignEmployeesStmt.run(targetObject.id, sourceObject.id);
    reassignRecordsStmt.run(targetObject.id, sourceObject.id);

    const usage = objectInUseStmt.get(sourceObject.id, sourceObject.id);
    if (!usage.employees_in_use && !usage.records_in_use) {
      deleteObjectStmt.run(sourceObject.id);
      summary.deletedObjects += 1;
    }
  }

  const garbagePattern = /[?�]/;
  for (const row of getUnusedObjectsStmt.all()) {
    if (!garbagePattern.test(String(row.name || ''))) {
      continue;
    }
    deleteObjectStmt.run(row.id);
    summary.deletedObjects += 1;
  }
}

function recreateViews(db) {
  db.exec(`
    DROP VIEW IF EXISTS v_employee_kpi_totals;
    DROP VIEW IF EXISTS v_kpi_metric_calculations;

    CREATE VIEW v_kpi_metric_calculations AS
    WITH profile_positions AS (
      SELECT DISTINCT position_title
      FROM position_kpi_metric_assignments
    ),
    scoped_metrics AS (
      SELECT
        r.id AS record_id,
        p.id AS period_id,
        p.code AS period_code,
        p.label AS period_label,
        e.id AS employee_id,
        e.full_name,
        e.position_title,
        o.id AS object_id,
        o.name AS object_name,
        o.manager_name,
        g.id AS group_id,
        g.code AS group_code,
        g.name AS group_name,
        g.max_percent AS group_max_percent,
        m.id AS metric_id,
        m.code AS metric_code,
        m.name AS metric_name,
        COALESCE(pma.sort_order, m.sort_order) AS metric_sort_order,
        COALESCE(pma.weight, m.weight) AS weight,
        m.input_type,
        CASE
          WHEN pma.target_value IS NOT NULL THEN
            CASE
              WHEN m.input_type = 'score' THEN CAST(ROUND(pma.target_value, 3) AS TEXT) || ' б.'
              WHEN m.norm_text LIKE '≤%' AND m.norm_text LIKE '%дн%' THEN '≤ ' || CAST(ROUND(pma.target_value, 3) AS TEXT) || ' дн'
              WHEN m.norm_text LIKE '≤%' THEN '≤ ' || CAST(ROUND(pma.target_value, 3) AS TEXT) || '%'
              WHEN m.norm_text LIKE '%дн%' THEN CAST(ROUND(pma.target_value, 3) AS TEXT) || ' дн'
              WHEN m.norm_text LIKE '≥%' THEN '≥ ' || CAST(ROUND(pma.target_value, 3) AS TEXT) || '%'
              ELSE CAST(ROUND(pma.target_value, 3) AS TEXT) || '%'
            END
          ELSE m.norm_text
        END AS norm_text,
        m.max_value AS metric_max_value,
        pma.target_value,
        mv.raw_value,
        mv.agreed_percent
      FROM employee_kpi_metric_values mv
      JOIN employee_kpi_records r ON r.id = mv.record_id
      JOIN kpi_periods p ON p.id = r.period_id
      JOIN employees e ON e.id = r.employee_id
      JOIN objects o ON o.id = r.object_id
      JOIN kpi_metrics m ON m.id = mv.metric_id
      JOIN kpi_metric_groups g ON g.id = m.group_id
      LEFT JOIN position_kpi_metric_assignments pma
        ON pma.metric_id = m.id
       AND pma.position_title = e.position_title
      LEFT JOIN profile_positions pp
        ON pp.position_title = e.position_title
      WHERE m.is_active = 1
        AND (pp.position_title IS NULL OR pma.id IS NOT NULL)
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
          WHEN sm.target_value IS NOT NULL AND sm.target_value > 0 AND sm.norm_text LIKE '≤%' THEN
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
      e.position_title,
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
      e.position_title,
      o.id,
      o.name,
      o.manager_name,
      r.salary_rub,
      r.agreed_total_percent,
      r.is_approved,
      r.approved_at;
  `);
}

function importWorkbook(parsedWorkbook, requestedPeriodCode) {
  const db = new DatabaseSync(DB_PATH, { open: true });

  const getDefaultPeriodStmt = db.prepare(`
    SELECT id, code, label
    FROM kpi_periods
    ORDER BY
      CASE status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 ELSE 2 END,
      year_num DESC,
      month_num DESC
    LIMIT 1
  `);
  const getPeriodByCodeStmt = db.prepare(`
    SELECT id, code, label
    FROM kpi_periods
    WHERE code = ?
  `);
  const getGroupByCodeStmt = db.prepare(`
    SELECT id, code
    FROM kpi_metric_groups
    WHERE code = ?
  `);
  const getObjectByNameStmt = db.prepare(`
    SELECT id
    FROM objects
    WHERE name = ?
  `);
  const insertObjectStmt = db.prepare(`
    INSERT INTO objects (name)
    VALUES (?)
  `);
  const getEmployeeByFullNameStmt = db.prepare(`
    SELECT id
    FROM employees
    WHERE full_name = ?
  `);
  const insertEmployeeStmt = db.prepare(`
    INSERT INTO employees (full_name, position_title, current_object_id, is_active)
    VALUES (?, ?, ?, 1)
  `);
  const updateEmployeeStmt = db.prepare(`
    UPDATE employees
    SET
      position_title = ?,
      current_object_id = ?,
      is_active = 1
    WHERE id = ?
  `);
  const updateEmployeeRecordsObjectStmt = db.prepare(`
    UPDATE employee_kpi_records
    SET
      object_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE employee_id = ?
  `);
  const getEmployeeRecordStmt = db.prepare(`
    SELECT id
    FROM employee_kpi_records
    WHERE period_id = ? AND employee_id = ?
  `);
  const insertEmployeeRecordStmt = db.prepare(`
    INSERT INTO employee_kpi_records (
      period_id,
      employee_id,
      object_id,
      salary_rub,
      agreed_total_percent,
      is_approved,
      approved_at,
      note
    )
    VALUES (?, ?, ?, NULL, NULL, 0, NULL, 'Imported from Excel workbook')
  `);
  const getMetricByGroupNameStmt = db.prepare(`
    SELECT id, weight
    FROM kpi_metrics
    WHERE group_id = ? AND name = ?
    LIMIT 1
  `);
  const getMetricByCodeStmt = db.prepare(`
    SELECT id
    FROM kpi_metrics
    WHERE code = ?
    LIMIT 1
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
  const updateMetricDefinitionStmt = db.prepare(`
    UPDATE kpi_metrics
    SET
      input_type = ?,
      norm_text = ?,
      min_value = ?,
      max_value = ?,
      is_active = 1
    WHERE id = ?
  `);
  const getAssignmentStmt = db.prepare(`
    SELECT id
    FROM position_kpi_metric_assignments
    WHERE position_title = ? AND metric_id = ?
  `);
  const insertAssignmentStmt = db.prepare(`
    INSERT INTO position_kpi_metric_assignments (
      position_title,
      metric_id,
      weight,
      target_value,
      sort_order
    )
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateAssignmentStmt = db.prepare(`
    UPDATE position_kpi_metric_assignments
    SET
      weight = ?,
      target_value = ?,
      sort_order = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const ensureMetricValuesForMetricStmt = db.prepare(`
    INSERT OR IGNORE INTO employee_kpi_metric_values (
      record_id,
      metric_id,
      raw_value,
      agreed_percent,
      import_batch_id,
      note
    )
    SELECT
      r.id,
      ?,
      0,
      NULL,
      NULL,
      'Auto-created for imported metric'
    FROM employee_kpi_records r
  `);
  const ensureMetricValuesForRecordStmt = db.prepare(`
    INSERT OR IGNORE INTO employee_kpi_metric_values (
      record_id,
      metric_id,
      raw_value,
      agreed_percent,
      import_batch_id,
      note
    )
    SELECT
      ?,
      m.id,
      0,
      NULL,
      NULL,
      'Auto-created for imported employee record'
    FROM kpi_metrics m
    WHERE m.is_active = 1
  `);

  const periodRow = requestedPeriodCode
    ? getPeriodByCodeStmt.get(requestedPeriodCode)
    : getDefaultPeriodStmt.get();
  if (!periodRow) {
    throw new Error(`KPI period not found${requestedPeriodCode ? `: ${requestedPeriodCode}` : ''}`);
  }

  const groupRows = {
    block_a: getGroupByCodeStmt.get('block_a'),
    block_b: getGroupByCodeStmt.get('block_b'),
  };
  if (!groupRows.block_a || !groupRows.block_b) {
    throw new Error('KPI metric groups block_a/block_b are missing in database.');
  }

  const metricSortOrders = new Map();
  for (const groupCode of Object.keys(groupRows)) {
    const groupId = groupRows[groupCode].id;
    metricSortOrders.set(groupId, Number(getMaxMetricSortOrderStmt.get(groupId).max_sort_order || 0));
  }

  const summary = {
    periodCode: periodRow.code,
    createdObjects: 0,
    deletedObjects: 0,
    createdEmployees: 0,
    updatedEmployees: 0,
    createdMetrics: 0,
    updatedMetrics: 0,
    createdAssignments: 0,
    updatedAssignments: 0,
    createdRecords: 0,
  };

  const positionProfiles = new Map();
  const metricsByKey = new Map();

  for (const rawRow of parsedWorkbook.kpiRows || []) {
    const positionTitle = canonicalizePositionTitle(rawRow.positionTitle, '');
    const metricName = normalizeText(rawRow.metricName);
    const blockCode = normalizeText(rawRow.blockCode);
    const normText = normalizeText(rawRow.normText);
    if (!positionTitle || !metricName || !blockCode) {
      continue;
    }

    const definition = inferMetricDefinition(metricName, normText);
    const metricKey = `${blockCode}::${metricName}`;
    if (!metricsByKey.has(metricKey)) {
      metricsByKey.set(metricKey, {
        blockCode,
        metricName,
        normText,
        inputType: definition.inputType,
        maxValue: definition.maxValue,
      });
    }

    const assignment = {
      blockCode,
      metricName,
      normText,
      inputType: definition.inputType,
      weight: Number(rawRow.weight),
      targetValue: definition.targetValue,
      sortOrder: Number(rawRow.sortOrder),
    };

    if (!positionProfiles.has(positionTitle)) {
      positionProfiles.set(positionTitle, []);
    }
    positionProfiles.get(positionTitle).push(assignment);
  }

  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');

  try {
    const metricIdByKey = new Map();

    for (const metric of metricsByKey.values()) {
      const groupId = groupRows[metric.blockCode].id;
      const existingMetric = getMetricByGroupNameStmt.get(groupId, metric.metricName);

      if (existingMetric) {
        updateMetricDefinitionStmt.run(metric.inputType, metric.normText, 0, metric.maxValue, existingMetric.id);
        metricIdByKey.set(`${metric.blockCode}::${metric.metricName}`, Number(existingMetric.id));
        summary.updatedMetrics += 1;
        continue;
      }

      let metricCode = buildMetricCode(metric.blockCode, metric.metricName);
      if (getMetricByCodeStmt.get(metricCode)) {
        metricCode = `${metricCode}_${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`;
      }

      const nextSortOrder = metricSortOrders.get(groupId) + 1;
      metricSortOrders.set(groupId, nextSortOrder);

      const insertResult = insertMetricStmt.run(
        groupId,
        metricCode,
        metric.metricName,
        metric.blockCode === 'block_b' ? 0 : 0,
        metric.inputType,
        metric.normText,
        0,
        metric.maxValue,
        nextSortOrder
      );

      const metricId = Number(insertResult.lastInsertRowid);
      ensureMetricValuesForMetricStmt.run(metricId);
      metricIdByKey.set(`${metric.blockCode}::${metric.metricName}`, metricId);
      summary.createdMetrics += 1;
    }

    for (const rawEmployee of parsedWorkbook.employees || []) {
      const fullName = normalizeText(rawEmployee.fullName);
      const unitName = canonicalizeUnitName(rawEmployee.unitName, rawEmployee.positionTitle);
      const positionTitle = canonicalizePositionTitle(rawEmployee.positionTitle, unitName);
      if (!fullName || !unitName || !positionTitle) {
        continue;
      }

      let objectRow = getObjectByNameStmt.get(unitName);
      if (!objectRow) {
        const objectInsert = insertObjectStmt.run(unitName);
        objectRow = { id: Number(objectInsert.lastInsertRowid) };
        summary.createdObjects += 1;
      }

      let employeeRow = getEmployeeByFullNameStmt.get(fullName);
      if (!employeeRow) {
        const employeeInsert = insertEmployeeStmt.run(fullName, positionTitle, objectRow.id);
        employeeRow = { id: Number(employeeInsert.lastInsertRowid) };
        summary.createdEmployees += 1;
      } else {
        updateEmployeeStmt.run(positionTitle, objectRow.id, employeeRow.id);
        summary.updatedEmployees += 1;
      }

      updateEmployeeRecordsObjectStmt.run(objectRow.id, employeeRow.id);

      let recordRow = getEmployeeRecordStmt.get(periodRow.id, employeeRow.id);
      if (!recordRow) {
        const recordInsert = insertEmployeeRecordStmt.run(periodRow.id, employeeRow.id, objectRow.id);
        recordRow = { id: Number(recordInsert.lastInsertRowid) };
        summary.createdRecords += 1;
      }

      ensureMetricValuesForRecordStmt.run(recordRow.id);
    }

    for (const [positionTitle, assignments] of positionProfiles.entries()) {
      for (const assignment of assignments) {
        const metricId = metricIdByKey.get(`${assignment.blockCode}::${assignment.metricName}`);
        if (!metricId) {
          throw new Error(`Metric not resolved for assignment: ${assignment.metricName}`);
        }

        const existingAssignment = getAssignmentStmt.get(positionTitle, metricId);
        if (!existingAssignment) {
          insertAssignmentStmt.run(
            positionTitle,
            metricId,
            assignment.weight,
            assignment.targetValue,
            assignment.sortOrder
          );
          summary.createdAssignments += 1;
          continue;
        }

        updateAssignmentStmt.run(
          assignment.weight,
          assignment.targetValue,
          assignment.sortOrder,
          existingAssignment.id
        );
        summary.updatedAssignments += 1;
      }
    }

    cleanupObjectAliases(db, summary);
    recreateViews(db);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    db.close();
  }

  return summary;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const parsedWorkbook = args.parsedJsonPath
    ? readParsedWorkbook(path.resolve(args.parsedJsonPath))
    : runWorkbookParser(path.resolve(args.workbookPath));
  const summary = importWorkbook(parsedWorkbook, args.periodCode);
  console.log(JSON.stringify(summary, null, 2));
}

main();
