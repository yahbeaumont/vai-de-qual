# Security

This document describes the security model of the current generation: what is protected, where the trust boundaries are, which threats were considered, what was implemented, and what is explicitly not guaranteed. It contains no audit report and no penetration test result. Those documents are internal and are not published, and nothing here should be read as a certification.

## Assets

The assets are, in order of consequence: the integrity of the ledger, because a wrong balance is money the platform owes and cannot explain; the availability of the payment flow, because a stuck purchase is a support incident with a financial claim attached; account data, which includes an e-mail, a name, a birth date and everything a person chose to publish; the administrative capability, because an operator session can remove content, block an account, grant an entitlement and approve a payout; and the integrity of the moderation record, because a removal without a record is indistinguishable from censorship.

## Trust boundaries

**Browser to API.** Untrusted. Everything the browser sends is input, including the amount, the plan code, the content body, the user id it claims to act for, and the `Origin` header. The session cookie is a bearer credential and is treated as such.

**API to PostgreSQL.** Trusted transport, untrusted writer. The database enforces the invariants that matter, so a bug in the API cannot persist an illegal balance, an entitlement that ends before it starts, or a purchase in a state the state machine does not have.

**API to Redis.** Trusted for sessions and counters, and assumed to fail. When it fails, authentication and rate-limited operations reject rather than proceed.

**Payment provider to API.** Authenticated by signature. The webhook route is public, so the signature over the raw body is the only thing separating a real event from a forged one, and the raw body must be captured before any JSON parsing.

**Operator browser to admin API.** The most sensitive boundary. It is protected by the session, the role and an exact origin check, in that order of importance.

**API to payout execution.** The application records the decision and the posting, and the money leaves through the provider. The two sides are compared by reconciliation, not by trust: a transfer that the provider reports and the ledger does not is exactly the divergence the job exists to find.

## Threats considered

Stolen or replayed session cookies; session fixation; a session that outlives a block or a logout; cross-site request forgery against the admin surface; cross-origin reads of account data, purchase history or ledger statements; forged or replayed payment webhooks; double granting of access through retries, duplicate tabs or duplicate events; overdraw of a credit balance through concurrent redemptions; amount tampering through floating point or client-supplied values; enumeration of accounts through timing or error differences; credential stuffing against login; scraping of premium content through the public endpoints; privilege escalation from USER to ADMIN; an operator approving the same payout twice; a compromised dependency or a secret committed to the repository.

## Controls implemented

**Authentication.** Passwords are hashed with argon2id. A login attempt for an address that does not exist still performs a verification against a dummy hash, so the response time does not reveal whether the account exists. Registration enforces a unique e-mail at the database level, not only in validation.

**Sessions.** Opaque 32-byte tokens, stored server side in Redis with the user id and the session version, delivered in a cookie with `HttpOnly`, `Secure` in production, `SameSite=Lax` and a seven day lifetime. Logout deletes the Redis entry. Blocking an account, or changing a password, increments the version on the user row, which invalidates every existing session on the next request. A request with a missing, unknown or version-mismatched session is rejected with 401, and the guard fails closed with 503 when Redis is unavailable.

**Cross-tab identity.** Content and payment mutations carry the user id the client believes it is acting as. The API compares it with the identity derived from the cookie and returns 409 before any rate limit or effect when they differ. The header is not a credential; it is a consistency check that prevents a stale tab from acting as the account that logged in after it.

**CORS and origins.** CORS allows an explicit list of origins with credentials enabled, never a wildcard. Every admin controller additionally requires an `Origin` header exactly equal to the configured admin origin, on reads and writes, and rejects a missing header. The check is additional to the role guard, not a substitute.

**Authorisation.** Roles are USER and ADMIN, stored on the user row and resolved from the session on every request. Admin controllers require the ADMIN role. A USER cannot open an admin route, and an admin account has no special access to premium content, which is asserted by an integration test rather than assumed.

**Access control.** Every premium read asks the entitlement service with the reader id and the content id, and the answer is produced on the server. The front end receives a preview or a body, never a rule. A credit redemption is a ledger posting with its own key, so a double click or a retried request cannot spend twice, and an expired entitlement is refused at read time rather than by a job that may not have run.

**Payments.** The checkout request requires an `Idempotency-Key` under a unique index. Amounts are integers in cents, parsed from a digit string, range checked and normalised before use. The plan code is resolved on the server against the plan table, so the price never travels from the client. The webhook verifies an HMAC signature over the raw body with a per-environment secret, resolves the purchase from metadata or session id, and only grants when the stored purchase is still pending and the provider reports the session as paid. A replay is absorbed by the ledger idempotency key. The front-end return URL never grants anything.

**Ledger.** Every posting is validated for balanced entries, distinct accounts, non-zero amounts and bigint range, then applied with a fixed lock order. A `CHECK` constraint forbids a positive balance on a credit account, and the resulting `23514` error is translated into an insufficient funds response. Entries are append-only. Reconciliation compares materialised balances with the derived sum and reports divergence without repairing it.

**Payouts.** A payout batch is built from what a creator has earned, and approval is an administrative action written with an audit row in the same transaction. Approval and rejection are idempotent by key, so a double submission produces one posting. A payout that exceeds the creator's payable balance is refused by the same constraint that protects user credits, and a reversal is a posting rather than an edit of the original.

**Moderation.** Publishing and commenting pass a shared check for body length, link policy, a term list and the author's standing. A blocked account cannot publish, comment or follow, and the block takes effect on the next request because it also increments the session version. A removal writes a moderation record with the reason, the actor and the target, and never deletes the post row.

**Rate limits.** Fixed windows in Redis, applied per IP and per user, on registration, login, publishing, commenting, follow, checkout, credit redemption and payout approval. Limits fail closed. Responses include `Retry-After`, and the counters are separate per operation so that a busy feed cannot exhaust the budget of a checkout.

**Audit.** Administrative actions write an audit row in the same transaction as their effect, with actor, target, before and after state, and an idempotency key. If the action is retried, the audit row is not duplicated.

**Operational hygiene.** Secrets come from environment variables, never from the repository; `.env` files are ignored; the API validates its environment at boot and refuses to start when a required value is missing. Test suites assert that they are pointed at a disposable local database and Redis before they run. A scheduled job runs reconciliation and exits non zero when a materialised balance disagrees with its entries.

## What is not guaranteed

The origin check assumes a browser. Any HTTP client can send an `Origin` header of its choosing, so the admin origin guard does not defend against a non-browser attacker holding a valid admin cookie. It raises the cost of a cross-site attack and does nothing against a stolen token.

There is no multi-factor authentication, no device binding, no step-up confirmation for a large payout and no anomaly detection on operator behaviour. An admin credential is enough to grant an entitlement or approve a payout, and the only compensating controls are the audit log, the role boundary and the fact that payouts are postings against a payable account rather than edits.

Rate limits are fixed windows, not sliding ones, so a caller can double the effective rate around a window boundary. They are bounded per IP and per user, which does not stop a distributed attacker with many addresses. The fail-closed behaviour turns a Redis outage into a rejection of traffic, which is an availability trade that was accepted deliberately.

Moderation is a term list plus human review. There is no classifier and no automated hold, so its consistency is the consistency of the policy and of the person applying it.

Payout review is a human decision. There is no fraud score, no velocity model and no automated hold, so the quality of that control depends on the operator.

Backups, restore drills, database access control, host hardening, secret rotation and provider-side risk are operational concerns outside the application. The payment provider relationship is shared with other products, so a provider-level restriction would affect this product regardless of its own controls, and no application change removes that exposure.

Finally, this repository publishes no audit result. The controls above are the ones implemented in the code, described from the code, and several of them are covered by integration tests that run against real PostgreSQL and Redis. That is evidence of intent and of behaviour under test, not proof of absence of defects.

## Reporting a problem

This is a portfolio repository with no deployed environment attached to it. If you find a problem in the published examples or in the description of the design, open an issue in this repository or contact the author through the profile linked in the README. Do not test anything against a live service; there is nothing here to test against.
