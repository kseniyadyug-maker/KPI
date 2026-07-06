PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

DROP VIEW IF EXISTS v_employee_kpi_totals;
DROP VIEW IF EXISTS v_kpi_metric_calculations;

DROP TABLE IF EXISTS app_action_logs;
DROP TABLE IF EXISTS project_manager_export_object_values;
DROP TABLE IF EXISTS employee_kpi_metric_values;
DROP TABLE IF EXISTS employee_kpi_records;
DROP TABLE IF EXISTS import_batches;
DROP TABLE IF EXISTS position_kpi_metric_assignments;
DROP TABLE IF EXISTS kpi_metrics;
DROP TABLE IF EXISTS kpi_metric_groups;
DROP TABLE IF EXISTS kpi_periods;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS objects;
DROP TABLE IF EXISTS auth_users;

-- Р‘Р°Р·Р° СЃРїСЂРѕРµРєС‚РёСЂРѕРІР°РЅР° РїРѕРґ С‚РµРєСѓС‰РёР№ HTML-С„Р°Р№Р» Рё СЃР»РµРґСѓСЋС‰РёР№ СЌС‚Р°Рї:
-- React-СЃС‚СЂР°РЅРёС†Р° РґР»СЏ РІРІРѕРґР°, РёРјРїРѕСЂС‚Р° Excel/CSV, СЂР°СЃС‡РµС‚Р° KPI Рё СЃРµСЂРІРµСЂРЅРѕР№ HTML-РІС‹РіСЂСѓР·РєРё.
--
-- РџСЂРёРЅСЏС‚С‹Рµ РµРґРёРЅРёС†С‹ С…СЂР°РЅРµРЅРёСЏ:
-- 1. raw_value РґР»СЏ pct/disc С…СЂР°РЅРёС‚СЃСЏ РєР°Рє 0..100
-- 2. raw_value РґР»СЏ score С…СЂР°РЅРёС‚СЃСЏ РєР°Рє 0..5
-- 3. agreed_percent Рё РёС‚РѕРіРё С…СЂР°РЅСЏС‚СЃСЏ РІ "РїСЂРѕС†РµРЅС‚РЅС‹С… РїСѓРЅРєС‚Р°С… РѕС‚ РѕРєР»Р°РґР°", С‚Рѕ РµСЃС‚СЊ 0..40

CREATE TABLE auth_users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  employee_short_name TEXT NOT NULL,
  role_code TEXT NOT NULL DEFAULT 'admin' CHECK (role_code IN ('admin', 'boss', 'manager')),
  password_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
) STRICT;

CREATE TABLE app_action_logs (
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

CREATE TABLE objects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  manager_name TEXT,
  manager_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  employee_code TEXT UNIQUE,
  full_name TEXT NOT NULL,
  position_title TEXT NOT NULL,
  current_object_id INTEGER REFERENCES objects(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE kpi_periods (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  year_num INTEGER NOT NULL,
  month_num INTEGER NOT NULL CHECK (month_num BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE kpi_metric_groups (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  max_percent REAL NOT NULL CHECK (max_percent >= 0),
  sort_order INTEGER NOT NULL
) STRICT;

CREATE TABLE kpi_metrics (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES kpi_metric_groups(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 0 AND weight <= 1),
  input_type TEXT NOT NULL CHECK (input_type IN ('score', 'pct', 'disc')),
  norm_text TEXT,
  min_value REAL NOT NULL DEFAULT 0,
  max_value REAL NOT NULL CHECK (max_value >= 0),
  sort_order INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

CREATE TABLE position_kpi_metric_assignments (
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

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  period_id INTEGER REFERENCES kpi_periods(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'csv', 'excel')),
  file_name TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE project_manager_export_object_values (
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

CREATE TABLE employee_kpi_records (
  id INTEGER PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES kpi_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  object_id INTEGER NOT NULL REFERENCES objects(id) ON DELETE RESTRICT,
  position_title_snapshot TEXT,
  salary_rub REAL CHECK (salary_rub IS NULL OR salary_rub >= 0),
  agreed_total_percent REAL CHECK (agreed_total_percent IS NULL OR (agreed_total_percent >= 0 AND agreed_total_percent <= 40)),
  is_approved INTEGER NOT NULL DEFAULT 0 CHECK (is_approved IN (0, 1)),
  approved_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES auth_users(id) ON DELETE SET NULL,
  request_status TEXT NOT NULL DEFAULT 'draft' CHECK (request_status IN ('draft', 'approved')),
  UNIQUE (period_id, employee_id)
) STRICT;

CREATE TABLE employee_kpi_metric_values (
  id INTEGER PRIMARY KEY,
  record_id INTEGER NOT NULL REFERENCES employee_kpi_records(id) ON DELETE CASCADE,
  metric_id INTEGER NOT NULL REFERENCES kpi_metrics(id) ON DELETE RESTRICT,
  raw_value REAL NOT NULL CHECK (raw_value >= 0),
  agreed_percent REAL CHECK (agreed_percent IS NULL OR (agreed_percent >= 0 AND agreed_percent <= 40)),
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  note TEXT,
  group_id_snapshot INTEGER,
  group_code_snapshot TEXT,
  group_name_snapshot TEXT,
  group_max_percent_snapshot REAL,
  metric_code_snapshot TEXT,
  metric_name_snapshot TEXT,
  metric_sort_order_snapshot INTEGER,
  weight_snapshot REAL,
  input_type_snapshot TEXT,
  norm_text_snapshot TEXT,
  min_value_snapshot REAL,
  max_value_snapshot REAL,
  target_value_snapshot REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (record_id, metric_id)
) STRICT;

CREATE INDEX idx_employees_full_name ON employees(full_name);
CREATE UNIQUE INDEX idx_employees_full_name_unique ON employees(full_name);
CREATE INDEX idx_employees_object ON employees(current_object_id);
CREATE INDEX idx_auth_users_active ON auth_users(is_active);
CREATE INDEX idx_auth_users_role ON auth_users(role_code);
CREATE INDEX idx_auth_users_employee_short_name ON auth_users(employee_short_name);
CREATE INDEX idx_app_action_logs_created_at ON app_action_logs(created_at DESC);
CREATE INDEX idx_app_action_logs_actor_user ON app_action_logs(actor_user_id);
CREATE INDEX idx_objects_manager_user ON objects(manager_user_id);
CREATE INDEX idx_records_period ON employee_kpi_records(period_id);
CREATE INDEX idx_records_object ON employee_kpi_records(object_id);
CREATE INDEX idx_records_employee ON employee_kpi_records(employee_id);
CREATE INDEX idx_records_created_by_user ON employee_kpi_records(created_by_user_id);
CREATE INDEX idx_records_updated_by_user ON employee_kpi_records(updated_by_user_id);
CREATE INDEX idx_metric_values_record ON employee_kpi_metric_values(record_id);
CREATE INDEX idx_metric_values_metric ON employee_kpi_metric_values(metric_id);
CREATE INDEX idx_import_batches_period ON import_batches(period_id);
CREATE INDEX idx_project_manager_export_period ON project_manager_export_object_values(period_id);
CREATE INDEX idx_project_manager_export_employee ON project_manager_export_object_values(employee_id);
CREATE INDEX idx_position_assignments_position ON position_kpi_metric_assignments(position_title);
CREATE INDEX idx_position_assignments_metric ON position_kpi_metric_assignments(metric_id);

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

INSERT INTO objects (name, manager_name) VALUES
  ('В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ', NULL),
  ('РЎС‚СЂ-РІРѕ Р»РёРЅРёРё РІРѕРґРѕСЃРЅР°Р±Р¶РµРЅРёСЏ РІ СЃ. РљРѕР»РІР°, 2 СЌС‚Р°Рї', NULL),
  ('Р›РµРґРѕРІР°СЏ Р°СЂРµРЅР° Рі. Р§РµСЂРЅСѓС€РєР°', NULL),
  ('РџСЂРѕРёР·РІРѕРґСЃС‚РІРµРЅРЅР°СЏ Р±Р°Р·Р° РџСЂРѕРјС‹С€Р»РµРЅРЅР°СЏ 80Рђ', NULL),
  ('РЎС‚СЂ-РІРѕ РђР‘Рљ РўРџРџ В«Р§РµСЂРЅСѓС€РєР°РЅРµС„С‚РµРіР°Р·В»', NULL),
  ('РЎС‚СѓРґРµРЅС‡РµСЃРєРёР№ РєР°РјРїСѓСЃ', NULL);

INSERT INTO employees (employee_code, full_name, position_title, current_object_id) VALUES
  (NULL, 'РљСѓС€РѕРІ Р•РІРіРµРЅРёР№ Р’РёРєС‚РѕСЂРѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'Р”СѓРґРёРЅ РљРѕРЅСЃС‚Р°РЅС‚РёРЅ РђР»РµРєСЃР°РЅРґСЂРѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'РҐР°СЂС‡РµРЅРєРѕ Р›РµРѕРЅРёРґ РњРёС…Р°Р№Р»РѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'РџРѕРґСЂСЏРґС‡РёРєРѕРІ Р’Р°РґРёРј Р’Р°СЃРёР»СЊРµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'РЎРєРѕСЃР°СЂРµРІ Р’РёРєС‚РѕСЂ РРІР°РЅРѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'РљРѕС‚РѕРјРёРЅ РђРЅР°С‚РѕР»РёР№ РќРёРєРѕР»Р°РµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'РњРёС‚СЂРѕС„Р°РЅРѕРІ Р®СЂРёР№ Р“РµРЅРЅР°РґСЊРµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'В«Р¦РџРљ В«Р›РѕРїР°С‚РєРё С‚СѓСЂР±РёРЅР°В» РћР”Рљ-РџРњ')),
  (NULL, 'Р­Р»РёРјР±Р°РµРІ РСЃР»Р°Рј Р­РјРёРЅРѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СЂ-РІРѕ Р»РёРЅРёРё РІРѕРґРѕСЃРЅР°Р±Р¶РµРЅРёСЏ РІ СЃ. РљРѕР»РІР°, 2 СЌС‚Р°Рї')),
  (NULL, 'Р—РёРЅСЊ Р”РјРёС‚СЂРёР№ РРіРѕСЂРµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'Р›РµРґРѕРІР°СЏ Р°СЂРµРЅР° Рі. Р§РµСЂРЅСѓС€РєР°')),
  (NULL, 'Р§СѓРєР»РёРЅРѕРІ РђР»РµРєСЃРµР№ РђР»РµРєСЃР°РЅРґСЂРѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'Р›РµРґРѕРІР°СЏ Р°СЂРµРЅР° Рі. Р§РµСЂРЅСѓС€РєР°')),
  (NULL, 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РџСЂРѕРёР·РІРѕРґСЃС‚РІРµРЅРЅР°СЏ Р±Р°Р·Р° РџСЂРѕРјС‹С€Р»РµРЅРЅР°СЏ 80Рђ')),
  (NULL, 'Р•РіРѕСЂРѕРІ РРіРѕСЂСЊ РђРЅР°С‚РѕР»СЊРµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СЂ-РІРѕ РђР‘Рљ РўРџРџ В«Р§РµСЂРЅСѓС€РєР°РЅРµС„С‚РµРіР°Р·В»')),
  (NULL, 'Р‘РѕСЂС†РѕРІ Р’Р»Р°РґРёРјРёСЂ РќРёРєРѕР»Р°РµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СЂ-РІРѕ РђР‘Рљ РўРџРџ В«Р§РµСЂРЅСѓС€РєР°РЅРµС„С‚РµРіР°Р·В»')),
  (NULL, 'Р‘Р°С€РєРѕРІ Р’Р°СЃРёР»РёР№ РџР°РІР»РѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СЂ-РІРѕ РђР‘Рљ РўРџРџ В«Р§РµСЂРЅСѓС€РєР°РЅРµС„С‚РµРіР°Р·В»')),
  (NULL, 'РЎРµРјРµРЅРѕРІ РЎС‚Р°РЅРёСЃР»Р°РІ Р’Р»Р°РґРёРјРёСЂРѕРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СЂ-РІРѕ РђР‘Рљ РўРџРџ В«Р§РµСЂРЅСѓС€РєР°РЅРµС„С‚РµРіР°Р·В»')),
  (NULL, 'Р“Р°С„РµС‚РґРёРЅРѕРІ РњР°РєСЃРёРј РђСЂСЃРµРЅСЊРµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СѓРґРµРЅС‡РµСЃРєРёР№ РєР°РјРїСѓСЃ')),
  (NULL, 'Р Р°С‡РµРІ Р”РµРЅРёСЃ Р’Р°Р»РµСЂСЊРµРІРёС‡', 'РњР°СЃС‚РµСЂ / Р СѓРє. СѓС‡Р°СЃС‚РєР°', (SELECT id FROM objects WHERE name = 'РЎС‚СѓРґРµРЅС‡РµСЃРєРёР№ РєР°РјРїСѓСЃ'));

INSERT INTO kpi_periods (code, label, year_num, month_num, status) VALUES
  ('2026-04', 'РђРїСЂРµР»СЊ 2026', 2026, 4, 'open');

INSERT INTO kpi_metric_groups (code, name, max_percent, sort_order) VALUES
  ('block_a', 'Р‘Р»РѕРє Рђ вЂ” РРЅРґРёРІРёРґСѓР°Р»СЊРЅС‹Рµ РїРѕРєР°Р·Р°С‚РµР»Рё', 8.0, 1),
  ('block_b', 'Р‘Р»РѕРє Р‘ вЂ” РљР»СЋС‡РµРІС‹Рµ РїРѕРєР°Р·Р°С‚РµР»Рё РґРµСЏС‚РµР»СЊРЅРѕСЃС‚Рё', 32.0, 2);

INSERT INTO kpi_metrics (group_id, code, name, weight, input_type, norm_text, min_value, max_value, sort_order) VALUES
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_a'), 'job_instruction_execution', 'Р’С‹РїРѕР»РЅРµРЅРёРµ РїСѓРЅРєС‚РѕРІ РґРѕР»Р¶РЅРѕСЃС‚РЅРѕР№ РёРЅСЃС‚СЂСѓРєС†РёРё', 0.30, 'score', '0вЂ“5 Р±.', 0, 5, 1),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_a'), 'responsibility_zones', 'Р—РѕРЅС‹ РѕС‚РІРµС‚СЃС‚РІРµРЅРЅРѕСЃС‚Рё', 0.30, 'score', '0вЂ“5 Р±.', 0, 5, 2),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_a'), 'manager_control', 'РљРѕРЅС‚СЂРѕР»СЊ СЂСѓРєРѕРІРѕРґРёС‚РµР»СЏ', 0.10, 'score', '0вЂ“5 Р±.', 0, 5, 3),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_a'), 'work_quality', 'РљР°С‡РµСЃС‚РІРѕ СЂР°Р±РѕС‚С‹', 0.30, 'score', '0вЂ“5 Р±.', 0, 5, 4),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_b'), 'smr_schedule_execution', 'РСЃРїРѕР»РЅРµРЅРёРµ Р“СЂР°С„РёРєР° РїСЂРѕРёР·РІРѕРґСЃС‚РІР° РЎРњР ', 0.40, 'pct', 'в‰Ґ100%', 0, 100, 1),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_b'), 'safety_compliance', 'РЎРѕР±Р»СЋРґРµРЅРёРµ РЅРѕСЂРј С‚РµС…РЅРёРєРё Р±РµР·РѕРїР°СЃРЅРѕСЃС‚Рё', 0.15, 'pct', 'в‰Ґ100%', 0, 100, 2),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_b'), 'production_culture', 'РљСѓР»СЊС‚СѓСЂР° РїСЂРѕРёР·РІРѕРґСЃС‚РІР°', 0.10, 'score', '0вЂ“5 Р±.', 0, 5, 3),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_b'), 'materials_requests_docs', 'Р—Р°СЏРІРєРё / РўРњР¦ / Р”РѕРєСѓРјРµРЅС‚РѕРѕР±РѕСЂРѕС‚', 0.15, 'score', '0вЂ“5 Р±.', 0, 5, 4),
  ((SELECT id FROM kpi_metric_groups WHERE code = 'block_b'), 'execution_discipline', 'РСЃРїРѕР»РЅРёС‚РµР»СЊСЃРєР°СЏ РґРёСЃС†РёРїР»РёРЅР°', 0.20, 'disc', '0вЂ“100%', 0, 100, 5);

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
SELECT
  p.id,
  e.id,
  e.current_object_id,
  NULL,
  NULL,
  0,
  NULL,
  'РЎС‚Р°СЂС‚РѕРІС‹Р№ РїРµСЂРµРЅРѕСЃ РёР· Р»РѕРєР°Р»СЊРЅРѕРіРѕ HTML-РґР°С€Р±РѕСЂРґР°'
FROM employees e
CROSS JOIN kpi_periods p
WHERE p.code = '2026-04';

INSERT INTO employee_kpi_metric_values (
  record_id,
  metric_id,
  raw_value,
  agreed_percent,
  import_batch_id,
  note
)
SELECT
  r.id,
  m.id,
  CASE
    WHEN m.code IN ('job_instruction_execution', 'responsibility_zones', 'manager_control', 'work_quality') THEN
      CASE
        WHEN e.full_name IN ('РљРѕС‚РѕРјРёРЅ РђРЅР°С‚РѕР»РёР№ РќРёРєРѕР»Р°РµРІРёС‡', 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡') THEN 0
        ELSE 5
      END
    WHEN m.code = 'smr_schedule_execution' THEN
      CASE
        WHEN e.full_name IN ('РљРѕС‚РѕРјРёРЅ РђРЅР°С‚РѕР»РёР№ РќРёРєРѕР»Р°РµРІРёС‡', 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡') THEN 0
        WHEN e.full_name IN ('Р—РёРЅСЊ Р”РјРёС‚СЂРёР№ РРіРѕСЂРµРІРёС‡', 'Р§СѓРєР»РёРЅРѕРІ РђР»РµРєСЃРµР№ РђР»РµРєСЃР°РЅРґСЂРѕРІРёС‡') THEN 95
        ELSE 100
      END
    WHEN m.code = 'safety_compliance' THEN
      CASE
        WHEN e.full_name IN ('РљРѕС‚РѕРјРёРЅ РђРЅР°С‚РѕР»РёР№ РќРёРєРѕР»Р°РµРІРёС‡', 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡') THEN 0
        WHEN e.full_name IN ('Р—РёРЅСЊ Р”РјРёС‚СЂРёР№ РРіРѕСЂРµРІРёС‡', 'Р§СѓРєР»РёРЅРѕРІ РђР»РµРєСЃРµР№ РђР»РµРєСЃР°РЅРґСЂРѕРІРёС‡') THEN 95
        ELSE 100
      END
    WHEN m.code = 'production_culture' THEN
      CASE
        WHEN e.full_name = 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡' THEN 0
        ELSE 5
      END
    WHEN m.code = 'materials_requests_docs' THEN
      CASE
        WHEN e.full_name = 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡' THEN 0
        ELSE 5
      END
    WHEN m.code = 'execution_discipline' THEN
      CASE
        WHEN e.full_name = 'Р—РёРЅСЊ Р”РјРёС‚СЂРёР№ РРіРѕСЂРµРІРёС‡' THEN 76
        WHEN e.full_name = 'Р§СѓРєР»РёРЅРѕРІ РђР»РµРєСЃРµР№ РђР»РµРєСЃР°РЅРґСЂРѕРІРёС‡' THEN 72
        WHEN e.full_name = 'РћРіРЅРµРІ Р СѓСЃР»Р°РЅ Р›РµС‡РѕРІРёС‡' THEN 57
        ELSE 30
      END
    ELSE 0
  END AS raw_value,
  NULL AS agreed_percent,
  NULL AS import_batch_id,
  'РЎС‚Р°СЂС‚РѕРІС‹Рµ РґР°РЅРЅС‹Рµ РёР· HTML'
FROM employee_kpi_records r
JOIN employees e ON e.id = r.employee_id
JOIN kpi_periods p ON p.id = r.period_id
CROSS JOIN kpi_metrics m
WHERE p.code = '2026-04';

COMMIT;

