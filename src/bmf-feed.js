// SCRUM-18 / FR-DOC-06: fetch the BMF fake company feed (Liste der
// Scheinunternehmen) at least once a day, log the fetch time and the feed's own
// publication date, and keep the last good copy when a fetch fails.
//
// The feed is RSS 2.0 encoded in ISO-8859-1. BMF writes its dates without a time
// of day (e.g. "27 Oct 2026"), so the publication "time" is stored as a date.

// Default source. BMF_FEED_URL overrides it (for example to point at a mock);
// moving all source configuration out of the repository is DI-04 / SCRUM-88.
export const DEFAULT_BMF_FEED_URL = 'https://service.bmf.gv.at/service/allg/lsu/rss_lsu.asp';

const TIMEOUT_MS = 30_000;

// Windows-1252 characters for the bytes 0x80-0x9F. Browsers decode ISO-8859-1
const CP1252_80_9F =
  '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F' +
  '\u0090‘’“”•–—˜™š›œ\u009DžŸ';

function decodeLatin1(bytes) {
  let text = '';
  for (const byte of bytes) {
    text += byte >= 0x80 && byte <= 0x9f ? CP1252_80_9F[byte - 0x80] : String.fromCharCode(byte);
  }
  return text;
}

// Turns the raw response into text, using the encoding from the XML declaration
// (or the Content-Type header). Without this, umlauts in names come out garbled.
export function decodeFeed(bytes, contentType = '') {
  const head = decodeLatin1(bytes.subarray(0, 200));
  const encoding =
    /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ?? /charset=([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  return /^utf-?8$/i.test(encoding) ? new TextDecoder('utf-8').decode(bytes) : decodeLatin1(bytes);
}

// ---------------------------------------------------------------- parsing

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// "27 Oct 2026" -> "2026-10-27". A full RFC 822 date with a time of day
// ("Tue, 27 Oct 2026 08:00:00 GMT") -> UTC ISO 8601. Anything else -> null.
export function parseFeedDate(text) {
  if (!text) return null;
  const value = text.trim();
  const dateOnly = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(value);
  if (dateOnly) {
    const month = MONTHS[dateOnly[2].toLowerCase()];
    return month ? `${dateOnly[3]}-${String(month).padStart(2, '0')}-${dateOnly[1].padStart(2, '0')}` : null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (original, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()];
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point <= 0x10ffff ? String.fromCodePoint(point) : original;
  });
}

// Text of the first <tag> in xml, with a CDATA wrapper removed.
function tagText(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!match) return null;
  const inner = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return cdata ? cdata[1] : decodeEntities(inner);
}

// In the description: "<em>UID-NR:</em> ATU12345678" and "Firmenbuch-Nr: 123456a".
// Entries without a known UID have no UID-NR field at all.
const VAT = /UID-NR:\s*(?:<\/em>\s*)?([A-Z]{2}[A-Z]?\s?\d[0-9A-Z]{1,12})/i;
const FN = /Firmenbuch-?Nr\.?:?\s*(?:<\/em>\s*)?(?:FN\s*)?(\d{1,6}\s?[a-z])\b/i;

function parseItem(itemXml) {
  const title = tagText(itemXml, 'title');
  const name = title && decodeEntities(title).replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const description = tagText(itemXml, 'description') ?? '';
  return {
    name,
    vat: VAT.exec(description)?.[1].replace(/\s/g, '').toUpperCase() ?? null,
    fn: FN.exec(description)?.[1].replace(/\s/g, '').toLowerCase() ?? null,
    publishedOn: parseFeedDate(tagText(itemXml, 'pubDate')),
  };
}

// Reads the feed text into { publishedAt, entries }. Throws when the response
// is not a complete RSS feed with at least one entry, so a broken download is
// never saved as the new copy.
export function parseBmfFeed(xml) {
  if (!/<rss[\s>]/i.test(xml)) throw new Error('Response is not an RSS feed');
  if (!/<\/channel>/i.test(xml)) throw new Error('Feed is incomplete (no closing </channel> tag)');

  const firstItem = xml.search(/<item[\s>]/i);
  const channelHead = firstItem === -1 ? xml : xml.slice(0, firstItem);
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const entries = items.map(parseItem).filter(Boolean);
  if (entries.length === 0) throw new Error('Feed contains no entries');

  // The channel's lastBuildDate is the feed's publication date. If BMF ever
  // leaves it out, fall back to pubDate, then to the newest entry's date.
  const newestEntry = entries.map((entry) => entry.publishedOn).filter(Boolean).sort().at(-1) ?? null;
  const publishedAt =
    parseFeedDate(tagText(channelHead, 'lastBuildDate')) ?? parseFeedDate(tagText(channelHead, 'pubDate')) ?? newestEntry;

  return { publishedAt, entries };
}


const INSERT_FETCH = `INSERT INTO bmf_feed_fetches (fetched_at, status, feed_published_at, entry_count, error)
VALUES (?, ?, ?, ?, ?)`;

// D1 allows at most 100 bound values per statement, so entries are inserted in
// groups of 20 rows (80 values). This also keeps the number of statements per
// run small: about six for a feed of 100 entries.
const ROWS_PER_INSERT = 20;

// Runs in the same batch right after INSERT_FETCH, so the newest OK fetch is this one.
function insertEntries(db, entries) {
  const statements = [];
  for (let start = 0; start < entries.length; start += ROWS_PER_INSERT) {
    const rows = entries.slice(start, start + ROWS_PER_INSERT);
    const placeholders = rows.map(() => "((SELECT MAX(id) FROM bmf_feed_fetches WHERE status = 'OK'), ?, ?, ?, ?)");
    const values = rows.flatMap((entry) => [entry.name, entry.vat, entry.fn, entry.publishedOn]);
    statements.push(
      db
        .prepare(`INSERT INTO bmf_feed_entries (fetch_id, name, vat, fn, published_on) VALUES ${placeholders.join(', ')}`)
        .bind(...values),
    );
  }
  return statements;
}

const INSERT_AUDIT = `INSERT INTO audit_log (created_at, action, details) VALUES (?, 'BMF_FEED_FETCH', ?)`;

function failureMessage(error) {
  if (error?.name === 'TimeoutError') return `BMF feed did not answer within ${TIMEOUT_MS / 1000} s`;
  return String(error?.message ?? error);
}

// Fetches the feed once and records the result. Called by the Worker's
// scheduled handler; fetch and now can be replaced in tests.
export async function refreshBmfFeed(env, { fetch = globalThis.fetch, now = () => new Date() } = {}) {
  const db = env.DB;
  const fetchedAt = now().toISOString();

  let feed;
  try {
    const response = await fetch(env.BMF_FEED_URL || DEFAULT_BMF_FEED_URL, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`BMF feed answered HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    feed = parseBmfFeed(decodeFeed(bytes, response.headers.get('content-type') ?? ''));
  } catch (error) {
    // Log the failure and leave bmf_feed_entries untouched: the last good copy stays in use.
    const message = failureMessage(error);
    await db.batch([
      db.prepare(INSERT_FETCH).bind(fetchedAt, 'FAILED', null, null, message),
      db.prepare(INSERT_AUDIT).bind(fetchedAt, JSON.stringify({ status: 'FAILED', error: message })),
    ]);
    return { status: 'FAILED', fetchedAt, error: message };
  }

  // One batch is one transaction: the log line and the new copy are saved
  // together, or not at all.
  await db.batch([
    db.prepare(INSERT_FETCH).bind(fetchedAt, 'OK', feed.publishedAt, feed.entries.length, null),
    db.prepare('DELETE FROM bmf_feed_entries'),
    ...insertEntries(db, feed.entries),
    db
      .prepare(INSERT_AUDIT)
      .bind(fetchedAt, JSON.stringify({ status: 'OK', feedPublishedAt: feed.publishedAt, entries: feed.entries.length })),
  ]);
  return { status: 'OK', fetchedAt, feedPublishedAt: feed.publishedAt, entries: feed.entries.length };
}
