// SCRUM-94: the schema applies to an empty database, setup creates exactly one
// Super Admin, and a second run creates none.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SELECT_SUPER_ADMIN_SQL, insertSuperAdminSql, validateEmail } from '../scripts/setup-lib.js';

const schema = readFileSync(new URL('../migrations/0001_initial_schema.sql', import.meta.url), 'utf8');

function emptyDatabaseWithSchema() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return db;
}

test('schema creates all tables on an empty database', () => {
  const db = emptyDatabaseWithSchema();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['api_tokens', 'audit_log', 'check_results', 'email_verifications', 'organisations', 'requests', 'users']);
});

test('setup creates exactly one Super Admin, and a second run creates none', async () => {
  const db = emptyDatabaseWithSchema();
  db.exec(insertSuperAdminSql({ email: 'ops@example.com' }));
  db.exec(insertSuperAdminSql({ email: 'other@example.com' }));

  const admins = db.prepare(SELECT_SUPER_ADMIN_SQL).all();
  assert.deepEqual(admins.map((row) => row.email), ['ops@example.com']);

  const admin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  assert.equal(admin.organisation_id, null);
  assert.equal(admin.status, 'ACTIVE');
});

test('database refuses a second Super Admin even without the setup guard', () => {
  const db = emptyDatabaseWithSchema();
  const insert = "INSERT INTO users (email, first_name, last_name, role) VALUES (?, 'Super', 'Admin', 'SUPER_ADMIN')";
  db.prepare(insert).run('a@example.com');
  assert.throws(() => db.prepare(insert).run('b@example.com'), /UNIQUE constraint failed/);
});

test('organisation users need an organisation, the Super Admin must not have one', () => {
  const db = emptyDatabaseWithSchema();
  assert.throws(
    () => db.exec("INSERT INTO users (email, first_name, last_name, role) VALUES ('x@example.com', 'X', 'Y', 'ADMIN')"),
    /CHECK constraint failed/,
  );
});

test('e-mail input is quoted safely', async () => {
  const db = emptyDatabaseWithSchema();
  db.exec(insertSuperAdminSql({ email: "o'brien@example.com" }));
  assert.equal(db.prepare(SELECT_SUPER_ADMIN_SQL).get().email, "o'brien@example.com");
});

test('invalid e-mail is rejected', () => {
  assert.throws(() => validateEmail(undefined), /SUPER_ADMIN_EMAIL/);
  assert.throws(() => validateEmail('not-an-email'), /SUPER_ADMIN_EMAIL/);
});
