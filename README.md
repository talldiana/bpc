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
| `D1_DATABASE` | no | D1 database name, default `bpc` |

What the script does:

1. Applies all migrations in `migrations/` that have not run yet.
2. Creates the Super Admin, without a password. The Super Admin then creates the Clerk account with the same e-mail address on `/signup`; the first sign-in links the two (see Login).

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
3. `npx wrangler secret put CLERK_SECRET_KEY` with the secret key of the Clerk instance (see Login).
4. `npm run deploy`. Wrangler creates the custom domain and its TLS certificate. The zone (`hsynrsd.dev`) must be on the same Cloudflare account.

## Organisation registration

SCRUM-12 (FR-ORG-01): a new organisation registers for free on `/register` with its name, its company register number (Firmenbuchnummer) and the first name, last name and e-mail address of its first Organisation Admin.

- `POST /api/organisations` `{ "organisationName", "organisationNumber", "firstName", "lastName", "email" }` answers 201 `{ "organisationId" }`, 400 `INVALID_INPUT` with an error code per field, or 409 `ORGANISATION_EXISTS` / `EMAIL_IN_USE`.
- The number is accepted as `FN 123456a`, `123456a` or `fn 123456 A` and stored as `FN 123456a`.
- The admin is created as `ADMIN` with status `PENDING`. Right after registering, the page shows Clerk's sign-up with the same e-mail address; once Clerk has verified the address, the first sign-in activates the admin (see Login).

## Login (Clerk)

SCRUM-104 (SI-06, CR-09): the team does not implement authentication itself. Sign-in, sign-up, e-mail verification (with a code) and password reset are handled by **Clerk**; the database holds no passwords (QS-SEC-02).

**Why Clerk:** it runs with Cloudflare Workers (`@clerk/backend` verifies sessions in the Worker, the browser part loads from Clerk's CDN without a build step), its free plan is far more than enough for this project (50,000 monthly users), and it has ready-made sign-in and sign-up forms with e-mail verification and password reset. EU data location: not checked yet; see open points in the PR.

How it fits together:

- Pages: `/login` (Clerk sign-in), `/register` (organisation registration, then Clerk sign-up), `/signup` (Clerk sign-up for users that already exist here, e.g. the Super Admin), `/app/` (only for signed-in users).
- The Worker checks the Clerk session on `/api/me` and on every page under `/app/`, and maps the Clerk user to our user, organisation and role (`src/auth.js`). Without a session `/app/` redirects to `/login` and `/api/me` answers 401. A Clerk account that belongs to no user here gets 403 `NOT_REGISTERED` on both (the page says so and offers logout).
- First sign-in: when Clerk reports the user's primary e-mail address as verified, the user with that address is linked via `users.external_user_id` and set to `ACTIVE` (`linkExternalUser()` in `src/registration.js`). Deactivated users are never linked and lose access at once.
- Keys: `CLERK_PUBLISHABLE_KEY` is public and set in `wrangler.toml`. `CLERK_SECRET_KEY` is a secret: `npx wrangler secret put CLERK_SECRET_KEY`, and locally in `.dev.vars` (see `.dev.vars.example`). Never commit it.
- In the Clerk dashboard: sign-in with e-mail address and password only; e-mail verification by **code** (a link opens a new tab and the sign-up was not finished there); user enumeration protection **Strict** (a failed login does not say whether the address exists, SCRUM-14); access mode **Open** (new organisations sign up after registering).
- Secret keys are shown only once in the Clerk dashboard. Copying the masked key (`sk_test_B••••`) does not work; create a new key and copy it right away.

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

## VIES check and proof of concept

The VIES adapter (SCRUM-66, `src/adapters/vies.js`) checks VAT numbers of every EU member state through the European Commission's VIES REST service.

- A valid number is `VALID` with the registered name and address; an invalid one is `INVALID`.
- A number without an EU prefix is `INVALID` without calling VIES. If VIES or a member state's service is down, the result is `UNAVAILABLE`.
- `VIES_URL` overrides the endpoint, for example with the VIES test service, where `100` is a valid and `200` an invalid number.

The Sprint 1 proof of concept (DI-07, SCRUM-25) runs one check through all adapters and reads the live BMF feed:

```sh
npm run poc -- ATU12345678      # real VIES
npm run poc -- AT100 --test     # VIES test service
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
