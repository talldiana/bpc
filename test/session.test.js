// SCRUM-14: an active user logs in with e-mail and password and logs out again;
// a wrong login does not say which part was wrong; /app/ pages need a session.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { hashPassword } from '../src/password.js';
import { SESSION_HOURS, currentUser, login } from '../src/session.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let env;
const assets = { fetch: async (request) => new Response(`page ${new URL(request.url).pathname}`) };

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec("INSERT INTO organisations (id, name, fn) VALUES (1, 'Bau GmbH', 'FN 123456a')");
  const addUser = sqlite.prepare(
    "INSERT INTO users (organisation_id, email, first_name, last_name, role, password_hash, status) VALUES (1, ?, 'Ana', 'Berger', 'REQUEST_USER', ?, ?)",
  );
  addUser.run('ana@example.com', await hashPassword('right-password-123'), 'ACTIVE');
  addUser.run('new@example.com', null, 'PENDING');
  addUser.run('gone@example.com', await hashPassword('right-password-123'), 'DEACTIVATED');
  env = { DB: d1(sqlite), ASSETS: assets };
});

const call = (method, path, { body, cookie } = {}) =>
  worker.fetch(
    new Request(`https://bpc.test${path}`, {
      method,
      headers: cookie ? { Cookie: cookie } : {},
      body: body && JSON.stringify(body),
    }),
    env,
    { waitUntil: () => {} },
  );

// "bpc_session=abc; Path=/; ..." -> "bpc_session=abc"
const cookieFrom = (response) => response.headers.get('Set-Cookie').split(';')[0];
const auditActions = () => sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all().map((row) => row.action);

async function loggedInCookie() {
  return cookieFrom(await call('POST', '/api/login', { body: { email: 'ana@example.com', password: 'right-password-123' } }));
}

test('an active user logs in and gets a protected session cookie', async () => {
  const response = await call('POST', '/api/login', { body: { email: ' Ana@Example.com', password: 'right-password-123' } });
  assert.equal(response.status, 200);
  const { user } = await response.json();
  assert.deepEqual(user, {
    id: 1,
    email: 'ana@example.com',
    firstName: 'Ana',
    lastName: 'Berger',
    role: 'REQUEST_USER',
    organisationId: 1,
    mustChangePassword: false,
  });
  const cookie = response.headers.get('Set-Cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_HOURS * 3600}`]) {
    assert.ok(cookie.includes(flag), `cookie has ${flag}`);
  }
});

test('only a hash of the session token is stored', async () => {
  const token = (await loggedInCookie()).split('=')[1];
  const { token_hash } = sqlite.prepare('SELECT token_hash FROM sessions').get();
  assert.match(token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(token_hash, token);
});

test('a wrong password and an unknown address get exactly the same answer', async () => {
  const wrongPassword = await call('POST', '/api/login', { body: { email: 'ana@example.com', password: 'wrong-password-1' } });
  const unknownEmail = await call('POST', '/api/login', { body: { email: 'nobody@example.com', password: 'right-password-123' } });
  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(await wrongPassword.json(), await unknownEmail.json());
  assert.equal(wrongPassword.headers.get('Set-Cookie'), null);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('users that are not active cannot log in', async () => {
  for (const email of ['new@example.com', 'gone@example.com']) {
    const response = await call('POST', '/api/login', { body: { email, password: 'right-password-123' } });
    assert.equal(response.status, 401, email);
  }
});

test('a request without e-mail or password is refused', async () => {
  assert.equal((await call('POST', '/api/login', { body: {} })).status, 401);
  assert.equal((await call('POST', '/api/login')).status, 401);
});

test('/api/me returns the signed-in user, and 401 without a session', async () => {
  const cookie = await loggedInCookie();
  const me = await call('GET', '/api/me', { cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.email, 'ana@example.com');
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('GET', '/api/me', { cookie: 'bpc_session=made-up' })).status, 401);
});

test('/app/ pages are served only with a session and are not cached', async () => {
  const cookie = await loggedInCookie();
  const page = await call('GET', '/app/', { cookie });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'page /app/');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');

  const anonymous = await call('GET', '/app/');
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('Location'), 'https://bpc.test/login');
});

test('after logout the old cookie no longer opens any page', async () => {
  const cookie = await loggedInCookie();
  const response = await call('POST', '/api/logout', { cookie });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('Set-Cookie'), /^bpc_session=;.*Max-Age=0/);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
  assert.equal((await call('GET', '/app/', { cookie })).status, 302);
});

test('a session ends after 8 hours', async () => {
  const start = new Date('2026-10-29T08:00:00Z');
  const db = env.DB;
  const { token } = await login({ db, now: start }, 'ana@example.com', 'right-password-123');
  const request = new Request('https://bpc.test/api/me', { headers: { Cookie: `bpc_session=${token}` } });
  const later = (hours) => new Date(start.getTime() + hours * 3_600_000);
  assert.ok(await currentUser({ db, now: later(7.9) }, request));
  assert.equal(await currentUser({ db, now: later(8) }, request), null);
});

test('a session ends as soon as the user is deactivated', async () => {
  const cookie = await loggedInCookie();
  sqlite.exec("UPDATE users SET status = 'DEACTIVATED' WHERE email = 'ana@example.com'");
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
});

test('logins, failed logins and logouts are audited with a UTC timestamp, without the typed address', async () => {
  await call('POST', '/api/login', { body: { email: 'nobody@example.com', password: 'x' } });
  const cookie = await loggedInCookie();
  await call('POST', '/api/logout', { cookie });
  assert.deepEqual(auditActions(), ['LOGIN_FAILED', 'LOGIN', 'LOGOUT']);
  for (const row of sqlite.prepare('SELECT created_at, details FROM audit_log').all()) {
    assert.match(row.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.doesNotMatch(row.details, /nobody@example\.com/);
  }
});
