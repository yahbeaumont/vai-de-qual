# Architecture

## Context

Vai de Qual is a betting platform for the Brazilian market. Players fund a wallet through Pix, play casino games or bet on a simulated football league, and request withdrawals that an operator approves by hand. Operators use a backoffice for user management, manual adjustments, the withdrawal queue, ledger statements and the audit log. The product operates under Brazilian betting regulation, which is why every movement of money has to be explainable, and why the administrative surface is a separate security zone.

This generation moves the brand from a single-file HTML community product to four runtime pieces: a static front end, a modular API, PostgreSQL and Redis. The transactional product is new, and the story of that transition is in [CASE-STUDY.md](CASE-STUDY.md).

## Components and responsibilities

**Player front end.** A Next.js application compiled to static files. It holds no rule that affects money: it validates shapes for feedback, animates rounds, and renders API responses. Crash animation is driven locally from a server timestamp, so the browser draws the curve but never decides the outcome.

**Admin portal.** A second static build from the same codebase, on a different hostname, with its own entry point, routes and origin, so it can be allowlisted independently.

**API.** A NestJS process with 13 feature modules: auth, admin, ledger, wallet, payments, withdrawals, bonus, games core, and one module per game (crash, mines, double, slots, league). Modules own their controllers, services, guards and constants; cross-module access uses exported services. 48 HTTP routes, a few administrative and two internal.

**PostgreSQL.** The ledger of record and the product state. Money is `bigint` cents, never floating point. Constraints encode invariants that must not depend on a code path: player wallet balances cannot be positive, round states have a fixed set of legal values, and game board arrays have shape checks. 22 migrations, 13 models.

**Redis.** Server-side sessions, fixed-window rate limit counters and rotation counters. It holds no money and nothing that cannot be rebuilt, and every consumer fails closed: if Redis is unavailable, authentication returns 503 instead of admitting the request.

**Payment provider.** Stripe Checkout in payment mode, restricted to Pix. The API never sees card data or bank credentials.

## Boundaries and contracts

Every request passes the global session guard unless its method and path are on a short public allowlist (health, register, login, webhook) or it is one of two internal round routes. The guard resolves the cookie to a Redis session, loads the user, and rejects a blocked user or a stale session version.

The money boundary is the ledger module. Nothing outside it writes a balance. Callers pass an idempotency key, a transaction kind and a list of account code and amount pairs. The module validates at least two entries on distinct accounts, no zero amount, a zero sum and bigint range, then updates the materialised balances and appends the entries. A caller that needs atomicity between a domain row and its posting passes its own transaction client.

The webhook boundary is the payment module. The route is public because the provider cannot hold a session, and it is authenticated by an HMAC signature over the raw body with a per-environment secret. The handler maps a small set of event types to state transitions and answers 200 to everything else, so the provider stops retrying.

Two internal round routes serve maintenance tooling, guarded by a shared key compared in constant time and never called by the front end.

The database boundary is Prisma with migrations applied by a release command, never `migrate dev` against a shared environment, and the API does not migrate at boot.

## Request flow

A deposit, end to end:

1. `POST /payments/deposit` with a mandatory `Idempotency-Key` and an amount as an integer string. Rate limits run first, per IP and per user.
2. In a transaction: lock the user row, look up the key, sum the day's pending and paid deposits for the daily cap in the São Paulo timezone, insert a pending deposit, commit.
3. Ask the provider for a checkout session carrying the deposit id in metadata and a provider idempotency key. Persist session id, URL and expiry; on failure, mark the deposit failed.
4. The player pays the Pix charge in the provider's page. The checkout session and the Pix charge expire on separate clocks, both 30 minutes, and neither is computed from the other.
5. The provider posts a signed event. The handler verifies the signature, resolves and locks the deposit, confirms it is still pending and the session is paid, posts the ledger transaction with a session-derived key, marks it paid, records bonus progress in the same transaction, and returns 200.
6. The wallet screen reads the balance from the account row; the return URL only triggers a refresh.

A round is shorter. The bet endpoint locks the user, increments the nonce, opens the round, debits the stake through the ledger with a key derived from the round id, and commits. Settlement or cashout locks the user and then the round, computes the payout server side, posts a second transaction with its own key, and writes the terminal state. A concurrent cashout loses the lock race and receives the terminal state instead of a second payout.

## Data model, conceptually

Accounts form a tree by code prefix in four classes: assets (cash and receivables), liabilities (player wallets, money in transit), revenue (game results and fees) and expenses (prizes, granted bonus, provider fees). Each player gets a liability subaccount on registration, and a second one holds bonus balance. Every account carries a materialised balance equal to the signed sum of its entries.

A ledger transaction is a header with an idempotency key, a kind and a description. Entries belong to a transaction and reference an account with a signed amount. Entries are append-only, with no update or delete path.

Deposits, withdrawals, rounds and league events reference the ledger by convention, through transaction kinds and key prefixes. A round records the seed hash in force when it opened, the protocol version used for its randomness, and its terminal state. An audit row is written in the same transaction as each administrative action, with a key that makes the action replayable without duplication.

## Deployment

Two static hosting targets (player and admin) and one container for the API. The front end is built per environment because the API origin is compiled in. The API validates its environment at boot with zod and refuses to start when a value is missing. Migrations run as a release command before the new process takes traffic. A nightly CI job runs six randomness distribution suites with one million samples each against a disposable database.

## Known limits

There is no queue between the API and the provider, so a slow call occupies a request. There is no event store: the handler applies transitions directly, and a missing event is caught by reconciliation, not by a retry schedule. The simulated league is driven by an external cron calling a CLI entry point, so it stops if that scheduler stops. Reconciliation reports divergence and never repairs it, deliberately, at some operational cost. Multi-region, read replicas and session affinity across instances are out of scope: the API assumes one PostgreSQL primary and one Redis per environment.
