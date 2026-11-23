# Examples

Three small files, written from scratch for this repository. They illustrate techniques used in the product, not the product's implementation: the table and function names, the account codes, the event names and the secret are generic, and none of the product's business rules appear here. Each file runs on its own.

| File | Shows | Needs |
|---|---|---|
| `double_entry_posting.sql` | Atomic double-entry posting with a materialised balance, a zero-sum check, idempotency by key, and an overdraft refused by a `CHECK` constraint | PostgreSQL 14 or newer |
| `idempotent_deposit.ts` | A deposit state machine with a mandatory idempotency key and credit only from a signature-verified event | Node.js 22 or newer, no dependencies |
| `origin_guard.ts` | An exact `Origin` allowlist for a sensitive route, applied to reads and writes | Node.js 22 or newer, no dependencies |

## double_entry_posting.sql

Creates a scratch schema with three tables: `account` (with a materialised `balance_cents`), `posting` (one row per transaction, with a unique idempotency key) and `entry` (signed amounts per account). The `post_journal` function rejects an entry set that is smaller than two accounts or does not sum to zero, inserts the posting header with `on conflict do nothing` so a replay returns the original id, and then updates each balance and appends its entries in account-code order.

The demo posts a deposit, replays the same key (same posting id, no new entries), and then attempts a withdrawal larger than the balance. That last call fails on the `wallet_balance_non_positive` constraint with SQLSTATE `23514`, which is the error a client maps to "insufficient funds". Nothing is clamped and the failed statement leaves no partial state.

Run it against a disposable database:

```
createdb ledger_demo
psql -v ON_ERROR_STOP=1 -d ledger_demo -f double_entry_posting.sql
```

The script drops its schema at the end, so it can run again.

## idempotent_deposit.ts

Models a deposit as a state machine (`pending`, `paid`, `expired`, `failed`) with an in-memory store standing in for the database. Three behaviours are the point of the file. The idempotency key is mandatory, and a repeat with the same key and amount returns the original record, while a repeat with a different amount is a conflict. The record is created before the provider session id is attached, which is the ordering that prevents an orphan session when the provider call times out. Credit happens only inside `handleWebhook`, after an HMAC comparison over the raw body with `timingSafeEqual`, and only when the deposit is still pending; the second delivery of the same event finds a terminal state and returns 200 without posting.

The ledger is a `Map` plus a set of posted keys, enough to show that the second delivery changes no balance.

```
node --experimental-strip-types idempotent_deposit.ts
```

Expected output: the replay returns the original id, the conflicting request is refused, the forged signature is refused, the valid event credits once, the duplicate event is ignored, and the final balances are the cash account at `10000` and the wallet at `-10000` under the sign convention where a credit to a customer is negative.

## origin_guard.ts

Implements the check applied to administrative routes. The allowlist is a set of canonical origins, and the comparison is exact: a trailing slash, a different scheme, a subdomain, a lookalike host and the opaque `null` origin are all rejected. A missing header is rejected too, so the guard fails closed.

The file prints nine cases, two allowed and seven rejected. It is deliberately not a CSRF token and not an authentication factor: any non-browser client can send whatever `Origin` it likes. In the product this check runs after the session guard and the role guard, and its value is that a page on another origin cannot drive the backoffice with a stolen cookie.

```
node --experimental-strip-types origin_guard.ts
```

## Notes

The TypeScript files use type annotations only, with no enums, decorators or path aliases, so Node can strip the types without a compiler. With an older Node, compile them with `tsc` or run them through `tsx`. Nothing here reads environment variables, writes files or opens a socket.
