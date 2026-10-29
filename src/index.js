// Cloudflare Worker entry point (DI-02, SCRUM-87). The web app is served as
// static assets from public/; requests to /api/* run this code first, so the
// web app and the API share one domain.

import { refreshBmfFeed } from './bmf-feed.js';
import { createMailer } from './mail.js';
import { confirmPasswordReset, languageOf, requestPasswordReset } from './password-reset.js';
import { clearedSessionCookie, currentUser, login, logout, sessionCookie } from './session.js';

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

// SCRUM-15
async function passwordReset(request, env, ctx) {
  const { email } = await readJson(request);
  if (typeof email !== 'string' || !email.includes('@')) return json({ error: 'INVALID_EMAIL' }, 400);

  const deps = { db: env.DB, mailer: createMailer(env), baseUrl: new URL(request.url).origin };
  // Work after answering, so known and unknown addresses take the same time.
  ctx.waitUntil(
    requestPasswordReset(deps, email, languageOf(request)).catch((error) =>
      console.error('Password reset request failed', error.message), // no e-mail address in logs
    ),
  );
  return json({ status: 'If an active account uses this address, a reset link has been sent.' }, 202);
}

async function passwordResetConfirm(request, env) {
  const { token, password } = await readJson(request);
  const result = await confirmPasswordReset({ db: env.DB }, token, password);
  return result.ok ? new Response(null, { status: 204 }) : json({ error: result.error }, 400);
}

// SCRUM-14
async function loginRoute(request, env) {
  const { email, password } = await readJson(request);
  const result = await login({ db: env.DB }, email, password);
  // Same answer for an unknown address and a wrong password.
  if (!result.ok) return json({ error: 'INVALID_CREDENTIALS' }, 401);
  const response = json({ user: result.user });
  response.headers.set('Set-Cookie', sessionCookie(result.token));
  return response;
}

async function logoutRoute(request, env) {
  await logout({ db: env.DB }, request);
  return new Response(null, { status: 204, headers: { 'Set-Cookie': clearedSessionCookie() } });
}

async function me(request, env) {
  const user = await currentUser({ db: env.DB }, request);
  return user ? json({ user }) : json({ error: 'NOT_LOGGED_IN' }, 401);
}

// Pages under /app/ are only for signed-in users; everyone else is sent to the
// login page. no-store keeps the browser from showing them again after logout.
async function appPage(request, env) {
  const user = await currentUser({ db: env.DB }, request);
  if (!user) return Response.redirect(new URL('/login', request.url), 302);
  const page = await env.ASSETS.fetch(request);
  const response = new Response(page.body, page);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health') return health(env);
    if (request.method === 'POST' && pathname === '/api/password-reset') return passwordReset(request, env, ctx);
    if (request.method === 'POST' && pathname === '/api/password-reset/confirm') return passwordResetConfirm(request, env);
    if (request.method === 'POST' && pathname === '/api/login') return loginRoute(request, env);
    if (request.method === 'POST' && pathname === '/api/logout') return logoutRoute(request, env);
    if (request.method === 'GET' && pathname === '/api/me') return me(request, env);
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
