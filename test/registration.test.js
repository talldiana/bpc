// SCRUM-12 (FR-ORG-01): an organisation registers for free with name,
// organisation number and its first Organisation Admin, who stays inactive
// until the e-mail address is confirmed (FR-ORG-02).

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { linkExternalUser, normaliseOrganisationNumber, registerOrganisation, validateRegistration } from '../src/registration.js';
import { d1, migratedDatabase } from './d1.js';

const form = {
  organisationName: 'Bau GmbH',
  organisationNumber: 'FN 123456a',
  firstName: 'Ana',
  lastName: 'Berger',
  email: 'ana@bau.example',
};

let sqlite;
let db;
const now = new Date('2026-10-29T10:00:00Z');

beforeEach(() => {
  sqlite = migratedDatabase();
  db = d1(sqlite);
});

const register = (body, language = 'en-GB') =>
  worker.fetch(
    new Request('https://bpc.test/api/organisations', {
      method: 'POST',
      headers: { 'Accept-Language': language },
      body: JSON.stringify(body),
    }),
    { DB: db },
  );

test('registering creates the organisation and its first admin as PENDING', async () => {
  const response = await register(form);
  assert.equal(response.status, 201);
  const { organisationId } = await response.json();

  const organisation = sqlite.prepare('SELECT * FROM organisations WHERE id = ?').get(organisationId);
  assert.equal(organisation.name, 'Bau GmbH');
  assert.equal(organisation.fn, 'FN 123456a');
  assert.equal(organisation.default_language, 'en');

  const user = sqlite.prepare('SELECT * FROM users WHERE organisation_id = ?').get(organisationId);
  assert.equal(user.email, 'ana@bau.example');
  assert.equal(user.first_name, 'Ana');
  assert.equal(user.last_name, 'Berger');
  assert.equal(user.role, 'ADMIN');
  assert.equal(user.status, 'PENDING');
  assert.equal(user.external_user_id, null);
});

test('a German browser makes German the organisation default language', async () => {
  await register(form, 'de-AT,de;q=0.9');
  assert.equal(sqlite.prepare('SELECT default_language FROM organisations').get().default_language, 'de');
});

test('the registration is audited with a UTC timestamp', async () => {
  await registerOrganisation({ db, now }, form);
  const entry = sqlite.prepare('SELECT * FROM audit_log').get();
  assert.equal(entry.action, 'ORGANISATION_REGISTERED');
  assert.equal(entry.created_at, '2026-10-29T10:00:00.000Z');
  assert.deepEqual(JSON.parse(entry.details), { organisation_id: 1 });
});

test('every field is mandatory', async () => {
  const response = await register({});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'INVALID_INPUT',
    fields: {
      organisationName: 'REQUIRED',
      organisationNumber: 'REQUIRED',
      firstName: 'REQUIRED',
      lastName: 'REQUIRED',
      email: 'REQUIRED',
    },
  });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM organisations').get().n, 0);
});

test('fields with only spaces count as empty', () => {
  const result = validateRegistration({ ...form, firstName: '   ' });
  assert.deepEqual(result, { ok: false, fields: { firstName: 'REQUIRED' } });
});

test('an invalid e-mail address is rejected with a message', async () => {
  for (const email of ['ana', 'ana@bau', 'ana @bau.example', 'ana@@bau.example']) {
    const response = await register({ ...form, email });
    assert.equal(response.status, 400, email);
    assert.deepEqual((await response.json()).fields, { email: 'INVALID' }, email);
  }
});

test('the organisation number accepts the usual spellings and is stored in one form', () => {
  for (const spelling of ['FN 123456a', 'fn123456A', '123456 a', ' FN 0123456a ']) {
    assert.equal(normaliseOrganisationNumber(spelling), 'FN 123456a', spelling);
  }
  for (const wrong of ['123456', 'FN 1234567a', 'ATU12345678', 'FN 12a34b', '']) {
    assert.equal(normaliseOrganisationNumber(wrong), null, wrong);
  }
});

test('an invalid organisation number is rejected', async () => {
  const response = await register({ ...form, organisationNumber: 'ATU12345678' });
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).fields, { organisationNumber: 'INVALID' });
});

test('very long names are rejected', () => {
  const result = validateRegistration({ ...form, organisationName: 'x'.repeat(201) });
  assert.deepEqual(result.fields, { organisationName: 'TOO_LONG' });
});

test('the same organisation number cannot be registered twice, in any spelling', async () => {
  await register(form);
  const again = await register({ ...form, organisationNumber: '123456A', email: 'other@bau.example' });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'ORGANISATION_EXISTS' });
});

test('an e-mail address that already has an account cannot be used again', async () => {
  await register(form);
  const again = await register({ ...form, organisationNumber: 'FN 654321b', email: 'ANA@bau.example' });
  assert.equal(again.status, 409);
  assert.deepEqual(await again.json(), { error: 'EMAIL_IN_USE' });
  // Nothing half-created: the second organisation does not exist either.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM organisations').get().n, 1);
});

test('no payment data is asked for or stored', () => {
  const columns = sqlite.prepare("SELECT name FROM pragma_table_info('organisations')").all().map((row) => row.name);
  assert.deepEqual(columns, ['id', 'name', 'fn', 'default_language', 'created_at']);
});

test('the identity provider link activates the admin once, with the provider id', async () => {
  await registerOrganisation({ db, now }, form);
  const user = await linkExternalUser({ db, now }, { email: 'Ana@Bau.example', externalUserId: 'user_2abc' });
  assert.deepEqual({ ...user }, { id: 1, organisation_id: 1, role: 'ADMIN' });

  const row = sqlite.prepare('SELECT status, external_user_id FROM users WHERE id = 1').get();
  assert.deepEqual({ ...row }, { status: 'ACTIVE', external_user_id: 'user_2abc' });
  assert.deepEqual(
    sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all().map((entry) => entry.action),
    ['ORGANISATION_REGISTERED', 'ACCOUNT_ACTIVATED'],
  );

  // A second call, or another provider account with the same address, changes nothing.
  assert.equal(await linkExternalUser({ db, now }, { email: 'ana@bau.example', externalUserId: 'user_other' }), null);
  assert.equal(sqlite.prepare('SELECT external_user_id FROM users WHERE id = 1').get().external_user_id, 'user_2abc');
});

test('the identity provider link ignores unknown addresses', async () => {
  assert.equal(await linkExternalUser({ db, now }, { email: 'nobody@bau.example', externalUserId: 'user_x' }), null);
});
