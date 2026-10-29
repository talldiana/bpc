// SCRUM-104 / SI-06 (CR-09): sign-in goes through Clerk, the external identity provider.
// Clerk owns passwords, e-mail verification and password reset; this Worker
// only checks the Clerk session of a request and maps it to our own user, who
// carries the organisation and the role (FR-USR-05, UI-05).
//
// Needs CLERK_PUBLISHABLE_KEY (wrangler.toml [vars]) and CLERK_SECRET_KEY
// (`wrangler secret put CLERK_SECRET_KEY`, or .dev.vars locally).

import { createClerkClient } from '@clerk/backend';
import { linkExternalUser } from './registration.js';

/** The Clerk side, behind a small interface so tests can replace it. */
export function clerkIdentity(env) {
  const clerk = createClerkClient({ secretKey: env.CLERK_SECRET_KEY, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  return {
    // { externalUserId } when the request has a valid Clerk session,
    // { handshake: headers } when Clerk first needs to refresh its cookies, or null.
    async authenticate(request) {
      const state = await clerk.authenticateRequest(request, { authorizedParties: [new URL(request.url).origin] });
      if (state.status === 'handshake') return { handshake: state.headers };
      if (state.isAuthenticated) return { externalUserId: state.toAuth().userId };
      // Why Clerk did not accept the session (e.g. token expired, wrong origin); no secrets.
      if (state.reason) console.log(`Clerk: not signed in (${state.reason}${state.message ? `: ${state.message}` : ''})`);
      return null;
    },
    // The user's primary e-mail address, only if Clerk has verified it.
    async verifiedEmail(externalUserId) {
      const { primaryEmailAddress } = await clerk.users.getUser(externalUserId);
      return primaryEmailAddress?.verification?.status === 'verified' ? primaryEmailAddress.emailAddress : null;
    },
  };
}

const USER_COLUMNS = 'id, organisation_id, email, first_name, last_name, role';

// What the web app may know about the signed-in user.
function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    organisationId: row.organisation_id,
  };
}

/**
 * The signed-in user of this request. Returns { user }, { handshake } or
 * { error } with NOT_SIGNED_IN (no Clerk session) or NOT_REGISTERED (signed in
 * at Clerk, but no active BizPartnerCheck user belongs to that account).
 */
export async function currentUser({ db, identity, now = new Date() }, request) {
  const session = await identity.authenticate(request);
  if (!session) return { error: 'NOT_SIGNED_IN' };
  if (session.handshake) return { handshake: session.handshake };

  const { externalUserId } = session;
  const findActive = () =>
    db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE external_user_id = ? AND status = 'ACTIVE'`).bind(externalUserId).first();

  let row = await findActive();
  if (!row) {
    // First sign-in after the e-mail address was verified at Clerk (FR-ORG-02):
    // link the registered user with that address to this Clerk account.
    const email = await identity.verifiedEmail(externalUserId);
    if (email && (await linkExternalUser({ db, now }, { email, externalUserId }))) row = await findActive();
  }
  return row ? { user: publicUser(row) } : { error: 'NOT_REGISTERED' };
}
