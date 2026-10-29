// SCRUM-15: reset a forgotten password by e-mail.
//
// 1. POST /api/password-reset { email } always answers 202 with the same body,
//    so nobody can find out which addresses have an account. For an ACTIVE user
//    it stores the hash of a random token and e-mails a link.
// 2. The link opens /reset-password.html#token=... The token is in the URL
//    fragment, so it never reaches server logs or Referer headers.
// 3. POST /api/password-reset/confirm { token, password } redeems the link once,
//    replaces the password hash (the old password stops working, FR-USR-03) and
//    writes an audit entry with a UTC timestamp (QS-OBS-01).

import { hashPassword } from './password.js';
import { randomToken, sha256Hex } from './tokens.js';

export const LINK_MINUTES = 30;
export const MAX_LINKS_PER_HOUR = 3;
const MIN_PASSWORD_LENGTH = 12; // same rule as the Super Admin password (setup-lib.js)
const MAX_PASSWORD_LENGTH = 128;

const minutesFrom = (date, minutes) => new Date(date.getTime() + minutes * 60_000).toISOString();

export function languageOf(request) {
  return (request.headers.get('Accept-Language') ?? '').toLowerCase().startsWith('de') ? 'de' : 'en';
}

function resetMail(link, language) {
  if (language === 'de') {
    return {
      subject: 'BizPartnerCheck: Passwort zurücksetzen',
      text:
        `Sie haben angefordert, Ihr Passwort zurückzusetzen.\n\n` +
        `Öffnen Sie diesen Link innerhalb von ${LINK_MINUTES} Minuten:\n${link}\n\n` +
        'Der Link funktioniert nur einmal. Wenn Sie das nicht angefordert haben, ignorieren Sie diese E-Mail.',
    };
  }
  return {
    subject: 'BizPartnerCheck: reset your password',
    text:
      `You asked to reset your password.\n\n` +
      `Open this link within ${LINK_MINUTES} minutes:\n${link}\n\n` +
      'The link works only once. If you did not ask for this, you can ignore this e-mail.',
  };
}

const auditSql = "INSERT INTO audit_log (created_at, user_id, action, details) VALUES (?, ?, ?, ?)";

/**
 * Sends a reset link if the address belongs to an ACTIVE user. Resolves the
 * same way in every case; callers must not tell the client what happened.
 */
export async function requestPasswordReset({ db, mailer, baseUrl, now = new Date() }, email, language) {
  const user = await db
    .prepare("SELECT id, email FROM users WHERE email = ? AND status = 'ACTIVE'")
    .bind(String(email).trim())
    .first();
  if (!user) return; // unknown, PENDING (FR-ORG-02 not done) or DEACTIVATED: send nothing

  const hourAgo = minutesFrom(now, -60);
  const { recent } = await db
    .prepare('SELECT COUNT(*) AS recent FROM password_resets WHERE user_id = ? AND created_at > ?')
    .bind(user.id, hourAgo)
    .first();
  if (recent >= MAX_LINKS_PER_HOUR) {
    await db
      .prepare(auditSql)
      .bind(now.toISOString(), user.id, 'PASSWORD_RESET_REQUESTED', JSON.stringify({ outcome: 'RATE_LIMITED' }))
      .run();
    return;
  }

  const token = randomToken();
  // Only the newest link works, so older unused ones are closed first.
  await db.batch([
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(now.toISOString(), user.id),
    db
      .prepare('INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(user.id, await sha256Hex(token), now.toISOString(), minutesFrom(now, LINK_MINUTES)),
    db.prepare(auditSql).bind(now.toISOString(), user.id, 'PASSWORD_RESET_REQUESTED', JSON.stringify({ outcome: 'SENT' })),
  ]);

  await mailer.send({ to: user.email, ...resetMail(`${baseUrl}/reset-password.html#token=${token}`, language) });
}

/**
 * Sets a new password with a reset token. Returns { ok: true } or
 * { ok: false, error } with error INVALID_LINK, PASSWORD_TOO_SHORT or PASSWORD_TOO_LONG.
 */
export async function confirmPasswordReset({ db, now = new Date() }, token, password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return { ok: false, error: 'PASSWORD_TOO_SHORT' };
  if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, error: 'PASSWORD_TOO_LONG' };
  if (typeof token !== 'string' || !token) return { ok: false, error: 'INVALID_LINK' };

  const at = now.toISOString();
  const tokenHash = await sha256Hex(token);
  const passwordHash = await hashPassword(password);

  // A link is valid while it is unused, not expired and its user is still ACTIVE.
  const validLink = `
    SELECT r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
    WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.status = 'ACTIVE'`;

  // A D1 batch is one transaction, so two clicks on the same link cannot both
  // succeed. The link is marked used last, after the statements that look it up.
  const [, , , redeemed] = await db.batch([
    db
      .prepare(`INSERT INTO audit_log (created_at, user_id, action, details) SELECT ?, user_id, 'PASSWORD_RESET_COMPLETED', '{}' FROM (${validLink})`)
      .bind(at, tokenHash, at),
    db
      .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = (${validLink})`)
      .bind(passwordHash, tokenHash, at),
    // Log the user out everywhere, so a session started with the old password ends too.
    db.prepare(`DELETE FROM sessions WHERE user_id = (${validLink})`).bind(tokenHash, at),
    db
      .prepare(
        `UPDATE password_resets SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
           AND user_id IN (SELECT id FROM users WHERE status = 'ACTIVE')
         RETURNING user_id`,
      )
      .bind(at, tokenHash, at),
  ]);

  return redeemed.results.length > 0 ? { ok: true } : { ok: false, error: 'INVALID_LINK' };
}
