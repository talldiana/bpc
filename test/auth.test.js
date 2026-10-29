// SCRUM-104 / SCRUM-14: sign-in goes through Clerk. These tests replace Clerk with a fake
// identity provider: a request "has a session" when it carries the header
// X-Test-Clerk-User, and the fake knows which e-mail addresses are verified.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { registerOrganisation } from '../src/registration.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let env;
let verifiedEmails;

const fakeIdentity = {
  async authenticate(request) {
    if (request.headers.get('X-Test-Handshake')) return { handshake: new Headers({ Location: 'https://clerk.test/handshake' }) };
    const externalUserId = request.headers.get('X-Test-Clerk-User');
    return externalUserId ? { externalUserId } : null;
  },
  async verifiedEmail(externalUserId) {
    return verifiedEmails[externalUserId] ?? null;
  },
};

const assets = { fetch: async (request) => new Response(`page ${new URL(request.url).pathname}`) };

beforeEach(async () => {
  sqlite = migratedDatabase();
  const db = d1(sqlite);
  env = { DB: db, ASSETS: assets, IDENTITY: fakeIdentity, CLERK_PUBLISHABLE_KEY: 'pk_test_abc' };
  verifiedEmails = {};
  await registerOrganisation(
    { db },
    { organisationName: 'Bau GmbH', organisationNumber: 'FN 123456a', firstName: 'Ana', lastName: 'Berger', email: 'ana@bau.example' },
  );
});

const get = (path, clerkUser, extraHeaders = {}) =>
  worker.fetch(
    new Request(`https://bpc.test${path}`, { headers: { ...(clerkUser ? { 'X-Test-Clerk-User': clerkUser } : {}), ...extraHeaders } }),
    env,
  );

const userRow = () => sqlite.prepare("SELECT status, external_user_id FROM users WHERE email = 'ana@bau.example'").get();

test('/api/config gives the browser the publishable key', async () => {
  assert.deepEqual(await (await get('/api/config')).json(), { clerkPublishableKey: 'pk_test_abc' });
});

test('without a Clerk session, /api/me is 401 and /app/ redirects to the login page', async () => {
  const me = await get('/api/me');
  assert.equal(me.status, 401);
  assert.deepEqual(await me.json(), { error: 'NOT_SIGNED_IN' });

  const page = await get('/app/');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('Location'), 'https://bpc.test/login');
});

test('first sign-in with a verified address links the registered admin and activates it', async () => {
  verifiedEmails.user_ana = 'ana@bau.example';
  const me = await get('/api/me', 'user_ana');
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    user: { id: 1, email: 'ana@bau.example', firstName: 'Ana', lastName: 'Berger', role: 'ADMIN', organisationId: 1 },
  });
  assert.deepEqual({ ...userRow() }, { status: 'ACTIVE', external_user_id: 'user_ana' });
});

test('an address that Clerk has not verified yet does not activate the admin', async () => {
  const me = await get('/api/me', 'user_ana');
  assert.equal(me.status, 403);
  assert.deepEqual(await me.json(), { error: 'NOT_REGISTERED' });
  assert.deepEqual({ ...userRow() }, { status: 'PENDING', external_user_id: null });
});

test('a Clerk account whose address is not registered here gets no access', async () => {
  verifiedEmails.user_stranger = 'stranger@example.com';
  assert.equal((await get('/api/me', 'user_stranger')).status, 403);
  const page = await get('/app/', 'user_stranger');
  assert.equal(page.status, 403);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
});

test('signed in to Clerk but not registered: /app/ shows the start page with its message, no redirect to /login', async () => {
  // /login sends anyone with a Clerk session to /app/, so a redirect back would loop.
  for (const path of ['/app/', '/app/users']) {
    const page = await get(path, 'user_ana'); // address not verified yet
    assert.equal(page.status, 403, path);
    assert.equal(page.headers.get('Location'), null, path);
    assert.equal(await page.text(), 'page /app/', path);
  }
});

test('a signed-in user gets /app/ pages, and they are not cached', async () => {
  verifiedEmails.user_ana = 'ana@bau.example';
  const page = await get('/app/', 'user_ana');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'page /app/');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
});

test('a deactivated user is locked out even with a valid Clerk session', async () => {
  verifiedEmails.user_ana = 'ana@bau.example';
  await get('/api/me', 'user_ana');
  sqlite.exec("UPDATE users SET status = 'DEACTIVATED' WHERE email = 'ana@bau.example'");
  assert.equal((await get('/api/me', 'user_ana')).status, 403);
  assert.equal((await get('/app/', 'user_ana')).status, 403);
});

test('a second Clerk account with the same address cannot take over the user', async () => {
  verifiedEmails.user_ana = 'ana@bau.example';
  verifiedEmails.user_copy = 'ana@bau.example';
  await get('/api/me', 'user_ana');
  assert.equal((await get('/api/me', 'user_copy')).status, 403);
  assert.equal(userRow().external_user_id, 'user_ana');
});

test('the Super Admin from the setup script is linked on first sign-in too', async () => {
  sqlite.exec(
    "INSERT INTO users (email, first_name, last_name, role, status) VALUES ('ops@bpc.example', 'Super', 'Admin', 'SUPER_ADMIN', 'ACTIVE')",
  );
  verifiedEmails.user_ops = 'ops@bpc.example';
  const me = await get('/api/me', 'user_ops');
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, 'SUPER_ADMIN');
});

test("when Clerk needs to refresh its cookies, /app/ passes Clerk's redirect on", async () => {
  const page = await get('/app/', null, { 'X-Test-Handshake': '1' });
  assert.equal(page.status, 307);
  assert.equal(page.headers.get('Location'), 'https://clerk.test/handshake');
});

test('the activation is audited with a UTC timestamp', async () => {
  verifiedEmails.user_ana = 'ana@bau.example';
  await get('/api/me', 'user_ana');
  await get('/api/me', 'user_ana');
  const actions = sqlite.prepare('SELECT action, created_at FROM audit_log ORDER BY id').all();
  assert.deepEqual(actions.map((row) => row.action), ['ORGANISATION_REGISTERED', 'ACCOUNT_ACTIVATED']);
  assert.match(actions[1].created_at, /Z$/);
});

test('the database holds no passwords, hashed or plain (QS-SEC-02)', () => {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.ok(!tables.includes('password_resets'));
  for (const table of tables) {
    const columns = sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
    assert.deepEqual(columns.filter((name) => /password/i.test(name)), [], table);
  }
});
