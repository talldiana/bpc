-- SCRUM-104 (CR-09, QS-SEC-02): passwords, e-mail verification and password
-- reset are handled by the external identity provider (Clerk). The database
-- holds no passwords, hashed or plain.

DROP TABLE password_resets;

ALTER TABLE users DROP COLUMN password_hash;
ALTER TABLE users DROP COLUMN must_change_password;
