// idempotent_payment.ts
// A purchase state machine for a paid plan or a credit pack: a mandatory
// idempotency key, a local record that exists before the provider call, and a
// confirmation that only a signature-verified event can produce.
// No dependencies, no database: the stores are in memory on purpose.
// Run: node --experimental-strip-types idempotent_payment.ts

import { createHmac, timingSafeEqual } from 'node:crypto';

type Status = 'pending' | 'paid' | 'expired' | 'failed';
type Kind = 'plan' | 'credits';
type Purchase = { id: string; key: string; kind: Kind; amountCents: number; sessionId: string | null; status: Status };
type Event = { type: string; purchaseId: string; sessionPaid: boolean };
const WEBHOOK_SECRET = 'demo-secret-not-a-real-credential';
const purchasesByKey = new Map<string, Purchase>();
const balances = new Map<string, number>();
const postedKeys = new Set<string>();
const access = new Map<string, Kind>();

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

function createPurchase(rawKey: string | undefined, kind: Kind, amountCents: number): Purchase {
  if (rawKey === undefined || rawKey.length === 0) throw new Error('400 Idempotency-Key is required');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('400 invalid amount');

  const existing = purchasesByKey.get(rawKey);
  if (existing !== undefined) {
    if (existing.amountCents !== amountCents || existing.kind !== kind) {
      throw new Error('409 key reused with another payload');
    }
    return existing; // same key, same payload: replay the original response
  }

  const purchase: Purchase = {
    id: `pur_${purchasesByKey.size + 1}`,
    key: rawKey,
    kind,
    amountCents,
    sessionId: null,
    status: 'pending',
  };
  purchasesByKey.set(rawKey, purchase);
  // The provider call comes after the record exists, so a timeout cannot orphan a session.
  purchase.sessionId = `cs_demo_${purchase.id}`;
  return purchase;
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
  const purchase = [...purchasesByKey.values()].find((candidate) => candidate.id === event.purchaseId);
  if (purchase === undefined) return '200 ignored: unknown purchase';
  if (purchase.status !== 'pending') return '200 ignored: already terminal';

  if (event.type === 'checkout.completed' && event.sessionPaid) {
    // Cash in, and the same amount owed back to the buyer: deferred revenue for a
    // plan period, a spendable credit balance for a pack. The entitlement row is
    // written in this same transaction, so access and payment cannot disagree.
    const owed = purchase.kind === 'plan' ? `3000.deferred.${purchase.id}` : `2000.credit.${purchase.id}`;
    postJournal(`pay:${purchase.sessionId}`, [
      ['1000.cash', purchase.amountCents],
      [owed, -purchase.amountCents],
    ]);
    purchase.status = 'paid';
    access.set(purchase.id, purchase.kind);
    return '200 confirmed';
  }
  if (event.type === 'checkout.completed') return '200 still pending: not paid yet';
  if (event.type === 'checkout.expired') {
    purchase.status = 'expired';
    return '200 expired: no access';
  }
  return '200 ignored';
}

// Demo: replay, conflict, forged signature, valid event, duplicate event, then a
// second purchase of the other kind to show that only the account pair changes.
const plan = createPurchase('demo-key-1', 'plan', 10_000);
console.log('replay returns the original:', createPurchase('demo-key-1', 'plan', 10_000).id === plan.id);
try {
  createPurchase('demo-key-1', 'plan', 20_000);
} catch (error) {
  console.log('conflict:', (error as Error).message);
}

const body = JSON.stringify({ type: 'checkout.completed', purchaseId: plan.id, sessionPaid: true });
console.log('forged:', handleWebhook(body, 'deadbeef'));
console.log('valid:', handleWebhook(body, sign(body)));
console.log('duplicate:', handleWebhook(body, sign(body)));

const pack = createPurchase('demo-key-2', 'credits', 2_500);
const packBody = JSON.stringify({ type: 'checkout.completed', purchaseId: pack.id, sessionPaid: true });
console.log('credits:', handleWebhook(packBody, sign(packBody)));

console.log('plan access:', access.get(plan.id), 'pack access:', access.get(pack.id));
console.log(
  'deferred:',
  balances.get(`3000.deferred.${plan.id}`),
  'credit:',
  balances.get(`2000.credit.${pack.id}`),
  'cash:',
  balances.get('1000.cash'),
);
