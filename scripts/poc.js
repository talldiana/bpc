#!/usr/bin/env node
// Sprint 1 proof of concept (DI-07, SCRUM-25): one check through all adapters,
// plus the live BMF fake company feed.
//
//   npm run poc -- ATU12345678          # real VIES
//   npm run poc -- AT100 --test         # VIES test service: 100 = valid, 200 = invalid

import { decodeFeed, DEFAULT_BMF_FEED_URL, parseBmfFeed } from '../src/bmf-feed.js';
import { createAdapters, runChecks } from '../src/adapters/index.js';

const VIES_TEST_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-test-service';

const args = process.argv.slice(2);
const testMode = args.includes('--test');
const vat = args.find((arg) => !arg.startsWith('--')) ?? (testMode ? 'AT100' : null);
if (!vat) {
  console.error('Usage: npm run poc -- <VAT number> [--test]');
  process.exit(1);
}

const env = testMode ? { VIES_URL: VIES_TEST_URL } : {};

console.log(`\nCheck for ${vat}${testMode ? ' (VIES test service)' : ''}\n`);
const results = await runChecks(createAdapters(env), { vat, fn: null });
for (const row of results) {
  const { reason, name, address } = row.details ?? {};
  const info = reason ?? [name, address?.replace(/\s*\n\s*/g, ', ')].filter(Boolean).join(' · ');
  console.log(`  ${row.source.padEnd(10)} ${row.state.padEnd(11)} ${info ?? ''}`);
}

console.log('\nBMF fake company list (live feed)\n');
try {
  const response = await fetch(process.env.BMF_FEED_URL || DEFAULT_BMF_FEED_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`BMF feed answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const feed = parseBmfFeed(decodeFeed(bytes, response.headers.get('content-type') ?? ''));
  const compact = vat.toUpperCase().replace(/[\s.\-]/g, '');
  const listed = feed.entries.some((entry) => entry.vat === compact);
  console.log(`  Published  ${feed.publishedAt ?? 'unknown'}`);
  console.log(`  Entries    ${feed.entries.length}`);
  console.log(`  ${compact} is ${listed ? 'ON' : 'not on'} the list`);
} catch (error) {
  console.log(`  Could not read the feed: ${error.message}`);
}
console.log('');
