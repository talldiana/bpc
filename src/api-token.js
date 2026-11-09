// SCRUM-58 / FR-API-03: every API call by a program is authenticated by an API
// token that belongs to exactly one user. The program sends it as
//   Authorization: Bearer bpc_...
// The api_tokens table (migration 0001) stores only the SHA-256 hash of the
// token (QS-SEC-03), so we hash what was sent and look the hash up.

const USER_COLUMNS = 'u.id, u.organisation_id, u.email, u.first_name, u.last_name, u.role';

/** The token from the Authorization header, or null if there is none. */
export function bearerToken(request) {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

/** SHA-256 of the token as lowercase hex. Works in Workers and in Node. */
export async function hashToken(token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The user behind the API token of this request.
 * Returns { user, apiTokenId } or { error } with:
 *   MISSING_TOKEN - no Authorization header
 *   INVALID_TOKEN - unknown, revoked or expired token, or its user is not active
 * The same INVALID_TOKEN is used for every bad token, so a caller cannot tell
 * which tokens exist.
 */
export async function tokenUser({ db, now = new Date() }, request) {
  const token = bearerToken(request);
  if (token === null) return { error: 'MISSING_TOKEN' };
  if (!token) return { error: 'INVALID_TOKEN' };

  const at = now.toISOString();
  const row = await db
    .prepare(
      `SELECT t.id AS token_id, ${USER_COLUMNS}
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.secret_hash = ?
         AND t.status = 'ACTIVE'
         AND (t.expires_at IS NULL OR t.expires_at > ?)
         AND u.status = 'ACTIVE'`,
    )
    .bind(await hashToken(token), at)
    .first();
  if (!row) return { error: 'INVALID_TOKEN' };

  await db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(at, row.token_id).run();

  return {
    apiTokenId: row.token_id,
    user: {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      organisationId: row.organisation_id,
    },
  };
}
