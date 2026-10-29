// Pure helpers for the setup script, kept separate so they can be tested
// without wrangler. SCRUM-93.

const EMAIL = /^[^\s@']+@[^\s@']+\.[^\s@']+$/;

export function validateEmail(email) {
  if (!email || !EMAIL.test(email)) {
    throw new Error(`SUPER_ADMIN_EMAIL is missing or not a valid e-mail address: ${email ?? '(unset)'}`);
  }
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const SELECT_SUPER_ADMIN_SQL = "SELECT email FROM users WHERE role = 'SUPER_ADMIN'";

// Inserts the Super Admin only if none exists yet, so running setup twice is safe.
// The unique index users_one_super_admin enforces the same rule in the database.
// There is no password: the Super Admin signs up at the identity provider (Clerk)
// with this e-mail address, and the first sign-in links the two (SCRUM-104).
export function insertSuperAdminSql({ email }) {
  return `INSERT INTO users (organisation_id, email, first_name, last_name, role, status)
SELECT NULL, ${quote(email)}, 'Super', 'Admin', 'SUPER_ADMIN', 'ACTIVE'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'SUPER_ADMIN');`;
}
