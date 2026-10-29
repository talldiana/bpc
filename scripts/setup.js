#!/usr/bin/env node
// Setup script (DI-01 / FR-ORG-03, SCRUM-11): applies the database schema and
// creates the one Super Admin account. Safe to run more than once.
//
//   SUPER_ADMIN_EMAIL=ops@example.com npm run setup            # local D1
//   SUPER_ADMIN_EMAIL=ops@example.com npm run setup -- --remote # Cloudflare D1

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SELECT_SUPER_ADMIN_SQL, insertSuperAdminSql, validateEmail } from './setup-lib.js';

const DATABASE = process.env.D1_DATABASE ?? 'bpc';
const target = process.argv.includes('--remote') ? '--remote' : '--local';

// Runs the project's own wrangler with node directly. Calling 'npx' fails on
// Windows, where it is npx.cmd and cannot be started without a shell.
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function wrangler(...args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CI: 'true' }, // no interactive confirmation prompts
  });
}

function query(sql) {
  const output = JSON.parse(wrangler('d1', 'execute', DATABASE, target, '--json', '--command', sql));
  return output[0].results;
}

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  validateEmail(email);

  console.log(`Applying schema migrations to ${DATABASE} (${target.slice(2)})...`);
  wrangler('d1', 'migrations', 'apply', DATABASE, target);

  const existing = query(SELECT_SUPER_ADMIN_SQL);
  if (existing.length > 0) {
    console.log(`Super Admin already exists (${existing[0].email}). Nothing to create.`);
    return;
  }

  query(insertSuperAdminSql({ email }));
  console.log(`Created Super Admin ${email}.`);
  console.log('Next: create the account with this e-mail address on /signup. The first sign-in links it (SCRUM-104).');
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
