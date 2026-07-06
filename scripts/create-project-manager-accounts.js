const { randomBytes, scryptSync } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = path.resolve(__dirname, "..");
const DATABASE_PATHS = [
  path.join(ROOT_DIR, "database", "kpi.sqlite"),
  path.join(ROOT_DIR, "server-publish-work", "database", "kpi.sqlite"),
];

const PROJECT_MANAGER_EMPLOYEE_IDS = new Map([
  [32, { login: "goldyrev_na", password: "KpiPm2026!NA" }],
  [33, { login: "mukhin_as", password: "KpiPm2026!AS" }],
  [34, { login: "orlov_vm", password: "KpiPm2026!VM" }],
  [35, { login: "sorokin_ds", password: "KpiPm2026!DS" }],
  [36, { login: "yuzhanin_an", password: "KpiPm2026!AN" }],
]);

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(String(password ?? ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${derivedKey}`;
}

function normalizeEmployeeShortName(fullName) {
  const parts = String(fullName ?? "").trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (parts.length < 3) {
    return String(fullName ?? "").trim();
  }

  return `${parts[0]} ${parts[1][0].toUpperCase()}.${parts[2][0].toUpperCase()}.`;
}

function syncDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = new DatabaseSync(dbPath, { open: true });
  const selectEmployeeStmt = db.prepare(`
    SELECT id, full_name
    FROM employees
    WHERE id = ?
  `);
  const selectUserByLoginStmt = db.prepare(`
    SELECT id
    FROM auth_users
    WHERE login = ?
  `);
  const insertUserStmt = db.prepare(`
    INSERT INTO auth_users (
      login,
      display_name,
      employee_short_name,
      role_code,
      password_hash,
      is_active
    )
    VALUES (?, ?, ?, 'manager', ?, 1)
  `);
  const updateUserStmt = db.prepare(`
    UPDATE auth_users
    SET
      display_name = ?,
      employee_short_name = ?,
      role_code = 'manager',
      password_hash = ?,
      is_active = 1,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const linkObjectsStmt = db.prepare(`
    UPDATE objects
    SET manager_user_id = ?
    WHERE TRIM(COALESCE(manager_name, '')) = ?
  `);
  const countLinkedObjectsStmt = db.prepare(`
    SELECT COUNT(*) AS count
    FROM objects
    WHERE manager_user_id = ?
  `);

  const results = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [employeeId, credentials] of PROJECT_MANAGER_EMPLOYEE_IDS.entries()) {
      const employeeRow = selectEmployeeStmt.get(employeeId);
      if (!employeeRow) {
        results.push({
          action: "skipped",
          employeeId,
          login: credentials.login,
          reason: "employee_not_found",
        });
        continue;
      }

      const fullName = String(employeeRow.full_name).trim();
      const shortName = normalizeEmployeeShortName(fullName);
      const passwordHash = hashPassword(credentials.password);
      const existingUser = selectUserByLoginStmt.get(credentials.login);

      let userId = null;
      let action = "created";
      if (existingUser) {
        userId = Number(existingUser.id);
        updateUserStmt.run(fullName, shortName, passwordHash, userId);
        action = "updated";
      } else {
        const insertResult = insertUserStmt.run(
          credentials.login,
          fullName,
          shortName,
          passwordHash
        );
        userId = Number(insertResult.lastInsertRowid);
      }

      linkObjectsStmt.run(userId, fullName);
      const linkedObjects = Number(countLinkedObjectsStmt.get(userId)?.count || 0);

      results.push({
        action,
        employeeId,
        userId,
        login: credentials.login,
        password: credentials.password,
        fullName,
        linkedObjects,
      });
    }

    db.exec("COMMIT");
    return results;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    db.close();
  }
}

const summary = DATABASE_PATHS.map((dbPath) => ({
  dbPath: path.relative(ROOT_DIR, dbPath),
  results: syncDatabase(dbPath),
}));

console.log(JSON.stringify(summary, null, 2));
