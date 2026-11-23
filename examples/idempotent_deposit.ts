// idempotent_deposit.ts
// A deposit state machine with a mandatory idempotency key, a local record that
// exists before the provider call, and credit only from a signature-verified
// event. No dependencies, no database: the stores are in memory on purpose.
// Run: node --experimental-strip-types idempotent_deposit.ts

import { createHmac, timingSafeEqual } from 'node:crypto';

type Status = 'pending' | 'paid' | 'expired' | 'failed';
type Deposit = { id: string; key: string; amountCents: number; sessionId: string | null; status: Status };
type Event = { type: string; depositId: string; sessionPaid: boolean };
const WEBHOOK_SECRET = 'demo-secret-not-a-real-credential';
const depositsByKey = new Map<string, Deposit>();
const balances = new Map<string, number>();
const postedKeys = new Set<string>();

// One posting path. A replay of the same key changes nothing.
function postJournal(key: string, entries: Array<[string, number]>): void {
  if (postedKeys.has(key)) return;
  const sum = entries.reduce((total, [, amount]) => total + amount, 0);
  if (entries.length < 2 || sum !== 0) throw new Error('posting must have two entries and sum to zero');
  for (const [account, amount] of entries) {
    balances.set(account, (balances.get(account) ?? 0) + amount);
  }
  postedKeys.add(key);
}

function createDeposit(rawKey: string | undefined, amountCents: number): Deposit {
  if (rawKey === undefined || rawKey.length === 0) throw new Error('400 Idempotency-Key is required');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('400 invalid amount');

  const existing = depositsByKey.get(rawKey);
  if (existing !== undefined) {
    if (existing.amountCents !== amountCents) throw new Error('409 key reused with another payload');
    return existing; // same key, same payload: replay the original response
  }

  const deposit: Deposit = { id: `dep_${depositsByKey.size + 1}`, key: rawKey, amountCents, sessionId: null, status: 'pending' };
  depositsByKey.set(rawKey, deposit);
  // The provider call comes after the record exists, so a timeout cannot orphan a session.
  deposit.sessionId = `cs_demo_${deposit.id}`;
  return deposit;
}
function sign(rawBody: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

function handleWebhook(rawBody: string, signature: string | undefined): string {
  if (signature === undefined) return '400 missing signature';
  const expected = Buffer.from(sign(rawBody));
  const supplied = Buffer.from(signature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return '400 invalid signature';
  }

  const event = JSON.parse(rawBody) as Event;
  const deposit = [...depositsByKey.values()].find((candidate) => candidate.id === event.depositId);
  if (deposit === undefined) return '200 ignored: unknown deposit';
  if (deposit.status !== 'pending') return '200 ignored: already terminal';

  if (event.type === 'session.completed' && event.sessionPaid) {
    postJournal(`dep:${deposit.sessionId}`, [
      ['1000.cash', deposit.amountCents],
      [`2000.wallet.${deposit.id}`, -deposit.amountCents],
    ]);
    deposit.status = 'paid';
    return '200 credited';
  }
  if (event.type === 'session.completed') return '200 still pending: not paid yet';
  if (event.type === 'session.expired') {
    deposit.status = 'expired';
    return '200 expired: no credit';
  }
  return '200 ignored';
}

// Demo: replay, conflict, forged signature, valid event, duplicate event.
const deposit = createDeposit('demo-key-1', 10_000);
console.log('replay returns the original:', createDeposit('demo-key-1', 10_000).id === deposit.id);
try {
  createDeposit('demo-key-1', 20_000);
} catch (error) {
  console.log('conflict:', (error as Error).message);
}

const body = JSON.stringify({ type: 'session.completed', depositId: deposit.id, sessionPaid: true });
console.log('forged:', handleWebhook(body, 'deadbeef'));
console.log('valid:', handleWebhook(body, sign(body)));
console.log('duplicate:', handleWebhook(body, sign(body)));
console.log('wallet:', balances.get(`2000.wallet.${deposit.id}`), 'cash:', balances.get('1000.cash'));
