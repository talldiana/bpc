# bpc
BizPartnerCheck

## Setup

The setup script creates the database schema and the one Super Admin account (DI-01).
It runs on Cloudflare D1 through `wrangler`.

Prerequisites: Node.js 22.5 or later, and `npm install`.

```sh
# Local development database (stored in .wrangler/)
SUPER_ADMIN_EMAIL=ops@example.com npm run setup

# Cloudflare D1 (needs `npx wrangler login` and the real database_id in wrangler.toml)
SUPER_ADMIN_EMAIL=ops@example.com npm run setup -- --remote
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `SUPER_ADMIN_EMAIL` | yes | E-mail address of the Super Admin |
| `SUPER_ADMIN_PASSWORD` | no | Initial password, at least 12 characters. If unset, a random one is generated and printed once. |
| `D1_DATABASE` | no | D1 database name, default `bpc` |

What the script does:

1. Applies all migrations in `migrations/` that have not run yet.
2. Creates the Super Admin with a hashed password, marked so the password must be changed at first login (assumption for OI-08).

Running it again is safe: already applied migrations are skipped, and if a Super Admin exists it prints its e-mail and creates nothing.
The database also refuses a second Super Admin through a unique index.

Run the tests with `npm test`.

## Deploy

The app runs on Cloudflare Workers at **https://bpc.hsynrsd.dev** (DI-02).
One Worker serves both parts on that domain: the web app as static files from `public/`, and the API under `/api/*` from `src/index.js`.
The workers.dev address is switched off, so every organisation uses the same domain.

```sh
npm run dev      # local server with a local D1 database
npm run deploy   # deploy to https://bpc.hsynrsd.dev (needs `npx wrangler login`)
```

`GET /api/health` returns `{"status":"ok"}` when the Worker and the database are reachable.

First deployment on a new Cloudflare account:

1. `npx wrangler d1 create bpc --location weur` and put the printed `database_id` in `wrangler.toml`.
2. `SUPER_ADMIN_EMAIL=... npm run setup -- --remote` to create the schema and the Super Admin.
3. `npm run deploy`. Wrangler creates the custom domain and its TLS certificate. The zone (`hsynrsd.dev`) must be on the same Cloudflare account.

## Password reset

SCRUM-15: users who forgot their password open `/reset-password.html`, enter their e-mail address and get a link that works once for 30 minutes.

- `POST /api/password-reset` `{ "email" }` always answers 202, so it does not reveal which addresses have an account. At most 3 links per user per hour.
- `POST /api/password-reset/confirm` `{ "token", "password" }` answers 204, or 400 with `INVALID_LINK`, `PASSWORD_TOO_SHORT` or `PASSWORD_TOO_LONG`.
- Apply the new table with `npx wrangler d1 migrations apply bpc --remote` (or `npm run setup -- --remote`).
- E-mails are only logged until a provider is set: `npx wrangler secret put RESEND_API_KEY` and `npx wrangler secret put MAIL_FROM`.

## BMF feed (FR-DOC-06)

Once a day at 04:17 UTC (05:17 Vienna time in winter) a Cron Trigger runs the Worker's `scheduled` handler, which fetches the BMF fake company feed (SCRUM-18, `src/bmf-feed.js`).

- Every run adds a row to `bmf_feed_fetches` with the fetch time (UTC) and the feed's own publication date. BMF publishes dates without a time of day, so the publication time is a date, e.g. `2026-10-27`.
- A successful run replaces the copy in `bmf_feed_entries`. Only name, VAT number, FN and publication date are kept for each entry (CMP-01).
- A failed run (no answer within 30 s, an HTTP error, or a broken, empty or incomplete feed) is logged with its error, and the last good copy stays in use.
- Every run is also written to `audit_log` as `BMF_FEED_FETCH`. The job never starts a partner check (FR-CHK-09).

The feed URL defaults to `https://service.bmf.gv.at/service/allg/lsu/rss_lsu.asp` and can be overridden with the `BMF_FEED_URL` variable, for example to point at a mock.

Run the job locally without waiting for the schedule:

```sh
npx wrangler d1 migrations apply bpc --local   # creates the new tables
npm run dev
# in a browser: http://localhost:8787/cdn-cgi/local/scheduled
npx wrangler d1 execute bpc --local --command "SELECT * FROM bmf_feed_fetches"
```

## Availability

QS-AVL-01: the service is available as far as the hosting provider guarantees.

- **Provider:** Cloudflare Workers (Workers Paid plan) with Cloudflare D1.
- **Guarantee:** none in a contract. On this plan Cloudflare gives no uptime guarantee, so availability is best effort.
  The [Workers SLA](https://www.cloudflare.com/workers-service-level-agreement) (target of 99.99% monthly uptime, service credits as the only remedy) belongs to Cloudflare's Enterprise agreements.
  It covers the Workers runtime only, not D1 or other Cloudflare services.
- **Maintenance windows:** none planned. `npm run deploy` replaces the Worker without downtime.
- **Checking it:** `GET https://bpc.hsynrsd.dev/api/health` returns 200 when the Worker and the database are up, and 503 when the database is unreachable.

## Contributing

Every change must be traceable to a backlog item in Jira (project key `SCRUM`).
`main` is protected: nobody pushes to it directly, all changes go through a pull request.

### Branches

Create one branch per Jira issue, named `<ISSUE-KEY>-<short-description>`:

```
SCRUM-11-setup-script
SCRUM-34-org-profile
```

```sh
git switch main
git pull
git switch -c SCRUM-11-setup-script
```

### Commits

Start every commit message with the issue key followed by a colon:

```
SCRUM-11: Create database schema
SCRUM-11: Add Super Admin seed to setup script
```

### Pull requests

1. Push your branch and open a pull request against `main`.
2. Put the issue key at the start of the PR title, e.g. `SCRUM-11: Setup script for schema and Super Admin`.
3. Fill in the `Jira issue: SCRUM-__` line in the PR template.
4. The **Jira key check** workflow must pass. It fails if the PR title or the branch name has no `SCRUM-<number>` key.
5. Get a review from at least one teammate, then merge.

Because the issue key appears in the branch, commits and PR, the GitHub for Jira integration links all of them to the ticket automatically.
