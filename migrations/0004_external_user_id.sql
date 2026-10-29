-- SCRUM-12: users are signed in by an external identity provider (Clerk).
-- external_user_id is that provider's user id; it is NULL until the person
-- first signs in there with the registered e-mail address.

ALTER TABLE users ADD COLUMN external_user_id TEXT;

CREATE UNIQUE INDEX users_external_user_id ON users (external_user_id) WHERE external_user_id IS NOT NULL;
