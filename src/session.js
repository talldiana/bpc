// SCRUM-14: log in with e-mail and password, log out, and find the signed-in
// user of a request (SI-06).
//
// A successful login creates a session: a random token in an HttpOnly cookie,
// stored only as a SHA-256 hash. Sessions end at logout, after 8 hours, when
// the user is no longer ACTIVE, or when the password is reset (SCRUM-15).

import { hashPassword, verifyPassword } from './password.js';
import { randomToken, sha256Hex } from './tokens.js';

export const SESSION_HOURS = 8;
export const COOKIE_NAME = 'bpc_session';

const auditSql = 'INSERT INTO audit_log (created_at, user_id, action, details) VALUES (?, ?, ?, ?)';

// Checked when the e-mail address is unknown, so a wrong address takes as long
// as a wrong password and the answer time does not reveal which one was wrong.
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password'));

// What the web app may know about the signed-in user. Never the password hash.
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    organisationId: row.organisation_id,
    mustChangePassword: row.must_change_password === 1,
  };
}

const USER_COLUMNS = 'u.id, u.organisation_id, u.email, u.first_name, u.last_name, u.role, u.must_change_password';

/**
 * Checks e-mail and password. Returns { ok: true, token, user } or { ok: false }.
 * Unknown address, wrong password, and PENDING or DEACTIVATED users all give
 * the same { ok: false }, so the caller cannot tell them apart.
 */
export async function login({ db, now = new Date() }, email, password) {
  const at = now.toISOString();
  if (typeof email !== 'string' || typeof password !== 'string') return { ok: false };

  const row = await db
    .prepare(`SELECT ${USER_COLUMNS}, u.password_hash, u.status FROM users u WHERE u.email = ?`)
    .bind(email.trim())
    .first();
  const usable = row !== null && row.status === 'ACTIVE' && row.password_hash !== null;
  const passwordOk = await verifyPassword(password, usable ? row.password_hash : await getDummyHash());

  if (!usable || !passwordOk) {
    // The typed address is not logged: it may be someone else's or a typo (personal data).
    await db.prepare(auditSql).bind(at, row?.id ?? null, 'LOGIN_FAILED', '{}').run();
    return { ok: false };
  }

  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString();
  await db.batch([
    // Tidy up this user's expired sessions while we are here.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(row.id, at),
    db
      .prepare('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(row.id, await sha256Hex(token), at, expiresAt),
    db.prepare(auditSql).bind(at, row.id, 'LOGIN', '{}'),
  ]);
  return { ok: true, token, user: publicUser(row) };
}

export function sessionTokenOf(request) {
  const cookies = request.headers.get('Cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=') || null;
  }
  return null;
}

/** The signed-in user of this request, or null. */
export async function currentUser({ db, now = new Date() }, request) {
  const token = sessionTokenOf(request);
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'ACTIVE'`,
    )
    .bind(await sha256Hex(token), now.toISOString())
    .first();
  return row ? publicUser(row) : null;
}

/** Ends the session of this request, if there is one. */
export async function logout({ db, now = new Date() }, request) {
  const token = sessionTokenOf(request);
  if (!token) return;
  const at = now.toISOString();
  const tokenHash = await sha256Hex(token);
  await db.batch([
    db
      .prepare(`INSERT INTO audit_log (created_at, user_id, action, details) SELECT ?, user_id, 'LOGOUT', '{}' FROM sessions WHERE token_hash = ?`)
      .bind(at, tokenHash),
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash),
  ]);
}

// HttpOnly: page scripts cannot read the token. Secure: HTTPS only (browsers
// also allow it on http://localhost for `wrangler dev`). SameSite=Strict: other
// sites cannot send requests with it, which also blocks CSRF.
export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}

export function clearedSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
