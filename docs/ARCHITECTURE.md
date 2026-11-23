# Architecture

## Context

Vai de Qual is a football community platform for the Brazilian market. Readers and analysts create profiles, publish posts and match analysis, comment, follow each other, save items and receive notifications. Part of the content sits behind paid plans, credits buy single items, and creators receive a share of what their content generates. Operators use a backoffice for moderation, account blocking, plan and entitlement inspection, payout approval, ledger statements and the audit log.

The content is the product and the money is smaller than it looks, but the money is the part that has to be explainable line by line, which is why the ledger has a single writing path and why the administrative surface is a separate security zone.

This generation moves the brand from a single-file HTML community product to four runtime pieces: a static front end, a modular API, PostgreSQL and Redis. The financial and access layer is new, and the story of that transition is in [CASE-STUDY.md](CASE-STUDY.md).

## Components and responsibilities

**Community front end.** A Next.js application compiled to static files. It holds no rule that affects money or access: it validates shapes for feedback, renders API responses, and treats access as a fact returned by the API, never as a local flag. A premium post arrives as a preview unless the API decides otherwise.

**Admin portal.** A second static build from the same codebase, on a different hostname, with its own entry point, routes and origin, so it can be allowlisted independently.

**API.** A NestJS process with feature modules: auth, profiles and social graph, content and moderation, plans and payments, credits, creator payouts, administration. Two pieces sit below all of them: the ledger, which owns every write to a balance, and reconciliation, which is a CLI entry point rather than a controller. Modules own their controllers, services, guards and constants, and cross-module access uses exported services.

**PostgreSQL.** The ledger of record and the product state. Money is `bigint` cents, never floating point. Constraints encode invariants that must not depend on a code path: a user credit balance cannot be positive, an entitlement period cannot end before it starts, and purchase and moderation states have a fixed set of legal values.

**Redis.** Server-side sessions, fixed-window rate limit counters and notification counters. It holds no money and nothing that cannot be rebuilt, and every consumer fails closed: if Redis is unavailable, authentication returns 503 instead of admitting the request.

**Payment provider.** Stripe Checkout for plan purchases and credit packs. The API never sees card data.

## Boundaries and contracts

Every request passes the global session guard unless its method and path are on a short public allowlist (health, register, login, webhook). The guard resolves the cookie to a Redis session, loads the user, and rejects a blocked user or a stale session version.

The money boundary is the ledger module. Nothing outside it writes a balance. Callers pass an idempotency key, a transaction kind and a list of account code and amount pairs. The module validates at least two entries on distinct accounts, no zero amount, a zero sum and bigint range, then updates the materialised balances and appends the entries. A caller that needs atomicity with a domain row passes its own transaction client. The kinds in use are plan purchase, credit purchase, credit redemption, creator payout, refund and manual adjustment.

The access boundary is the entitlement service. Every premium read asks it with the reader id and the content id, and it answers from entitlement rows and credit accounts. It never reads a flag from the client, and the front end has no code path that can decide on its own that a premium post is free.

The webhook boundary is the payment module. The route is public because the provider cannot hold a session, and it is authenticated by an HMAC signature over the raw body with a per-environment secret. The handler maps a small set of event types to state transitions and answers 200 to everything else, so the provider stops retrying.

The content boundary is the moderation module. Every publish path passes the same check: body length, link policy, a term list and the author's standing. A removal writes a moderation record and an audit row in one transaction and never deletes the post, so the record of what was removed survives the removal.

The database boundary is Prisma with migrations applied by a release command, never `migrate dev` against a shared environment, and the API does not migrate at boot.

## Request flow

A plan purchase, end to end:

1. `POST /plans/checkout` with a mandatory `Idempotency-Key` and a plan code. Rate limits run first, per IP and per user.
2. In a transaction: lock the user row, look up the key, insert a pending purchase, commit.
3. Ask the provider for a checkout session carrying the purchase id in metadata and a provider idempotency key. Persist session id, URL and expiry; on failure, mark the purchase failed.
4. The buyer pays on the provider's page and returns to the front end, which refreshes. The return URL carries no authority.
5. The provider posts a signed event. The handler verifies the signature, resolves and locks the purchase, confirms it is still pending and the session is paid, posts the ledger transaction with a session-derived key, marks the purchase paid and writes the entitlement with its period, then returns 200.
6. The account screen reads the entitlement and the credit balance; the return URL only triggers a refresh.

A post is shorter. The publish endpoint validates the body with zod, checks the author's standing and the term list, writes the post, and commits. Nothing on that path touches the ledger: a post is free to write, and access is decided when it is read.

A feed page is a keyset query over follows and saved items with a cursor, and it asks the entitlement service once per page instead of once per item. A premium post returns its body only when an entitlement or a redeemed credit covers it; otherwise it returns a preview and the reason for it.

## Data model, conceptually

Accounts form a tree by code prefix in four classes: assets (cash at the provider and receivables), liabilities (user credit balances and creator payables), revenue (plan periods recognised and credits consumed) and expenses (creator payouts and provider fees). Each user gets a credit subaccount on registration, and every account carries a materialised balance equal to the signed sum of its entries.

A ledger transaction is a header with an idempotency key, a kind and a description. Entries belong to a transaction and reference an account with a signed amount. Entries are append-only, with no update or delete path.

Around the ledger, the product tables are profile, follow, post, comment, saved item, notification, report, moderation action, plan, purchase, entitlement, credit pack, payout and audit. Purchases, entitlements and payouts reference the ledger by convention, through transaction kinds and key prefixes. An entitlement records its source (a plan purchase, a credit pack or a manual grant), the plan it refers to, a start and an end. An audit row is written in the same transaction as each administrative action, with a key that makes the action replayable without duplication.

## Deployment

Two static hosting targets (community and admin) and one container for the API. The front end is built per environment because the API origin is compiled in. The API validates its environment at boot with zod and refuses to start when a value is missing. Migrations run as a release command before the new process takes traffic. A scheduled job runs the reconciliation entry point, which exits non zero when a materialised balance disagrees with the entries behind it.

## Known limits

There is no queue in front of the provider, so a slow call occupies a request. There is no event store: the handler applies transitions directly, and a missing event is caught by reconciliation, not by a retry schedule. Reconciliation reports divergence and never repairs it, deliberately, at some operational cost. The feed is fan-out on read: a keyset query joins follows at request time, so an account that follows a large number of creators pays for that on every page, and a fan-out on write cache was considered and left out because it adds a second copy of the graph that can disagree with the first. Moderation is a term list plus human review, with no classifier. Multi-region, read replicas and session affinity across instances are out of scope: the API assumes one PostgreSQL primary and one Redis per environment.
