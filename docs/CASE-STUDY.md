# Case study: from a 2 MB page to a ledger

## The starting point

In August 2026 the brand shipped a football community. Fans and analysts published posts and match analysis, readers followed them, commented, saved what they wanted to read again, and part of the content sat behind paid access. The entire application was one HTML file per surface: about 2 MB of markup, styles, routing and business rules in a single document, with Cloud Functions called from the browser. The repository held 280 files and about 55,000 lines across 135 commits. For a content community that shape was cheap to build and it shipped.

Two months later the same community had to carry money, and that shape could not. Paid access was a boolean on a user record: no journal, no transactional boundary, no place where an invariant could live. Payment confirmation had no trustworthy boundary, because the browser returned from the checkout page with an identifier in the URL. Authorisation lived in the same document as the interface, so the admin panel was protected by a client-side check against a user record.

Underneath those three was a fourth: the deployed bundles could not be tied back to a commit. Files had been edited in place, copied from one branch to another and served through a hosting rewrite that pointed at an older artifact, so no rule had a traceable origin.

## Constraints

The work could not be a refactor, and it could not be a greenfield exercise either. The brand, the audience and the content model carried over, so the old product was a reference for behaviour and voice, not a specification for money. The new layer imposes hard requirements: every movement of money has to be reconstructible, the administrative surface has to be a separate security zone, the payment flow cannot depend on a client telling the truth, and access to paid content has to survive a page reload, a second device and a plan that lapsed while nobody was looking. The team was small, so the architecture had to fit in one or two heads.

The stack followed from those constraints: PostgreSQL for transactions, `CHECK` constraints and exact integer arithmetic; Redis for sessions and rate limit counters with a TTL; NestJS for module boundaries and guards; Prisma for reviewable migrations; Next.js static export because the front end needs no server runtime, and every process not deployed is a process not to patch.

## What was built

The current generation is a static export with a separate build for the admin portal, a NestJS API split by feature, PostgreSQL as the ledger of record, Redis for sessions and rate limits, and Stripe for plan and credit payments. Money moves only through a double-entry ledger. A purchase is confirmed only by a signed webhook. Access to premium content is an entitlement with a period instead of a flag, written in the same transaction as the payment that bought it. Sessions are server-side, opaque and versioned. A reconciliation job recomputes every materialised balance from its entries and reports what does not match. The generation's own internal metrics are not published here; the foundation it was written against was 24 files and 15 commits.

## The four hard problems

### A balance that survives concurrency

The first attempt checked the balance inside the posting function. A concurrency test with parallel redemptions showed the flaw: two transactions read the same value, both conclude there is room, and both write. A lock fixed it for callers that took the lock, and did nothing for a migration script that forgot.

The design moved the invariant into the database. Credit accounts are liability accounts with a flag, and a `CHECK` constraint forbids a positive stored balance on a flagged account, given a sign convention where a credit to a user is a negative entry. The posting function then has one failure mode: the constraint rejects the update, the driver reports SQLSTATE `23514`, and that becomes an insufficient funds error and a 422. Nothing is clamped and nothing is repaired.

Two details came out of this. Balances are updated in a fixed order by account code, because postings that touch the same pair in opposite orders deadlock, and a deadlock inside a checkout is a failed purchase. Reconciliation became a CLI that recomputes each materialised balance from its entries and reports the difference without correcting it.

### The truth problem in payments

The purchase flow looks simple until the failure modes are listed: the buyer closes the tab, returns twice, returns without paying, pays after the session expired, or the webhook arrives twice.

The design that survived treats the webhook as the only event that moves money, and makes the local record exist before any network call: a purchase row is committed first, then a checkout session is requested. The `Idempotency-Key` header is mandatory, and its unique index turns a duplicate request into a read of the original row. The same key with a different payload is a conflict, and a collision during the insert race is retryable because the first transaction may not have committed.

The handler verifies the signature over the raw body, locks the user and the purchase, rechecks that the status is still pending, posts the ledger transaction with a key derived from the provider session, and marks the purchase paid and writes the entitlement in the same transaction. A replay finds the status no longer pending and returns 200 without touching the ledger.

### The security surface of a static front end

A static front end on one host, an API on another, an admin portal on a third and a public API reachable from anywhere is a combination where the default configuration is wrong. The rewrite replaced client-side admin checks with a role guard, then added an origin guard on every admin route: an `Origin` header equal to the configured admin origin, on reads as well as writes, failing closed.

Sessions became opaque tokens in Redis with a version counter on the user row, so a block or a logout invalidates every device. That created a problem the first generation never had: two tabs, one of which logged out and back in as another account. Content and payment mutations now carry the user id the client believes it has, and a mismatch is a conflict.

The origin header is not a secret. The guard is defence in depth; the real controls are the session, the role and the audit log.

### Migrating without a provenance chain

The rebuild started empty with a rule: nothing from the historical code enters the active path until its origin, commit, hash, classification and reuse reason are recorded. The foundation was 24 files and 15 commits of governance and directory boundaries, and its main output was a matrix of components labelled confirmed, partial or unproven. The front ends came out unproven, so the visual work was rebuilt against a fixed target; the backend functions came out partial, so they were rewritten with the same behaviour and a different shape. It converted "we think this is what it does" into claims with evidence.

## What changed along the way

Two approaches were abandoned mid-flight. The balance check moved from the application to the database after a concurrency test, not after a review. Paid access was a boolean until the first renewal: a boolean cannot answer until when, cannot be audited against a payment, and cannot represent two grants that overlap, so it became an entitlement row with a source and a period. The test strategy changed too: early tests mocked the database and passed while the constraints were wrong, so the suites that matter run against real PostgreSQL and Redis and assert a constraint by violating it.

## What I would do differently

Start with the ledger and the reconciliation CLI before any product feature, including authentication. The ledger is what every module depends on, and building it later meant rewriting account code grown around a simpler assumption.

Write the purchase state machine as a table of states, events and effects before the handler; the transitions were discovered while coding them, which cost time. Model the entitlement before the first premium screen, not after the first complaint about a plan that expired early.

Timebox the provenance work and decide in advance which components are worth proving. Proving the front ends was right, but the investigation ran past the value it returned. And do not ship a product as one HTML file: it was cheap to deploy and expensive to leave.

## What this repository does not contain

The commercial layer is omitted as a whole: the plan catalogue and its prices, the entitlement rules that decide what each plan unlocks, the creator share calculation, the moderation policy text and the limit values. That is the part with the most direct incentive to be copied without the controls around it, and a partially redacted rule set is still a rule set. What remains is the engineering that made those rules safe to run: how money is recorded, how a payment becomes access, and how a session is trusted.
