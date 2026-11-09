// SCRUM-16: start a partner check by VAT number (optional FN).

import { splitVat } from './adapters/vies.js';

// Stricter formats for some countries, on top of splitVat.
const VAT_FORMATS = {
  AT: /^ATU\d{8}$/, // ATU + 8 digits
  DE: /^DE\d{9}$/, // DE + 9 digits
};

// Returns { ok: true, vat: 'ATU12345678' } (cleaned up) or { ok: false, error: 'INVALID_VAT' }.
// Any EU VAT number is accepted (splitVat in the VIES adapter knows every EU prefix).
export function validateVat(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_VAT' };
  }

  // null if it is not an EU prefix followed by a plausible number
  const parts = splitVat(input);
  if (!parts) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  const vat = `${parts.countryCode}${parts.vatNumber}`;
  const format = VAT_FORMATS[parts.countryCode];
  if (format && !format.test(vat)) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  return { ok: true, vat };
}

// The FN is optional. Returns { ok: true, fn: '123456a' }, { ok: true, fn: null } when nothing was entered, or { ok: false, error: 'INVALID_FN' }.
export function validateFn(input) {
  // nothing entered -> fine, no FN
  if (input === undefined || input === null || input === '') {
    return { ok: true, fn: null };
  }

  // not text -> error
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_FN' };
  }

  // remove spaces, make lowercase (the check letter is lowercase)
  const cleaned = input.replace(/\s/g, '').toLowerCase();

  // 1 to 6 digits, then one letter
  if (!/^\d{1,6}[a-z]$/.test(cleaned)) {
    return { ok: false, error: 'INVALID_FN' };
  }

  return { ok: true, fn: cleaned };
}

// Only these roles may start a check (SRS section 2.4 permission table).
// Review Users may not; the Super Admin is outside every organisation.
const ROLES_THAT_MAY_START = ['REQUEST_USER', 'ADMIN'];

const auditSql = 'INSERT INTO audit_log (created_at, user_id, api_token_id, action, details) VALUES (?, ?, ?, ?, ?)';

/**
 * Starts a check request for the given user.
 * user: the signed-in user from currentUser() in auth.js ({ id, organisationId, role, ... }).
 * input: { vat, fn } exactly as typed.
 * apiTokenId: the API token the request came with (SCRUM-58), or null when it
 * was started in the web app. It is stored with the request and in the audit log.
 *
 * Returns { ok: true, requestId } or { ok: false, error } with error
 * FORBIDDEN, INVALID_VAT or INVALID_FN. No source is queried here.
 */
export async function startCheck({ db, now = new Date(), apiTokenId = null }, user, input) {
  const at = now.toISOString();

  // 1. Who is asking? Review Users (and the Super Admin) get FORBIDDEN.
  if (!ROLES_THAT_MAY_START.includes(user.role)) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  // 2. Validate the input before anything else happens.
  const vat = validateVat(input?.vat);
  const fn = validateFn(input?.fn);
  const error = !vat.ok ? vat.error : !fn.ok ? fn.error : null;

  if (error) {
    // FR-REQ-10: a rejected input queries no source but is logged.
    // Only the error code is stored, not what was typed.
    await db
      .prepare(auditSql)
      .bind(at, user.id, apiTokenId, 'REQUEST_REJECTED', JSON.stringify({ error }))
      .run();
    return { ok: false, error };
  }

  // 3. Store the request. RETURNING id gives back the new row's ID.
  const row = await db
    .prepare(
      `INSERT INTO requests (organisation_id, user_id, api_token_id, input_vat, input_fn, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'RUNNING', ?)
       RETURNING id`,
    )
    .bind(user.organisationId, user.id, apiTokenId, vat.vat, fn.fn, at)
    .first();

  // 4. Log that a request was started (FR-LOG-03).
  await db
    .prepare(auditSql)
    .bind(at, user.id, apiTokenId, 'REQUEST_STARTED', JSON.stringify({ requestId: row.id }))
    .run();

  return { ok: true, requestId: row.id };
}