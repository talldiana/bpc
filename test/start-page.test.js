// SCRUM-30 (UI-01): the start page shows a Register and a Login button without sign-in.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import worker from '../src/index.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the start page has a Register button that opens the organisation registration', () => {
  assert.match(html, /<a href="\/register" id="register" role="button">/);
  assert.ok(readFileSync(new URL('../public/register.html', import.meta.url), 'utf8').includes('register-form'));
});

test('the start page has a Login button that opens the login form', () => {
  assert.match(html, /<a href="\/login" id="login" role="button">/);
  assert.ok(readFileSync(new URL('../public/login.html', import.meta.url), 'utf8').includes('mountSignIn'));
});

test('both buttons have an English and a German label', () => {
  assert.match(html, /register: 'Register your organisation'/);
  assert.match(html, /login: 'Log in'/);
  assert.match(html, /register: 'Organisation registrieren'/);
  assert.match(html, /login: 'Anmelden'/);
});

test('the start page needs no sign-in: the Worker hands / to the web app, even without a session', async () => {
  let served = null;
  const env = {
    ASSETS: { fetch: async (request) => ((served = new URL(request.url).pathname), new Response(html)) },
    IDENTITY: { authenticate: async () => null },
  };
  const response = await worker.fetch(new Request('https://bpc.hsynrsd.dev/'), env);
  assert.equal(response.status, 200);
  assert.equal(served, '/');
  assert.match(await response.text(), /id="login"/);
});

test('a signed-in user lands on /app/: the login page forwards there', () => {
  const login = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
  assert.match(login, /if \(clerk\.isSignedIn\) return location\.replace\('\/app\/'\)/);
  assert.match(login, /forceRedirectUrl: '\/app\/'/);
  assert.match(html, /<a href="\/app\/" id="open-app">/);
});
