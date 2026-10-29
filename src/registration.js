// SCRUM-12 (FR-ORG-01): an organisation registers for free with its name, its
// organisation number and the first name, last name and e-mail address of its
// first Organisation Admin. No payment data is asked for.
//
// Registration creates the organisation and that user as ADMIN with status
// PENDING. Signing in is done by the external identity provider (Clerk): once
// the person has verified the e-mail address there (FR-ORG-02),
// linkExternalUser() stores the provider's user id and activates the account.

const EMAIL = /^[^\s@']+@[^\s@']+\.[^\s@']+$/; // same rule as setup-lib.js
const MAX_NAME_LENGTH = 200;

// Austrian Firmenbuchnummer: up to six digits and a check letter, written with
// or without "FN" and spaces, e.g. "FN 123456a", "123456 a", "fn123456A".
const FN = /^(?:FN\s*)?0*(\d{1,6})\s*([a-z])$/i;

export function normaliseOrganisationNumber(text) {
  const match = FN.exec(String(text ?? '').trim());
  return match ? `FN ${match[1]}${match[2].toLowerCase()}` : null;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Checks the form. Returns { ok: true, value } with cleaned-up values, or
 * { ok: false, fields } with an error code per wrong field.
 */
export function validateRegistration(input = {}) {
  const value = {
    organisationName: text(input.organisationName),
    organisationNumber: normaliseOrganisationNumber(input.organisationNumber),
    firstName: text(input.firstName),
    lastName: text(input.lastName),
    email: text(input.email),
  };
  const fields = {};
  for (const name of ['organisationName', 'firstName', 'lastName']) {
    if (!value[name]) fields[name] = 'REQUIRED';
    else if (value[name].length > MAX_NAME_LENGTH) fields[name] = 'TOO_LONG';
  }
  if (!text(input.organisationNumber)) fields.organisationNumber = 'REQUIRED';
  else if (!value.organisationNumber) fields.organisationNumber = 'INVALID';
  if (!value.email) fields.email = 'REQUIRED';
  else if (!EMAIL.test(value.email)) fields.email = 'INVALID';

  return Object.keys(fields).length === 0 ? { ok: true, value } : { ok: false, fields };
}

/**
 * Registers the organisation and its first Organisation Admin.
 * Returns { ok: true, organisationId, userId } or { ok: false, error, fields? }
 * with error INVALID_INPUT, ORGANISATION_EXISTS or EMAIL_IN_USE.
 */
export async function registerOrganisation({ db, now = new Date() }, input, language = 'en') {
  const checked = validateRegistration(input);
  if (!checked.ok) return { ok: false, error: 'INVALID_INPUT', fields: checked.fields };
  const { organisationName, organisationNumber, firstName, lastName, email } = checked.value;

  // Friendly answers for the usual cases; the UNIQUE constraints below still
  // catch two registrations that arrive at the same moment.
  if (await db.prepare('SELECT 1 FROM organisations WHERE fn = ?').bind(organisationNumber).first()) {
    return { ok: false, error: 'ORGANISATION_EXISTS' };
  }
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    return { ok: false, error: 'EMAIL_IN_USE' };
  }

  const at = now.toISOString();
  let created;
  try {
    // One transaction: either the organisation and its admin both exist, or neither.
    [, created] = await db.batch([
      db
        .prepare('INSERT INTO organisations (name, fn, default_language, created_at) VALUES (?, ?, ?, ?)')
        .bind(organisationName, organisationNumber, language === 'de' ? 'de' : 'en', at),
      db
        .prepare(
          `INSERT INTO users (organisation_id, email, first_name, last_name, role, status, created_at)
           SELECT id, ?, ?, ?, 'ADMIN', 'PENDING', ? FROM organisations WHERE fn = ?
           RETURNING id, organisation_id`,
        )
        .bind(email, firstName, lastName, at, organisationNumber),
      db
        .prepare(
          `INSERT INTO audit_log (created_at, user_id, action, details)
           SELECT ?, u.id, 'ORGANISATION_REGISTERED', json_object('organisation_id', u.organisation_id)
           FROM users u WHERE u.email = ?`,
        )
        .bind(at, email),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed: organisations\.fn/.test(error.message)) return { ok: false, error: 'ORGANISATION_EXISTS' };
    if (/UNIQUE constraint failed: users\.email/.test(error.message)) return { ok: false, error: 'EMAIL_IN_USE' };
    throw error;
  }

  const [user] = created.results;
  return { ok: true, organisationId: user.organisation_id, userId: user.id };
}

/**
 * For the identity provider integration (FR-ORG-02): call this once the
 * provider has confirmed that someone owns this e-mail address. It links the
 * PENDING user with that address to the provider's user id and makes the
 * account ACTIVE. Returns { id, organisation_id, role } of the activated user,
 * or null if there is no PENDING user with that address.
 */
export async function linkExternalUser({ db, now = new Date() }, { email, externalUserId }) {
  if (typeof email !== 'string' || typeof externalUserId !== 'string' || !externalUserId) return null;
  const user = await db
    .prepare(
      `UPDATE users SET external_user_id = ?, status = 'ACTIVE'
       WHERE email = ? AND status = 'PENDING' AND external_user_id IS NULL
       RETURNING id, organisation_id, role`,
    )
    .bind(externalUserId, email.trim())
    .first();
  if (user) {
    await db
      .prepare("INSERT INTO audit_log (created_at, user_id, action, details) VALUES (?, ?, 'ACCOUNT_ACTIVATED', '{}')")
      .bind(now.toISOString(), user.id)
      .run();
  }
  return user;
}
