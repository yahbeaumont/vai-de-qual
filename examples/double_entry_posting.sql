-- double_entry_posting.sql
-- Atomic double-entry posting: zero-sum check, materialised balance, idempotency
-- by key, overdraw rejected by a CHECK constraint. PostgreSQL 14+.
-- Run: psql -v ON_ERROR_STOP=1 -f double_entry_posting.sql
create schema if not exists ledger_demo;
set search_path to ledger_demo;
drop table if exists entry, posting, account cascade;

create table account (
  id            bigserial primary key,
  code          text      not null unique,
  kind          text      not null check (kind in ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE')),
  is_credit     boolean   not null default false,
  balance_cents bigint    not null default 0,
  -- A customer credit account is a liability stored as the negative of what the
  -- customer can spend, so its balance can never be positive.
  constraint credit_balance_non_positive check (not is_credit or balance_cents <= 0)
);
create table posting (
  id         bigserial primary key,
  idem_key   text        not null unique,
  kind     text not null
);
create table entry (
  id           bigserial primary key,
  posting_id   bigint not null references posting (id) on delete cascade,
  account_id   bigint not null references account (id),
  amount_cents bigint not null check (amount_cents <> 0)
);
create function post_journal(p_key text, p_kind text, p_accounts text[], p_amounts bigint[])
returns bigint language plpgsql as $$
declare
  v_total      bigint := 0;
  v_count      int    := coalesce(array_length(p_accounts, 1), 0);
  v_id         bigint;
  v_account_id bigint;
  v_amount     bigint;
begin
  if v_count < 2 or v_count <> coalesce(array_length(p_amounts, 1), 0) then
    raise exception 'a posting needs two or more accounts and matching arrays';
  end if;
  for i in 1 .. v_count loop
    if p_amounts[i] = 0 then raise exception 'zero amounts are not allowed'; end if;
    v_total := v_total + p_amounts[i];
  end loop;
  if v_total <> 0 then raise exception 'posting does not balance: %', v_total; end if;

  insert into posting (idem_key, kind) values (p_key, p_kind)
  on conflict (idem_key) do nothing returning id into v_id;
  if v_id is null then
    select id into v_id from posting where idem_key = p_key;  -- replay, no new entries
    return v_id;
  end if;

  -- Ordered by code so concurrent postings acquire locks in the same order.
  for v_account_id, v_amount in
    select a.id, t.amount
    from unnest(p_accounts, p_amounts) as t(code, amount)
    join account a on a.code = t.code
    order by t.code
  loop
    update account set balance_cents = balance_cents + v_amount where id = v_account_id;
    if not found then raise exception 'unknown account in posting'; end if;
    insert into entry (posting_id, account_id, amount_cents) values (v_id, v_account_id, v_amount);
  end loop;
  if (select count(*) from entry where posting_id = v_id) <> v_count then
    raise exception 'posting references an unknown account';
  end if;
  return v_id;
end;
$$;
insert into account (code, kind, is_credit) values
  ('1000.cash', 'ASSET', false),
  ('2000.credit.1', 'LIABILITY', true),
  ('4000.revenue', 'REVENUE', false);
-- Purchase of 100.00 in credits: cash in, and 100.00 owed to the buyer as a
-- credit balance (negative on a liability).
select post_journal('pay:demo-1', 'CREDIT_PURCHASE', array['1000.cash', '2000.credit.1'], array[10000, -10000]);
-- The same key again returns the same posting and writes nothing.
select post_journal('pay:demo-1', 'CREDIT_PURCHASE', array['1000.cash', '2000.credit.1'], array[10000, -10000]);
select code, balance_cents from account order by code;
-- Redeeming 500.00 of credits while 100.00 is held never reaches the ledger.
-- SQLSTATE 23514 is what a client maps to an insufficient funds error, and the
-- failed statement leaves no partial state.
do $$
begin
  perform post_journal('rdm:demo-2', 'CREDIT_REDEMPTION', array['2000.credit.1', '4000.revenue'], array[50000, -50000]);
exception when check_violation then
  raise notice 'rejected by constraint, SQLSTATE %', sqlstate;
end $$;
select count(*) as postings from posting;
drop schema ledger_demo cascade;
