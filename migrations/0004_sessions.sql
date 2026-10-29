-- SCRUM-14: login sessions for the web app (SI-06).
-- The browser holds a random token in an HttpOnly cookie; only its SHA-256
-- hash is stored, like email_verifications and password_resets.

CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id),
  token_hash  TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at  TEXT    NOT NULL                           -- 8 h after login
);

CREATE INDEX sessions_user ON sessions (user_id);
