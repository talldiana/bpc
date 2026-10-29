// SCRUM-66 / SI-01, FR-CHK-03: VAT numbers of every EU member state, name and
// address for a valid number, UNAVAILABLE when VIES cannot answer.
//
// The answers copy the real VIES format with invented names and numbers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VIES_URL, createViesAdapter, splitVat } from '../src/adapters/vies.js';

// A fetch that answers with `body` and records every request it gets.
function fakeVies(body, status = 200) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetch, calls };
}

test('splitVat accepts every EU prefix, maps GR to EL and ignores spaces, dots and dashes', () => {
  assert.deepEqual(splitVat('ATU12345678'), { countryCode: 'AT', vatNumber: 'U12345678' });
  assert.deepEqual(splitVat('de 123.456-789'), { countryCode: 'DE', vatNumber: '123456789' });
  assert.deepEqual(splitVat('GR123456789'), { countryCode: 'EL', vatNumber: '123456789' });
  assert.deepEqual(splitVat('XI123456789'), { countryCode: 'XI', vatNumber: '123456789' });
  assert.equal(splitVat('CHE123456789'), null);
  assert.equal(splitVat('US123456789'), null);
  assert.equal(splitVat(''), null);
  assert.equal(splitVat(null), null);
});

test('a valid number is VALID with the registered name and address', async () => {
  const vies = fakeVies({
    countryCode: 'AT',
    vatNumber: 'U12345678',
    requestDate: '2026-10-28T19:34:11.430Z',
    valid: true,
    requestIdentifier: '',
    name: 'Beispiel Bau GmbH',
    address: 'Hauptstraße 1\n3500 Krems',
  });
  const result = await createViesAdapter({}, vies).check({ vat: 'ATU12345678', fn: null });

  assert.deepEqual(result, {
    state: 'VALID',
    details: {
      vat: 'ATU12345678',
      requestDate: '2026-10-28T19:34:11.430Z',
      name: 'Beispiel Bau GmbH',
      address: 'Hauptstraße 1\n3500 Krems',
    },
  });
  assert.equal(vies.calls.length, 1);
  assert.equal(vies.calls[0].url, DEFAULT_VIES_URL);
  assert.equal(vies.calls[0].init.method, 'POST');
  assert.deepEqual(vies.calls[0].body, { countryCode: 'AT', vatNumber: 'U12345678' });
});

test('numbers from other member states are sent with their own country code', async () => {
  for (const [vat, countryCode] of [['DE123456789', 'DE'], ['FR12345678901', 'FR'], ['EL123456789', 'EL']]) {
    const vies = fakeVies({ countryCode, vatNumber: vat.slice(2), valid: true, name: 'X', address: 'Y' });
    const result = await createViesAdapter({}, vies).check({ vat });
    assert.equal(result.state, 'VALID');
    assert.equal(vies.calls[0].body.countryCode, countryCode);
  }
});

test('an invalid number is INVALID, and "---" placeholders are not shown as data', async () => {
  const vies = fakeVies({
    countryCode: 'AT',
    vatNumber: 'U99999999',
    requestDate: '2026-10-28T19:34:11.645Z',
    valid: false,
    name: '---',
    address: '---',
  });
  const result = await createViesAdapter({}, vies).check({ vat: 'ATU99999999' });
  assert.deepEqual(result, { state: 'INVALID', details: { vat: 'ATU99999999', requestDate: '2026-10-28T19:34:11.645Z' } });
});

test('a valid number without a published name keeps name and address empty', async () => {
  const vies = fakeVies({ countryCode: 'DE', vatNumber: '123456789', valid: true, name: '---', address: '---' });
  const result = await createViesAdapter({}, vies).check({ vat: 'DE123456789' });
  assert.equal(result.state, 'VALID');
  assert.equal(result.details.name, null);
  assert.equal(result.details.address, null);
});

test('a non-EU number is INVALID without calling VIES', async () => {
  const vies = fakeVies({});
  const result = await createViesAdapter({}, vies).check({ vat: 'CHE123456789' });
  assert.deepEqual(result, { state: 'INVALID', details: { reason: 'Not an EU VAT number', vat: 'CHE123456789' } });
  assert.equal(vies.calls.length, 0);
});

test('VIES rejecting the format is INVALID; any other VIES error is UNAVAILABLE', async () => {
  const rejected = fakeVies({ actionSucceed: false, errorWrappers: [{ error: 'INVALID_INPUT' }] });
  assert.deepEqual(await createViesAdapter({}, rejected).check({ vat: 'ATU1' }), {
    state: 'INVALID',
    details: { reason: 'VIES rejected the VAT number format', error: 'INVALID_INPUT' },
  });

  for (const error of ['MS_UNAVAILABLE', 'TIMEOUT', 'MS_MAX_CONCURRENT_REQ', 'SERVICE_UNAVAILABLE']) {
    const busy = fakeVies({ actionSucceed: false, errorWrappers: [{ error }] });
    const result = await createViesAdapter({}, busy).check({ vat: 'ATU12345678' });
    assert.equal(result.state, 'UNAVAILABLE');
    assert.equal(result.details.error, error);
  }
});

test('an HTTP error or an answer without "valid" is thrown, so runChecks reports UNAVAILABLE', async () => {
  await assert.rejects(createViesAdapter({}, fakeVies('<html>down</html>', 503)).check({ vat: 'ATU12345678' }), /HTTP 503/);
  await assert.rejects(createViesAdapter({}, fakeVies({ countryCode: 'AT' })).check({ vat: 'ATU12345678' }), /no "valid" field/);
});

test('VIES_URL points the adapter at another endpoint, e.g. the VIES test service', async () => {
  const url = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-test-service';
  const vies = fakeVies({ countryCode: 'AT', vatNumber: '100', valid: true, name: 'John Doe', address: 'x' });
  await createViesAdapter({ VIES_URL: url }, vies).check({ vat: 'AT100' });
  assert.equal(vies.calls[0].url, url);
});
