// SCRUM-58 / FR-API-03: API calls authenticated by a token that belongs to one user.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearerToken, hashToken, tokenUser } from '../src/api-token.js';
import worker from '../src/index.js';
import { d1, migratedDatabase } from './d1.js';

const TOKEN = 'bpc_request_user_token';
const REVIEW_TOKEN = 'bpc_review_user_token';
const now = new Date('2026-11-10T10:00:00.000Z');

// Two organisations, users with one token each. Nobody is signed in at Clerk.
async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a'), (2, 'Other GmbH', '222222b');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (10, 1, 'req@example.at',    'Rita', 'Request', 'REQUEST_USER', 'ACTIVE',      'clerk_request'),
      (12, 1, 'review@example.at', 'Rudi', 'Review',  'REVIEW_USER',  'ACTIVE',      NULL),
      (13, 1, 'gone@example.at',   'Gina', 'Gone',    'REQUEST_USER', 'DEACTIVATED', NULL),
      (20, 2, 'other@example.at',  'Otto', 'Other',   'REQUEST_USER', 'ACTIVE',      NULL);
  `);
  const add = sqlite.prepare('INSERT INTO api_tokens (id, user_id, name, secret_hash, status, expires_at) VALUES (?, ?, ?, ?, ?, ?)');
  add.run(1, 10, 'ERP', await hashToken(TOKEN), 'ACTIVE', null);
  add.run(2, 12, 'Review script', await hashToken(REVIEW_TOKEN), 'ACTIVE', null);
  add.run(3, 10, 'Old', await hashToken('bpc_revoked'), 'REVOKED', null);
  add.run(4, 10, 'Expired', await hashToken('bpc_expired'), 'ACTIVE', '2026-11-01T00:00:00.000Z');
  add.run(5, 13, 'Gone', await hashToken('bpc_deactivated_user'), 'ACTIVE', null);
  add.run(6, 20, 'Other ERP', await hashToken('bpc_other_org'), 'ACTIVE', null);
  const identity = { authenticate: async () => null, verifiedEmail: async () => null };
  return { sqlite, db: d1(sqlite), env: { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('') }, IDENTITY: identity } };
}

const withAuth = (header) =>
  new Request('https://bpc.hsynrsd.dev/api/me', { headers: header === undefined ? {} : { Authorization: header } });

const post = (env, headers, body) =>
  worker.fetch(
    new Request('https://bpc.hsynrsd.dev/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );

test('bearerToken reads the token, null without a header, empty for another scheme', () => {
  assert.equal(bearerToken(withAuth(`Bearer ${TOKEN}`)), TOKEN);
  assert.equal(bearerToken(withAuth(`bearer   ${TOKEN}`)), TOKEN);
  assert.equal(bearerToken(withAuth(undefined)), null);
  assert.equal(bearerToken(withAuth('Basic abc')), '');
  assert.equal(bearerToken(withAuth('Bearer')), '');
});

test('hashToken gives the SHA-256 hex, never the token itself', async () => {
  const hash = await hashToken('abc');
  assert.equal(hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a valid token gives its one user and the token id', async () => {
  const { db, sqlite } = await setup();
  const result = await tokenUser({ db, now }, withAuth(`Bearer ${TOKEN}`));
  assert.equal(result.apiTokenId, 1);
  assert.deepEqual(result.user, {
    id: 10, email: 'req@example.at', firstName: 'Rita', lastName: 'Request', role: 'REQUEST_USER', organisationId: 1,
  });
  assert.equal(sqlite.prepare('SELECT last_used_at FROM api_tokens WHERE id = 1').get().last_used_at, now.toISOString());
});

test('no token gives MISSING_TOKEN', async () => {
  const { db } = await setup();
  assert.deepEqual(await tokenUser({ db, now }, withAuth(undefined)), { error: 'MISSING_TOKEN' });
});

for (const [why, header] of [
  ['an unknown token', 'Bearer bpc_nope'],
  ['a revoked token', 'Bearer bpc_revoked'],
  ['an expired token', 'Bearer bpc_expired'],
  ['the token of a deactivated user', 'Bearer bpc_deactivated_user'],
  ['another scheme than Bearer', 'Basic abc'],
]) {
  test(`${why} gives INVALID_TOKEN`, async () => {
    const { db } = await setup();
    assert.deepEqual(await tokenUser({ db, now }, withAuth(header)), { error: 'INVALID_TOKEN' });
  });
}

test('every token belongs to exactly one user (user_id is required)', async () => {
  const { sqlite } = await setup();
  assert.throws(() =>
    sqlite.prepare("INSERT INTO api_tokens (user_id, name, secret_hash) VALUES (NULL, 'x', 'y')").run(),
  );
});

test('GET /api/me with a valid token answers with the token user', async () => {
  const { env } = await setup();
  const response = await worker.fetch(withAuth(`Bearer ${TOKEN}`), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, 10);
});

test('POST /api/requests without a token or session gives 401', async () => {
  const { sqlite, env } = await setup();
  const response = await post(env, {}, { vat: 'ATU12345678' });
  assert.equal(response.status, 401);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('POST /api/requests with an unknown token gives 401 INVALID_TOKEN', async () => {
  const { sqlite, env } = await setup();
  const response = await post(env, { Authorization: 'Bearer bpc_nope' }, { vat: 'ATU12345678' });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
  assert.deepEqual(await response.json(), { error: 'INVALID_TOKEN' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('a bad token is refused even when a Clerk session would be valid', async () => {
  const { env } = await setup();
  env.IDENTITY = { authenticate: async () => ({ externalUserId: 'clerk_request' }), verifiedEmail: async () => null };
  const response = await post(env, { Authorization: 'Bearer bpc_nope' }, { vat: 'ATU12345678' });
  assert.equal(response.status, 401);
});

test('a request started with a token is stored with the token user and the token (FR-DOC-01)', async () => {
  const { sqlite, env } = await setup();
  const response = await post(env, { Authorization: `Bearer ${TOKEN}` }, { vat: 'ATU12345678' });
  assert.equal(response.status, 202);
  const { requestId } = await response.json();
  const row = sqlite.prepare('SELECT organisation_id, user_id, api_token_id FROM requests WHERE id = ?').get(requestId);
  assert.deepEqual({ ...row }, { organisation_id: 1, user_id: 10, api_token_id: 1 });
  const log = sqlite.prepare("SELECT user_id, api_token_id FROM audit_log WHERE action = 'REQUEST_STARTED'").get();
  assert.deepEqual({ ...log }, { user_id: 10, api_token_id: 1 });
});

test('a token of another organisation stores the request in that organisation', async () => {
  const { sqlite, env } = await setup();
  const { requestId } = await (await post(env, { Authorization: 'Bearer bpc_other_org' }, { vat: 'ATU12345678' })).json();
  assert.equal(sqlite.prepare('SELECT organisation_id FROM requests WHERE id = ?').get(requestId).organisation_id, 2);
});

test('a token keeps the role rules: a Review User token gives 403', async () => {
  const { env } = await setup();
  const response = await post(env, { Authorization: `Bearer ${REVIEW_TOKEN}` }, { vat: 'ATU12345678' });
  assert.equal(response.status, 403);
});

test('a request started in the web app has no API token', async () => {
  const { sqlite, env } = await setup();
  env.IDENTITY = { authenticate: async () => ({ externalUserId: 'clerk_request' }), verifiedEmail: async () => null };
  const { requestId } = await (await post(env, {}, { vat: 'ATU12345678' })).json();
  assert.equal(sqlite.prepare('SELECT api_token_id FROM requests WHERE id = ?').get(requestId).api_token_id, null);
});
