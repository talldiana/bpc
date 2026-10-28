// SCRUM-15: without a mail provider, reset links may only be printed in local
// development, never in the production logs.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMailer } from '../src/mail.js';

const mail = { to: 'ana@example.com', subject: 'Reset', text: 'https://bpc.test/reset-password.html#token=secret' };

// Runs fn and returns everything it wrote with console.log and console.error.
async function captureLogs(fn) {
  const lines = [];
  const { log, error } = console;
  console.log = console.error = (...args) => void lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines.join('\n');
}

test('in development the mail is printed with the link but without the address', async () => {
  const output = await captureLogs(() => createMailer({ ENVIRONMENT: 'development' }).send(mail));
  assert.match(output, /token=secret/);
  assert.doesNotMatch(output, /ana@example\.com/);
});

test('in production without a provider sending fails and nothing is logged', async () => {
  let failure;
  const output = await captureLogs(() => createMailer({}).send(mail).catch((error) => (failure = error)));
  assert.match(failure.message, /No mail provider configured/);
  assert.doesNotMatch(failure.message, /token=secret/);
  assert.equal(output, '');
});

test('with a provider the mail is sent through Resend', async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 200 });
  };
  try {
    await createMailer({ RESEND_API_KEY: 'key', MAIL_FROM: 'bpc@example.com' }).send(mail);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(requests[0].body, { from: 'bpc@example.com', ...mail });
});
