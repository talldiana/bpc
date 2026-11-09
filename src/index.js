// Cloudflare Worker entry point (DI-02, SCRUM-87). The web app is served as
// static assets from public/; requests to /api/* run this code first, so the
// web app and the API share one domain.

import { bearerToken, tokenUser } from './api-token.js';
import { clerkIdentity, currentUser } from './auth.js';
import { refreshBmfFeed } from './bmf-feed.js';
import { startCheck } from './check-request.js';
import { languageOf } from './language.js';
import { registerOrganisation } from './registration.js';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function health(env) {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
  } catch {
    return json({ status: 'error', database: 'unreachable', time: new Date().toISOString() }, 503);
  }
}

// SCRUM-12
async function register(request, env) {
  const result = await registerOrganisation({ db: env.DB }, await readJson(request), languageOf(request));
  if (result.ok) return json({ organisationId: result.organisationId }, 201);
  if (result.error === 'INVALID_INPUT') return json({ error: result.error, fields: result.fields }, 400);
  return json({ error: result.error }, 409);
}

// SCRUM-104: the Clerk key the browser needs. It is public by design.
function config(env) {
  return json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? null });
}

// Tests pass env.IDENTITY instead of talking to Clerk.
const identityOf = (env) => env.IDENTITY ?? clerkIdentity(env);

// Who is calling the API? A program sends an API token (SCRUM-58, FR-API-03);
// the web app sends the Clerk session cookie instead. A request with an
// Authorization header is always judged by its token, never by a cookie.
// Returns { user, apiTokenId } or { status, error } for the error response.
async function apiCaller(request, env) {
  if (bearerToken(request) !== null) {
    const result = await tokenUser({ db: env.DB }, request);
    return result.user ? result : { status: 401, error: result.error };
  }
  const result = await currentUser({ db: env.DB, identity: identityOf(env) }, request);
  if (result.user) return { user: result.user, apiTokenId: null };
  // 401: not signed in. 403: signed in at Clerk, but not a BizPartnerCheck user.
  const error = result.error ?? 'NOT_SIGNED_IN';
  return { status: error === 'NOT_REGISTERED' ? 403 : 401, error };
}

function unauthorized({ status, error }) {
  const response = json({ error }, status);
  if (status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
  return response;
}

async function me(request, env) {
  const caller = await apiCaller(request, env);
  return caller.user ? json({ user: caller.user }) : unauthorized(caller);
}

// Pages under /app/ are only for signed-in users; everyone else is sent to the
// sign-in page. no-store keeps the browser from showing them again after logout.
async function appPage(request, env) {
  const result = await currentUser({ db: env.DB, identity: identityOf(env) }, request);
  if (result.handshake) return new Response(null, { status: 307, headers: result.handshake });
  if (result.error === 'NOT_SIGNED_IN') return Response.redirect(new URL('/login', request.url), 302);
  // Signed in to Clerk but not a user here: show the start page, which says so and
  // offers logout. Redirecting to /login would loop, because /login sends anyone
  // with a Clerk session back to /app/.
  const page = await env.ASSETS.fetch(result.user ? request : new Request(new URL('/app/', request.url), request));
  const response = new Response(page.body, { status: result.user ? page.status : 403, headers: page.headers });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

// SCRUM-16: POST /api/requests { vat, fn } -> 202 { requestId }
async function startCheckRoute(request, env) {
  // Same check as /api/me: API token or Clerk session.
  const caller = await apiCaller(request, env);
  if (!caller.user) return unauthorized(caller);

  const body = (await readJson(request)) ?? {};
  const { vat, fn } = body;
  const result = await startCheck({ db: env.DB, apiTokenId: caller.apiTokenId }, caller.user, { vat, fn });

  if (result.ok) return json({ requestId: result.requestId }, 202);
  return json({ error: result.error }, result.error === 'FORBIDDEN' ? 403 : 400);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health') return health(env);
    if (request.method === 'POST' && pathname === '/api/organisations') return register(request, env);
    if (request.method === 'GET' && pathname === '/api/config') return config(env);
    if (request.method === 'GET' && pathname === '/api/me') return me(request, env);
    if (request.method === 'POST' && pathname === '/api/requests') return startCheckRoute(request, env);
    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (pathname === '/app' || pathname.startsWith('/app/')) return appPage(request, env);
    return env.ASSETS.fetch(request);
  },

  // SCRUM-18 / FR-DOC-06: run once a day by the cron trigger in wrangler.toml.
  // It only refreshes the BMF copy and never starts a partner check (FR-CHK-09).
  async scheduled(controller, env) {
    const result = await refreshBmfFeed(env);
    const log = result.status === 'OK' ? console.log : console.error;
    log(`BMF feed fetch ${result.status}: ${JSON.stringify(result)}`);
  },
};
