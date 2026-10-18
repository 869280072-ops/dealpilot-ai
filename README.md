# DealPilot AI — P1 AI Requirements & Quotation MVP

DealPilot AI builds on the Next.js SaaS Starter and the merged P0 security baseline. P1 adds a working Chinese-first requirements, AI analysis and quotation workspace at `/dashboard/workbench`. See [P1 development and acceptance report](docs/P1-MVP.md) for migration steps, synthetic demos, configuration and test evidence.

P1 supports private bilingual requirements, structured AI analysis with explicit Demo/live modes, owner-managed team price catalogs, deterministic CNY/USD/EUR quote calculation, manual editing, explicit human confirmation and versioned history. Keep `LEGACY_STRIPE_ENABLED=false`.

## Current capabilities and limits

- Email/password authentication with bcrypt and signed, HttpOnly session cookies.
- Account settings, team dashboard and activity logs; server-side team owner authorization.
- Explicit public-user fields at API and client serialization boundaries.
- Legacy Stripe code is retained but **disabled by default**. Keep `LEGACY_STRIPE_ENABLED=false`; no real payment keys or transactions are needed for development.
- Invitation requests can be recorded, but email delivery and invitation acceptance remain disabled.
- See [P0 validation and remaining risks](docs/P0-BASELINE.md). Passing the build is not approval to launch paid services.

## Development prerequisites

Use Node.js 24 and pnpm 9.15.9 as pinned in `.nvmrc` and `package.json`. The application uses Next.js 16.4.2, React 19.3.1, PostgreSQL, Drizzle and Tailwind/shadcn UI. Production builds use webpack.

```sh
git clone https://github.com/869280072-ops/dealpilot-ai.git
cd dealpilot-ai
pnpm install --frozen-lockfile
```

## Running locally

Create a private `.env` from `.env.example` without overwriting an existing file. Configure `POSTGRES_URL` for a **dedicated local development database**, `BASE_URL` for your local server, and `AUTH_SECRET` with at least 32 random bytes (for example, generate a value with `openssl rand -base64 32`). Keep `.env` out of Git and keep payments disabled. Do not use production database credentials.

Stripe login is not required. The legacy `db:setup` helper includes Stripe CLI setup and is not needed for this baseline.

### Database migration

Migrations create/update the schema; they do not create a test account. Check that `.env` targets your development database, then run:

```sh
pnpm db:migrate
```

### Optional, explicitly authorized development seed

You can create accounts using `/sign-up`; seeding is optional. There is **no public default account or password**.

Seed requires all of the following:

- `ALLOW_DEV_SEED=true` and a non-production `NODE_ENV`.
- A valid custom `SEED_EMAIL` (at most 255 characters).
- A custom `SEED_PASSWORD` of at least 12 characters and at most 72 UTF-8 bytes.
- `POSTGRES_URL` pointing only to an already migrated, disposable development database.

For example, in a Bash terminal, enter your own credentials without placing the password in shell history:

```sh
read -r -p 'Development account email: ' SEED_EMAIL
read -r -s -p 'Development account password: ' SEED_PASSWORD
printf '\n'
export SEED_EMAIL SEED_PASSWORD
NODE_ENV=development ALLOW_DEV_SEED=true pnpm db:seed
unset SEED_EMAIL SEED_PASSWORD
```

The CLI also loads `.env`; do not commit seed credentials. It refuses unauthorized/production invocations before connecting to the database. It creates a user and team with owner membership in a single transaction. Repeating the same email is a successful no-op, including concurrent calls: it never replaces an existing password, account or membership. Deleted accounts are not reactivated. An existing unrelated account is also left unchanged. Failures roll back new records, close the connection and return a nonzero exit code without logging credentials.

`NODE_ENV` and explicit opt-in are safeguards, not proof that a database is non-production. Verify the target yourself; never run seed against production or real user data.

Start the application with:

```sh
pnpm dev
```

Open http://localhost:3000. Existing sessions from before the P0 credential-version change must sign in again.

## P1 blocker fixes

See [P1 blocker fix report](docs/P1-BLOCKER-FIXES.md) for B1–B3, migration 0003, idempotency keys, durable AI request deduplication, rolling quotas and repeatable regression scripts. Apply migrations before running this branch. Successful same-version analyses are reused; failed/uncertain calls are not automatically retried. Real model tests remain opt-in and were not performed.

## P1 workspace

After migrating a dedicated local development database and signing up, open `/dashboard/workbench`. As team owner, add service prices in the required currency, then load a fictional demo, save it, analyze it and generate a draft. Review and save edits before explicitly confirming. Confirmed quotations are locked.

`DEALPILOT_AI_MODE=demo` is the default and calls no model. For a real OpenAI-compatible model, configure server-only `DEALPILOT_AI_MODE=live`, `DEALPILOT_AI_API_KEY`, `DEALPILOT_AI_MODEL` and optionally `DEALPILOT_AI_ENDPOINT`. Never expose a key using `NEXT_PUBLIC_`. Live failures do not silently become demos. See [the P1 report](docs/P1-MVP.md) for the provider protocol, limits and isolated PostgreSQL tests.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

CLI regression tests launch a separate ordinary Node/tsx process without Vitest mocks, check bcrypt compatibility and exercise denied seed invocations. Optional real PostgreSQL tests require `SEED_TEST_DATABASE_URL` to point to a **fresh, empty, local** database named `dealpilot_seed_test_*`; they apply the existing migration and write only synthetic accounts:

```sh
# Set SEED_TEST_DATABASE_URL to your own isolated temporary database first.
pnpm test
```

Without that explicit test URL, database integration tests are reported as skipped; mocked tests are not database verification. Destroy the disposable test database/container afterwards. These tests never fall back to the application's `POSTGRES_URL`.

## Payments and production readiness

Stripe/Vibe Pay payment flows have not been accepted for production. Browser returns cannot log users in or grant entitlements. Initial order binding, durable events, idempotent ledgers, concurrency/ordering, refunds and reconciliation require separate implementation and acceptance testing. Do not enable real payments or interpret the retained Stripe module as a ready-to-charge feature.

Real database authorization regression, operational deployment validation and the remaining risks in [the P0 report](docs/P0-BASELINE.md) still apply. This document is not a deployment or charging authorization.

## License and attribution

Based on [Vercel's Next.js SaaS Starter](https://github.com/nextjs/saas-starter). The original MIT license and Copyright (c) 2025 Vercel notice remain in [LICENSE](LICENSE).

## Other Templates

While this template is intentionally minimal and to be used as a learning resource, there are other paid versions in the community which are more full-featured:

- https://achromatic.dev
- https://shipfa.st
- https://makerkit.dev
- https://zerotoshipped.com
- https://turbostarter.dev
