# Decisions

Seven records. Each one is a decision that shaped the current generation, written after the fact, with the alternatives that were actually on the table. Dates are the phase in which the decision was taken, not the date of writing.

---

## ADR-001: A double-entry ledger with a materialised balance

**Phase:** November 2026, first weeks of the rewrite.

**Context.** The community product had no balance. Paid access was a boolean on a user record, so there was no balance to protect and no history to reconstruct. The second generation sells plans, sells credits and pays creators, which introduces money that arrives before the content is consumed and money that leaves to somebody else, and with it the question of where the invariant lives.

**Decision.** Every movement of money is a transaction composed of at least two entries on distinct accounts, whose signed amounts sum to zero. Accounts follow a chart of four classes (assets, liabilities, revenue, expenses) with subaccounts by code prefix. One function posts transactions: it validates the entry set, updates the stored balance of each account in the same database transaction, and appends the entries. A user credit account is a liability whose balance is the negative of what the user can spend, which keeps the sign convention consistent across the chart, and a creator payable account follows the same convention for what the platform owes. The stored balance is therefore a projection of the journal, maintained at write time, and a reconciliation job recomputes the projection from entries to detect drift.

**Alternatives considered.** A single `balance` column with an append-only audit table was rejected because the audit table would be a log, not a record: nothing would force it to agree with the balance. Deriving the balance from entries on every read was rejected because the hot path is a premium read or a credit redemption, and an aggregate over a growing journal would sit inside the transaction that holds the user lock. Event sourcing the whole account was rejected as a larger change than the product needed.

**Consequences.** Reads are a single row lookup, and the invariant has one enforcement point. The cost is a duplicated fact: the balance and the journal can disagree if something writes the balance outside the posting function, so the reconciliation job is mandatory rather than optional, and it reports rather than repairs. Adding a new kind of movement means choosing accounts and a key prefix, not writing new balance arithmetic, which is the part that paid off when creator payouts arrived a few weeks later.

---

## ADR-002: Put the balance invariant in the database, not only in the application

**Phase:** November 2026, during the ledger milestone.

**Context.** A check in application code protects the paths that remember to call it. The credit layer had already produced a class of bugs where a path redeemed credits without rechecking the balance, and the failure mode was a credit account that the platform owed more on than it had collected, visible only in a statement nobody was reading. With one posting function the risk narrows but does not disappear: a new module, a migration script or a manual adjustment can still construct a posting that overdraws an account.

**Decision.** The invariant lives in PostgreSQL. Credit accounts carry a flag, and a `CHECK` constraint requires that a flagged account never holds a positive balance, given the sign convention in ADR-001. Any posting that would overdraw a user fails at the constraint. The posting function recognises SQLSTATE `23514` on those constraints, including when the driver wraps it in a nested error, and translates it into an insufficient funds error that the HTTP layer maps to a 422. Nothing is clamped, no balance is nudged, and the transaction rolls back as a whole. A second constraint applies the same rule to creator payable accounts, so a payout larger than what a creator has earned cannot be persisted either. Entitlement periods and purchase states have constraints for the same reason: illegal combinations cannot be persisted even by a buggy writer.

**Alternatives considered.** Checking the balance inside the posting function with a `SELECT` before the update was rejected because it reintroduces the read-then-write race unless the read is a lock, and because it protects only the callers of that function. A trigger was rejected as harder to review and easier to disable than a constraint. Relying on a nightly reconciliation to catch overdrafts was rejected outright: reconciliation is a detector, not a control.

**Consequences.** The error path is less obvious: a constraint violation arrives as a driver error and has to be mapped carefully, or it surfaces as a 500. The payoff is that the invariant holds for every writer, including migrations and one-off scripts, and that the test suite can assert it by attempting an overdraw rather than by mocking a service. It also makes the sign convention load bearing, so it is documented in one place and asserted at read time: the account endpoint refuses to serve a balance whose sign is wrong instead of returning a negative number to the interface.

---

## ADR-003: Only a verified webhook activates a paid plan

**Phase:** November 2026, payments milestone.

**Context.** The payment provider redirects the browser back to the application with a session identifier in the URL. That redirect is the most convenient signal available and the least trustworthy: it can be replayed, forged, triggered without payment, or lost when the buyer closes the tab. The product had already been designed with a hosted checkout, so the money is collected outside the application and the only authoritative signal is a signed event.

**Decision.** The purchase lifecycle is a state machine: pending, paid, failed, expired. A purchase is created and committed before the checkout session is requested, so the local record always exists first. The request requires an `Idempotency-Key` header, stored under a unique index; the same key with the same payload returns the original purchase, the same key with a different payload returns 409, and a duplicate-key race is resolved by reading the row back, with a lookup miss treated as a retryable error rather than a success. The only transition to paid happens in the webhook handler, after an HMAC signature check over the raw request body, and only when the stored purchase is still pending and the provider reports the session as paid. The handler locks the user and the purchase, posts the ledger transaction with a key derived from the provider session id, and marks the purchase paid and writes the entitlement in the same transaction. A purchase is therefore never paid without the access it bought, and access is never granted without a payment. A completed session with an unpaid status stays pending, because a delayed confirmation can still arrive.

**Alternatives considered.** Granting access on the redirect and reconciling later was rejected because it makes the client the source of truth for money. Polling the provider from the API on a timer was rejected because it duplicates the provider's retry machinery and adds a scheduler to a system that otherwise has none. Acting on any event that mentions the session was rejected because event types differ in meaning and some arrive before settlement.

**Consequences.** Purchases stay pending until an event arrives, so a webhook that is never delivered leaves a buyer without access until reconciliation, and the endpoint must be public and correctly configured per environment. Replays are cheap: the ledger key absorbs them, and the status check makes a second transition a no-op. The failure modes are visible in the purchase row rather than in a balance, which is what makes a support conversation about a missing plan tractable.

---

## ADR-004: Model access as an entitlement with a period, not a flag

**Phase:** November 2026, plans milestone.

**Context.** The first generation stored paid access as a boolean on the user record. That was enough while there was one product and no renewal. With several plans, renewals, upgrades, expiry, manual grants and single items bought with credits, the boolean cannot answer the questions the product asks every day: since when, until when, which plan, who granted it, and what happened to the access that expired last week. It also cannot be reconciled against payments, because a boolean has no amount and no date to compare with a ledger entry.

**Decision.** Access is a row. An entitlement records its source (a plan purchase, a credit pack or a manual grant), the plan it refers to, a start, an end and a status. Every premium read asks the entitlement service, which reads those rows and the credit balance and answers with a decision and a reason. Expiry is a property of the row, evaluated when it is read, not a job that has to run: a scheduled job that flips flags is a job that can fail silently and leave paid content open. The entitlement is written in the same transaction as the purchase confirmation, so a payment cannot exist without its access, and a manual grant is an audited administrative action instead of a database edit. Credits stay outside this model: a credit balance is a ledger account, and redeeming a credit is a posting that recognises revenue for the item it unlocks.

**Alternatives considered.** Keeping the boolean and adding a renewal date was rejected because it loses the history and cannot represent two overlapping grants, which is exactly what an upgrade produces. A single `plan` column on the user was rejected for the same reason plus the impossibility of auditing who changed it. A scheduled expiry job was rejected because its failure mode is free access, and because the read path can evaluate a date without any background process. Treating credits as entitlements was rejected because a credit is money owed, and money owed belongs in the ledger.

**Consequences.** More rows, one join on the premium read path, and every access decision routed through one service, which is the point. The support question "why does this account have access" now has an answer with a source and a date. The cost is that expired rows accumulate and need an archival policy, and that the entitlement service becomes a dependency of almost every content module, so it is kept small and free of product rules.

---

## ADR-005: An exact Origin allowlist for the administrative surface

**Phase:** November 2026, backoffice milestone.

**Context.** The admin portal is a static build on its own hostname, the API is on another, and the session cookie is sent with credentials. The first generation checked the admin role in the browser, which is not a boundary. Even with a server-side role guard, a valid admin cookie can be used from a page on another origin if the API accepts cross-origin requests from anywhere, and the risk is asymmetric: a reader losing access to a post is a support ticket, an operator session being driven by a third-party page is an incident.

**Decision.** Two independent controls. CORS uses an exact allowlist of origins with credentials enabled, never a wildcard and never a suffix match, so only the configured front ends can read responses. On top of that, every admin controller requires an `Origin` header that equals the configured admin origin exactly, on reads as well as writes, so a request forged from another origin is rejected even when it carries a valid session. The comparison is against configuration, not against a request header echo, and a missing header is a rejection rather than a pass. The admin role guard runs as well; the origin guard is additional, not a replacement.

**Alternatives considered.** Relying on `SameSite=Strict` for the admin cookie was rejected because it would break the intended navigation from the community site and because cookie attributes are a browser policy, not an authorisation decision. A CSRF token per admin form was considered and kept as a future addition, but the origin check covers the same class of attack with less state and also applies to GET. Checking only on writes was rejected: admin reads expose account data, purchase history and ledger statements.

**Consequences.** The origin header is a browser convention, not a secret, so a non-browser client can send any value it likes. The guard therefore assumes the browser enforces origin on cross-site requests and does not defend against a client that lies; that is why the role guard, the session version and the audit log remain in place. Operationally, preview deployments and alternative hostnames need explicit configuration, and a misconfigured admin origin fails closed with a 403 rather than degrading quietly.

---

## ADR-006: Split the monolith into modules around one money path

**Phase:** November 2026, start of the rewrite.

**Context.** The community product was one HTML file per surface with the rules inline, and Cloud Functions that each did their own persistence. The second generation had to be built with visible boundaries: authentication, profiles and the social graph, content and moderation, plans and payments, credits, creator payouts, administration. The risk of a module split is cosmetic modularity, where directories change and coupling does not.

**Decision.** The API is split by feature, with the ledger and the entitlement service below the feature modules. The rule that makes the split real is that money has exactly one path: no module writes a balance, and every movement goes through the ledger service with a key and a kind. The payouts module owns the batch, the approval and the statement, and it posts through that same function inside its own transaction instead of editing a balance. Guards are global where the rule is global (session) and local where the rule is local (admin role, admin origin). The ledger module has no dependency on payments, content or payouts, which is what allows the reconciliation CLI to be a plain entry point, and the social graph module has no dependency on the ledger at all, which keeps the feed read path cheap.

**Alternatives considered.** A layered split (controllers, services, repositories) was rejected because it groups by technical role and leaves the money path spread across layers. One content module with a `type` discriminator was rejected once premium posts, comments and saved items started to need different moderation and access rules, because the branching appeared in the read path. A separate service per bounded context (payments as its own deployable) was rejected as operational overhead the team could not carry at this size.

**Consequences.** More files, more module wiring, and a real risk of circular imports around the entitlement service, which is why it sits below content and above nothing. The benefit shows in tests: the ledger suite runs against the database without a purchase, the content suite runs without payments, and the payment suite exercises the webhook with a signed payload. It also gives each surface its own rate limits and constants, which the product needed because publishing, commenting and checkout fail differently.

---

## ADR-007: Rebuild from provenance instead of copying forward

**Phase:** September to November 2026, rebuild foundation.

**Context.** The community product's deployed bundles could not be mapped back to a commit with confidence. Files had been edited in place, copied from one branch to another and served from a hosting rewrite that pointed at an older artifact. In a product where a rule decides whether a payment grants access to content, "this rule came from somewhere" is not an acceptable answer, and a rewrite that copies unverified code inherits the same uncertainty with a new timestamp.

**Decision.** The rebuild repository started nearly empty: 24 files and 15 commits of governance, directory boundaries and reuse rules before any feature code. Every candidate file from the historical repository had to record its origin, commit, hash, classification and reuse reason before entering the active path. Anything that could not be established stayed labelled unproven and outside the path. The historical repository was preserved untouched as a reference, and the visual target was fixed so that a rewrite could not drift into a redesign. The current generation was then written against those boundaries, with the ledger, the entitlement model, the payment flow and the payout path designed first.

**Alternatives considered.** Continuing on the historical repository with a cleanup branch was rejected because the deployed artifact could not be tied to a commit, so cleanup would not fix the provenance problem. Copying the HTML and refactoring in place was rejected for the same reason plus the size of the file. A full greenfield rewrite with no reference was rejected because the product's behaviour, including its edge cases, was the specification.

**Consequences.** Weeks of work before the first feature, and code that had to be rewritten rather than reused, including rules that probably worked. The foundation also created documentation that has to be maintained and a governance process that slows small changes. What it bought is a codebase where each rule has an owner, a phase and a test, which is the property that made the later ledger and security work possible to review.
