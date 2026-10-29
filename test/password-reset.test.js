// SCRUM-15: a forgotten password can be reset by e-mail; the link works once,
// expires, the old password stops working and the reset is audited in UTC.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { hashPassword, verifyPassword } from '../src/password.js';
import { confirmPasswordReset, requestPasswordReset } from '../src/password-reset.js';
import { login } from '../src/session.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let db;
let mails;
let now;
const deps = () => ({ db, mailer: { send: async (mail) => void mails.push(mail) }, baseUrl: 'https://bpc.test', now });
const tokenIn = (mail) => mail.text.match(/#token=([\w-]+)/)[1];
const passwordHash = (email) => sqlite.prepare('SELECT password_hash FROM users WHERE email = ?').get(email).password_hash;
const auditActions = () => sqlite.prepare('SELECT action, created_at FROM audit_log ORDER BY id').all();

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec("INSERT INTO organisations (id, name, fn) VALUES (1, 'Bau GmbH', 'FN 123456a')");
  const addUser = sqlite.prepare(
    "INSERT INTO users (organisation_id, email, first_name, last_name, role, password_hash, status) VALUES (1, ?, 'A', 'B', 'REQUEST_USER', ?, ?)",
  );
  addUser.run('ana@example.com', await hashPassword('old-password-123'), 'ACTIVE');
  addUser.run('new@example.com', null, 'PENDING');
  addUser.run('gone@example.com', await hashPassword('old-password-123'), 'DEACTIVATED');
  db = d1(sqlite);
  mails = [];
  now = new Date('2026-10-28T12:00:00Z');
});

test('an active user gets a reset link, matched case-insensitively', async () => {
  await requestPasswordReset(deps(), ' Ana@Example.com ', 'en');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'ana@example.com');
  assert.match(mails[0].text, /https:\/\/bpc\.test\/reset-password\.html#token=/);
});

test('the e-mail is German for German browsers', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'de');
  assert.match(mails[0].subject, /Passwort/);
});

test('unknown, pending and deactivated users get no e-mail', async () => {
  for (const email of ['nobody@example.com', 'new@example.com', 'gone@example.com']) {
    await requestPasswordReset(deps(), email, 'en');
  }
  assert.equal(mails.length, 0);
});

test('only a hash of the token is stored', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  const { token_hash } = sqlite.prepare('SELECT token_hash FROM password_resets').get();
  assert.match(token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(token_hash, tokenIn(mails[0]));
});

test('at most 3 links per hour are sent', async () => {
  for (let i = 0; i < 5; i++) await requestPasswordReset(deps(), 'ana@example.com', 'en');
  assert.equal(mails.length, 3);
});

test('the link sets a new password, the old one stops working, and it is audited in UTC', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  assert.deepEqual(await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password'), { ok: true });
  assert.ok(await verifyPassword('brand-new-password', passwordHash('ana@example.com')));
  assert.equal(await verifyPassword('old-password-123', passwordHash('ana@example.com')), false);
  assert.deepEqual(auditActions().map((row) => row.action), ['PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_COMPLETED']);
  assert.match(auditActions()[1].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('the link works only once', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password');
  assert.deepEqual(await confirmPasswordReset(deps(), tokenIn(mails[0]), 'another-password-1'), { ok: false, error: 'INVALID_LINK' });
  assert.ok(await verifyPassword('brand-new-password', passwordHash('ana@example.com')));
});

test('the link expires after 30 minutes', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  now = new Date(now.getTime() + 31 * 60_000);
  assert.deepEqual(await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password'), { ok: false, error: 'INVALID_LINK' });
  assert.ok(await verifyPassword('old-password-123', passwordHash('ana@example.com')));
  assert.equal(auditActions().filter((row) => row.action === 'PASSWORD_RESET_COMPLETED').length, 0);
});

test('a newer link replaces an older one', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  assert.equal((await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password')).ok, false);
  assert.equal((await confirmPasswordReset(deps(), tokenIn(mails[1]), 'brand-new-password')).ok, true);
});

test('a link stops working when the user is deactivated', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  sqlite.exec("UPDATE users SET status = 'DEACTIVATED' WHERE email = 'ana@example.com'");
  assert.equal((await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password')).ok, false);
});

test('a too short password is refused without using up the link', async () => {
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  assert.deepEqual(await confirmPasswordReset(deps(), tokenIn(mails[0]), 'short'), { ok: false, error: 'PASSWORD_TOO_SHORT' });
  assert.equal((await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password')).ok, true);
});

test('API: the request answers 202 the same way for known and unknown addresses', async () => {
  const waiting = [];
  const env = { DB: db };
  const ctx = { waitUntil: (promise) => waiting.push(promise) };
  const post = (email) =>
    worker.fetch(
      new Request('https://bpc.test/api/password-reset', { method: 'POST', body: JSON.stringify({ email }) }),
      env,
      ctx,
    );
  const known = await post('ana@example.com');
  const unknown = await post('nobody@example.com');
  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  await Promise.all(waiting);
});

test('API: confirm answers 204 on success and 400 with an error code otherwise', async () => {
  now = new Date(); // the API uses the real clock
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  const confirm = (body) =>
    worker.fetch(
      new Request('https://bpc.test/api/password-reset/confirm', { method: 'POST', body: JSON.stringify(body) }),
      { DB: db },
    );
  const bad = await confirm({ token: 'made-up', password: 'brand-new-password' });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'INVALID_LINK' });
  assert.equal((await confirm({ token: tokenIn(mails[0]), password: 'brand-new-password' })).status, 204);
});

test('a reset logs the user out everywhere', async () => {
  const session = await login({ db, now }, 'ana@example.com', 'old-password-123');
  assert.ok(session.ok);
  await requestPasswordReset(deps(), 'ana@example.com', 'en');
  await confirmPasswordReset(deps(), tokenIn(mails[0]), 'brand-new-password');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
