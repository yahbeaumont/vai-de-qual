# Decisions

Seven records. Each one is a decision that shaped the current generation, written after the fact, with the alternatives that were actually on the table. Dates are the phase in which the decision was taken, not the date of writing.

---

## ADR-001: A double-entry ledger with a materialised balance

**Phase:** November 2026, first weeks of the rewrite.

**Context.** The community product had no wallet. Paid access was a flag on a user record, so there was no balance to protect and no history to reconstruct. The betting platform introduces a balance that can be spent, and with it the question of where the invariant lives.

**Decision.** Every movement of money is a transaction composed of at least two entries on distinct accounts, whose signed amounts sum to zero. Accounts follow a chart of four classes (assets, liabilities, revenue, expenses) with subaccounts by code prefix. One function posts transactions: it validates the entry set, updates the stored balance of each account in the same database transaction, and appends the entries. Player wallets are liability accounts whose balance is the negative of the player's available funds, which keeps the sign convention consistent across the chart. The stored balance is therefore a projection of the journal, maintained at write time, and a reconciliation job recomputes the projection from entries to detect drift.

**Alternatives considered.** A single `balance` column with an append-only audit table was rejected because the audit table would be a log, not a record: nothing would force it to agree with the balance. Deriving the balance from entries on every read was rejected because the hot path is a bet, and an aggregate over a growing journal would sit inside the transaction that holds the user lock. Event sourcing the whole wallet was rejected as a larger change than the product needed.

**Consequences.** Reads are a single row lookup, and the invariant has one enforcement point. The cost is a duplicated fact: the balance and the journal can disagree if something writes the balance outside the posting function, so the reconciliation job is mandatory rather than optional, and it reports rather than repairs. Adding a new kind of movement means choosing accounts and a key prefix, not writing new balance arithmetic, which is the part that made the decision pay off during the game work.

---

## ADR-002: Put the balance invariant in the database, not only in the application

**Phase:** November 2026, during the ledger milestone.

**Context.** A check in application code protects the paths that remember to call it. The wallet had already produced a class of bugs where a code path debited a stake without rechecking the balance, and the failure mode was a negative available balance that only surfaced later. With one posting function the risk narrows but does not disappear: a new game module, a migration script or a manual adjustment can still construct a posting that overdraws a player.

**Decision.** The invariant lives in PostgreSQL. Player wallet accounts carry a flag, and a `CHECK` constraint requires that a flagged account never holds a positive balance, given the sign convention in ADR-001. Any posting that would overdraw a player fails at the constraint. The posting function recognises SQLSTATE `23514` on those constraints, including when the driver wraps it in a nested error, and translates it into an insufficient funds error that the HTTP layer maps to a 422. Nothing is clamped, no balance is nudged, and the transaction rolls back as a whole. A second constraint does the same for the bonus subaccount. Round state and board shape have constraints for the same reason: illegal combinations cannot be persisted even by a buggy writer.

**Alternatives considered.** Checking the balance inside the posting function with a `SELECT` before the update was rejected because it reintroduces the read-then-write race unless the read is a lock, and because it protects only the callers of that function. A trigger was rejected as harder to review and easier to disable than a constraint. Relying on a nightly reconciliation to catch overdrafts was rejected outright: reconciliation is a detector, not a control.

**Consequences.** The error path is less obvious: a constraint violation arrives as a driver error and has to be mapped carefully, or it surfaces as a 500. The payoff is that the invariant holds for every writer, including migrations and one-off scripts, and that the test suite can assert it by attempting an overdraft rather than by mocking a service. It also makes the sign convention load bearing, so it is documented in one place and asserted at read time: the wallet endpoint refuses to serve a balance whose sign is wrong instead of returning a negative number.

---

## ADR-003: Only a verified webhook credits a deposit

**Phase:** November 2026, payments milestone.

**Context.** The payment provider redirects the browser back to the application with a session identifier in the URL. That redirect is the most convenient signal available and the least trustworthy: it can be replayed, forged, triggered without payment, or lost when the player closes the tab. The product had already been designed with a hosted checkout, so the money is collected outside the application and the only authoritative signal is a signed event.

**Decision.** The deposit lifecycle is a state machine: pending, paid, failed, expired. A deposit is created and committed before the checkout session is requested, so the local record always exists first. The request requires an `Idempotency-Key` header, stored under a unique index; the same key with the same payload returns the original deposit, the same key with a different payload returns 409, and a duplicate-key race is resolved by reading the row back, with a lookup miss treated as a retryable error rather than a success. The only transition to paid happens in the webhook handler, after an HMAC signature check over the raw request body, and only when the stored deposit is still pending and the provider reports the session as paid. The handler locks the user and the deposit, posts the ledger transaction with a key derived from the provider session id, and marks the deposit paid in the same transaction. A completed session with an unpaid status stays pending, because Pix confirmation can arrive later.

**Alternatives considered.** Crediting on the redirect and reconciling later was rejected because it makes the client the source of truth for money. Polling the provider from the API on a timer was rejected because it duplicates the provider's retry machinery and adds a scheduler to a system that otherwise has none. Crediting on any event that mentions the session was rejected because event types differ in meaning and some arrive before settlement.

**Consequences.** Deposits stay pending until an event arrives, so a webhook that is never delivered leaves money in limbo until reconciliation, and the endpoint must be public and correctly configured per environment. Replays are cheap: the ledger key absorbs them, and the status check makes a second transition a no-op. The failure modes are visible in the deposit row rather than in a balance, which is what makes support conversations tractable.

---

## ADR-004: Treat the checkout window and the Pix window as two clocks

**Phase:** November 2026, payments milestone.

**Context.** The provider exposes two expiries that look similar and are not. The checkout session has an expiry set when it is created. The Pix charge has its own expiry, counted from the moment the payment intent is confirmed, which happens after the player opens the payment page. A single "expires at" value in the application would be wrong for one of them, and a single expiry event would silently mislabel deposits.

**Decision.** Both clocks are set explicitly and independently, each to 30 minutes, and the API stores the checkout session expiry as the value it returns to the client. The Pix expiry is configured on the payment method options rather than derived. The state machine has separate transitions for a completed payment, a failed payment and an expired session, and the expired transition never credits. The front end shows the session expiry because that is the window the player is actually inside.

**Alternatives considered.** A single expiry computed as the earlier of the two was rejected because it would expire deposits whose Pix charge is still payable, and because the application cannot observe the Pix clock directly. Extending the checkout window to the maximum allowed and ignoring the Pix window was rejected because it would show players a countdown that does not match the charge they are paying.

**Consequences.** Two values to store, two transitions to test, and a documentation burden that this record exists to carry. In exchange, the expiry semantics match the provider instead of approximating it, and the reconciliation query can distinguish a session that expired from a charge that failed, which matters when a player claims they paid inside the window.

---

## ADR-005: An exact Origin allowlist for the administrative surface

**Phase:** November 2026, backoffice milestone.

**Context.** The admin portal is a static build on its own hostname, the API is on another, and the session cookie is sent with credentials. The first generation checked the admin role in the browser, which is not a boundary. Even with a server-side role guard, a valid admin cookie can be used from a page on another origin if the API accepts cross-origin requests from anywhere, and the risk is asymmetric: a player losing a bet is a support ticket, an operator session being driven by a third-party page is an incident.

**Decision.** Two independent controls. CORS uses an exact allowlist of origins with credentials enabled, never a wildcard and never a suffix match, so only the configured front ends can read responses. On top of that, every admin controller requires an `Origin` header that equals the configured admin origin exactly, on reads as well as writes, so a request forged from another origin is rejected even when it carries a valid session. The comparison is against configuration, not against a request header echo, and a missing header is a rejection rather than a pass. The admin role guard runs as well; the origin guard is additional, not a replacement.

**Alternatives considered.** Relying on `SameSite=Strict` for the admin cookie was rejected because it would break the intended navigation from the player site and because cookie attributes are a browser policy, not an authorisation decision. A CSRF token per admin form was considered and kept as a future addition, but the origin check covers the same class of attack with less state and also applies to GET. Checking only on writes was rejected: admin reads expose user and ledger data.

**Consequences.** The origin header is a browser convention, not a secret, so a non-browser client can send any value it likes. The guard therefore assumes the browser enforces origin on cross-site requests and does not defend against a client that lies; that is why the role guard, the session version and the audit log remain in place. Operationally, preview deployments and alternative hostnames need explicit configuration, and a misconfigured admin origin fails closed with a 403 rather than degrading quietly.

---

## ADR-006: Split the monolith into modules around one money path

**Phase:** November 2026, start of the rewrite.

**Context.** The community product was one HTML file per surface with the rules inline, and Cloud Functions that each did their own persistence. The transactional platform had to be built with visible boundaries: authentication, wallet, payments, withdrawals, games, backoffice. The risk of a module split is cosmetic modularity, where directories change and coupling does not.

**Decision.** The API is split by feature, with one module per game and shared modules for the ledger, wallet, payments and auth. The rule that makes the split real is that money has exactly one path: no module writes a balance, and every movement goes through the ledger service with a key and a kind. Game modules own their randomness, rules and persistence but call the same posting function inside their own transaction. Guards are global where the rule is global (session) and local where the rule is local (admin role, admin origin, internal key). The ledger module has no dependency on payments or games, which is what allows the reconciliation CLI to be a plain entry point.

**Alternatives considered.** A layered split (controllers, services, repositories) was rejected because it groups by technical role and leaves the money path spread across layers. Keeping the games in one module with a `game` discriminator was rejected after the first two games, when the branching started to appear in settlement code. A separate service per bounded context (payments as its own deployable) was rejected as operational overhead the team could not carry at this size.

**Consequences.** More files, more module wiring, and a real risk of circular imports between games and the wallet, which is why the ledger sits below both. The benefit shows in tests: the ledger suite runs against the database without a game, the game suites run without payments, and the payment suite exercises the webhook with a signed payload. It also gives each game its own rate limits and constants, which the product needed because the games fail differently.

---

## ADR-007: Rebuild from provenance instead of copying forward

**Phase:** September to November 2026, rebuild foundation.

**Context.** The community product's deployed bundles could not be mapped back to a commit with confidence. Files had been edited in place, copied between branches and served from a hosting rewrite that pointed at an older artifact. In a regulated domain, "this rule came from somewhere" is not an acceptable answer, and a rewrite that copies unverified code inherits the same uncertainty with a new timestamp.

**Decision.** The rebuild repository started nearly empty: 24 files and 15 commits of governance, directory boundaries and reuse rules before any feature code. Every candidate file from the historical repository had to record its origin, commit, hash, classification and reuse reason before entering the active path. Anything that could not be established stayed labelled unproven and outside the path. The historical repository was preserved untouched as a reference, and the visual target was fixed so that a rewrite could not drift into a redesign. The current generation was then written against those boundaries, with the ledger and the payment flow designed first.

**Alternatives considered.** Continuing on the historical repository with a cleanup branch was rejected because the deployed artifact could not be tied to a commit, so cleanup would not fix the provenance problem. Copying the HTML and refactoring in place was rejected for the same reason plus the size of the file. A full greenfield rewrite with no reference was rejected because the product's behaviour, including its edge cases, was the specification.

**Consequences.** Weeks of work before the first feature, and code that had to be rewritten rather than reused, including rules that probably worked. The foundation also created documentation that has to be maintained and a governance process that slows small changes. What it bought is a codebase where each rule has an owner, a phase and a test, which is the property that made the later ledger and security work possible to review.
