// SCRUM-18 / FR-DOC-06: the BMF feed is fetched by a scheduled job, each fetch
// logs the fetch time and the feed's publication date in UTC, and a failed
// fetch is logged while the last good copy stays in use.
//
// The sample feed below copies the format of the real BMF feed with invented
// names and numbers.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { DEFAULT_BMF_FEED_URL, decodeFeed, parseBmfFeed, parseFeedDate, refreshBmfFeed } from '../src/bmf-feed.js';
import worker from '../src/index.js';


const migrationsDir = new URL('../migrations/', import.meta.url);

// An in-memory database with every migration applied, in order, like D1.
function databaseWithAllMigrations() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
  return db;
}

function d1(db) {
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind: (...values) => {
      assert.ok(values.length <= 100, `D1 allows at most 100 bound values, got ${values.length}`);
      return statement(sql, values);
    },
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...s.params);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return statements.map(() => ({ success: true }));
    },
  };
}

const COMPANY = `<item><title><![CDATA[Österreicher Musterbau GmbH]]></title><description><![CDATA[1100 Wien, Beispielgasse 17<br />Veröffentlichung: 27.10.2026<br />Scheinunternehmen ab: 19.11.2024<br />Rechtskraft Bescheid: 20.10.2026<br />Firmenbuch-Nr: 123456a<br /><em>UID-NR:</em> ATU12345678, <em>Kennziffer des UR:</em> ATU12345678]]></description><link>https://service.bmf.gv.at/service/allg/lsu/_start.asp?cp=Musterbau</link><guid>https://service.bmf.gv.at/service/allg/lsu/_start.asp?cp=Musterbau</guid><pubDate>27 Oct 2026</pubDate><category>Veröff.Jahr: 2026</category><category>UID: Inland</category></item>`;

const COMPANY_WITHOUT_UID = `<item><title><![CDATA[Beispiel Holding GmbH]]></title><description><![CDATA[1170 Wien, Probegasse 3<br />Veröffentlichung: 27.10.2026<br />Firmenbuch-Nr: 654321 w<br /><em>Kennziffer des UR:</em> ]]></description><link>https://service.bmf.gv.at/service/allg/lsu/_start.asp?cp=Beispiel</link><guid>https://service.bmf.gv.at/service/allg/lsu/_start.asp?cp=Beispiel</guid><pubDate>27 Oct 2026</pubDate><category>Veröff.Jahr: 2026</category><category>UID: Nicht bekannt</category></item>`;

const PERSON = `<item><title><![CDATA[MUSTERMANN Max]]></title><description><![CDATA[8020 Graz, Testweg 9<br />Veröffentlichung: 03.09.2026,   Geb.Datum: 01.02.1990,   <br /><em>UID-NR:</em> ATU87654321, <em>Kennziffer des UR:</em> ATU87654321]]></description><link>https://service.bmf.gv.at/service/allg/lsu/_start.asp?cp=Mustermann</link><guid>https://service.bmf.gv.at/service/allg/lsu/_start.asp?cp=Mustermann</guid><pubDate>03 Sep 2026</pubDate><category>Veröff.Jahr: 2026</category><category>UID: Inland</category></item>`;

// Builds a feed the way BMF sends it: ISO-8859-1 bytes.
function feedBytes(items = [COMPANY, COMPANY_WITHOUT_UID, PERSON], { lastBuildDate = '27 Oct 2026', complete = true } = {}) {
  const xml = `<?xml version="1.0" encoding="iso-8859-1"?>
<rss version="2.0">
  <channel>
    <title>Liste der Scheinunternehmen</title>
    <link>https://service.bmf.gv.at/service/allg/lsu/</link>
    <copyright>Bundesministerium für Finanzen</copyright>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    ${items.join('\n    ')}
${complete ? '  </channel>\n</rss>\n' : ''}`;
  return Buffer.from(xml, 'latin1');
}

const answer = (body, status = 200) => async () => new Response(body, { status, headers: { 'Content-Type': 'text/xml' } });
const at = (iso) => () => new Date(iso);

function setup() {
  const sqlite = databaseWithAllMigrations();
  return { sqlite, env: { DB: d1(sqlite) } };
}

const fetches = (sqlite) => sqlite.prepare('SELECT * FROM bmf_feed_fetches ORDER BY id').all();
const entries = (sqlite) =>
  sqlite
    .prepare('SELECT name, vat, fn, published_on FROM bmf_feed_entries ORDER BY id')
    .all()
    .map((row) => ({ ...row }));


test('the ISO-8859-1 feed is decoded so umlauts stay intact', () => {
  const text = decodeFeed(feedBytes());
  assert.match(text, /Österreicher Musterbau GmbH/);
  assert.match(text, /Bundesministerium für Finanzen/);
});

test('UTF-8 feeds are decoded as UTF-8', () => {
  const bytes = new TextEncoder().encode('<?xml version="1.0" encoding="utf-8"?><rss><channel><title>Größe</title></channel></rss>');
  assert.match(decodeFeed(bytes), /Größe/);
});

test('feed dates become UTC dates', () => {
  assert.equal(parseFeedDate('27 Oct 2026'), '2026-10-27');
  assert.equal(parseFeedDate('3 Sep 2026'), '2026-09-03');
  assert.equal(parseFeedDate('Tue, 27 Oct 2026 08:30:00 GMT'), '2026-10-27T08:30:00.000Z');
  assert.equal(parseFeedDate('Tue, 27 Oct 2026 09:30:00 +0100'), '2026-10-27T08:30:00.000Z');
  assert.equal(parseFeedDate('not a date'), null);
  assert.equal(parseFeedDate(null), null);
});

test('each entry keeps only name, VAT number, FN and publication date', () => {
  const feed = parseBmfFeed(decodeFeed(feedBytes()));
  assert.equal(feed.publishedAt, '2026-10-27');
  assert.deepEqual(feed.entries, [
    { name: 'Österreicher Musterbau GmbH', vat: 'ATU12345678', fn: '123456a', publishedOn: '2026-10-27' },
    { name: 'Beispiel Holding GmbH', vat: null, fn: '654321w', publishedOn: '2026-10-27' },
    { name: 'MUSTERMANN Max', vat: 'ATU87654321', fn: null, publishedOn: '2026-09-03' },
  ]);
});

test('without lastBuildDate the newest entry date is used as the publication date', () => {
  const xml = decodeFeed(feedBytes(undefined, { lastBuildDate: '' }));
  assert.equal(parseBmfFeed(xml).publishedAt, '2026-10-27');
});

test('a broken, empty or incomplete feed is rejected', () => {
  assert.throws(() => parseBmfFeed('<html>Wartungsarbeiten</html>'), /not an RSS feed/);
  assert.throws(() => parseBmfFeed(decodeFeed(feedBytes([]))), /no entries/);
  assert.throws(() => parseBmfFeed(decodeFeed(feedBytes(undefined, { complete: false }))), /incomplete/);
});

// ------------------------------------------------------------------ the daily job

test('a successful fetch logs the fetch time and the publication date, and saves the copy', async () => {
  const { sqlite, env } = setup();
  const result = await refreshBmfFeed(env, { fetch: answer(feedBytes()), now: at('2026-10-28T04:17:03.120Z') });

  assert.equal(result.status, 'OK');
  const [fetch] = fetches(sqlite);
  assert.equal(fetch.fetched_at, '2026-10-28T04:17:03.120Z');
  assert.equal(fetch.status, 'OK');
  assert.equal(fetch.feed_published_at, '2026-10-27');
  assert.equal(fetch.entry_count, 3);
  assert.equal(fetch.error, null);
  assert.equal(entries(sqlite).length, 3);
  assert.deepEqual(
    sqlite.prepare('SELECT DISTINCT fetch_id FROM bmf_feed_entries').all().map((row) => row.fetch_id),
    [fetch.id],
  );
});

test('a failed fetch is logged and the last good copy stays in use', async () => {
  const { sqlite, env } = setup();
  await refreshBmfFeed(env, { fetch: answer(feedBytes()), now: at('2026-10-27T04:17:00.000Z') });
  const goodCopy = entries(sqlite);

  const result = await refreshBmfFeed(env, { fetch: answer('Service Unavailable', 503), now: at('2026-10-28T04:17:00.000Z') });

  assert.equal(result.status, 'FAILED');
  const [, failed] = fetches(sqlite);
  assert.equal(failed.fetched_at, '2026-10-28T04:17:00.000Z');
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error, 'BMF feed answered HTTP 503');
  assert.deepEqual(entries(sqlite), goodCopy);
});

test('no answer in time, a network error or an incomplete feed count as failed fetches', async () => {
  const { sqlite, env } = setup();
  await refreshBmfFeed(env, { fetch: answer(feedBytes()) });

  const timeout = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  await refreshBmfFeed(env, { fetch: timeout });
  await refreshBmfFeed(env, { fetch: offline });
  await refreshBmfFeed(env, { fetch: answer(feedBytes(undefined, { complete: false })) });

  assert.deepEqual(
    fetches(sqlite).map((row) => [row.status, row.error]),
    [
      ['OK', null],
      ['FAILED', 'BMF feed did not answer within 30 s'],
      ['FAILED', 'fetch failed'],
      ['FAILED', 'Feed is incomplete (no closing </channel> tag)'],
    ],
  );
  assert.equal(entries(sqlite).length, 3);
});

test('a new successful fetch replaces the copy', async () => {
  const { sqlite, env } = setup();
  await refreshBmfFeed(env, { fetch: answer(feedBytes()) });
  await refreshBmfFeed(env, { fetch: answer(feedBytes([PERSON], { lastBuildDate: '28 Oct 2026' })) });

  assert.deepEqual(entries(sqlite), [{ name: 'MUSTERMANN Max', vat: 'ATU87654321', fn: null, published_on: '2026-09-03' }]);
  assert.equal(fetches(sqlite).at(-1).feed_published_at, '2026-10-28');
});

test('a feed as large as the real one (about 100 entries) is saved completely', async () => {
  const { sqlite, env } = setup();
  const items = Array.from({ length: 103 }, (_, i) =>
    COMPANY.replace('Österreicher Musterbau GmbH', `Musterfirma ${i + 1} GmbH`).replace('ATU12345678', `ATU${String(10000000 + i)}`),
  );
  const result = await refreshBmfFeed(env, { fetch: answer(feedBytes(items)) });

  assert.equal(result.entries, 103);
  assert.equal(entries(sqlite).length, 103);
  assert.equal(entries(sqlite).at(-1).name, 'Musterfirma 103 GmbH');
});

test('every fetch is written to the audit log and no partner check is started', async () => {
  const { sqlite, env } = setup();
  await refreshBmfFeed(env, { fetch: answer(feedBytes()), now: at('2026-10-28T04:17:00.000Z') });
  await refreshBmfFeed(env, { fetch: answer('', 500), now: at('2026-10-29T04:17:00.000Z') });

  const log = sqlite.prepare('SELECT created_at, action, details FROM audit_log ORDER BY id').all();
  assert.deepEqual(
    log.map((row) => [row.created_at, row.action, JSON.parse(row.details).status]),
    [
      ['2026-10-28T04:17:00.000Z', 'BMF_FEED_FETCH', 'OK'],
      ['2026-10-29T04:17:00.000Z', 'BMF_FEED_FETCH', 'FAILED'],
    ],
  );
  // FR-CHK-09: the daily fetch does not create requests.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});

test('the feed URL comes from BMF_FEED_URL, with the BMF address as default', async () => {
  const { env } = setup();
  const asked = [];
  const record = async (url) => {
    asked.push(url);
    return new Response(feedBytes());
  };
  await refreshBmfFeed(env, { fetch: record });
  await refreshBmfFeed({ ...env, BMF_FEED_URL: 'http://localhost:9999/mock.xml' }, { fetch: record });
  assert.deepEqual(asked, [DEFAULT_BMF_FEED_URL, 'http://localhost:9999/mock.xml']);
});

// ------------------------------------------------------------------ the schedule

test('the Worker has a daily cron trigger that runs the job', async () => {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /\[triggers\]\s*\ncrons = \["17 4 \* \* \*"\]/);

  const { sqlite, env } = setup();
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = answer(feedBytes());
  console.log = () => {};
  try {
    await worker.scheduled({ cron: '17 4 * * *', scheduledTime: Date.now() }, env, { waitUntil() {} });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(fetches(sqlite)[0].status, 'OK');
});
