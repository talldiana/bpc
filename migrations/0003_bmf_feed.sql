-- SCRUM-18 / FR-DOC-06: daily fetch of the BMF fake company feed.
-- All timestamps are UTC ISO 8601 strings (QS-OBS-01).

-- One row per fetch, successful or not.
CREATE TABLE bmf_feed_fetches (
  id                INTEGER PRIMARY KEY,
  fetched_at        TEXT    NOT NULL,                    -- when the job fetched the feed (UTC)
  status            TEXT    NOT NULL CHECK (status IN ('OK', 'FAILED')),
  feed_published_at TEXT,                                -- the feed's own publication date (lastBuildDate).
                                                         -- BMF gives a date without a time, e.g. 2026-10-27.
  entry_count       INTEGER,                             -- entries in the copy (OK fetches only)
  error             TEXT                                 -- why the fetch failed (FAILED fetches only)
);

CREATE INDEX bmf_feed_fetches_fetched_at ON bmf_feed_fetches (fetched_at DESC);

-- The last good copy of the feed. Only a successful fetch replaces it, so a
-- failed fetch leaves the previous copy in use. Only the fields the BMF check
-- needs are kept; addresses and birth dates are not stored (CMP-01).
CREATE TABLE bmf_feed_entries (
  id           INTEGER PRIMARY KEY,
  fetch_id     INTEGER NOT NULL REFERENCES bmf_feed_fetches (id),
  name         TEXT    NOT NULL,                         -- company or person as listed by BMF
  vat          TEXT,                                     -- UID, e.g. ATU12345678; NULL when BMF does not know it
  fn           TEXT,                                     -- Firmenbuchnummer, e.g. 123456a; NULL for persons
  published_on TEXT                                      -- date BMF published the entry
);

CREATE INDEX bmf_feed_entries_vat ON bmf_feed_entries (vat);
CREATE INDEX bmf_feed_entries_fn ON bmf_feed_entries (fn);
