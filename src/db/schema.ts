/**
 * The ledger. Money state lives here; PayPal is read back to confirm it.
 *
 * Amounts are integer cents. Rounds fit in `integer` (quicknet is near 3.4e7 and grows by ~1e7 a
 * year). Ballot entries never store payer IDs, only the per-ballot `human_tag`. Claims must pay the
 * account that signed in, so they keep its payer ID too, but only encrypted (`payee_sealed`).
 */

export const SCHEMA = /* sql */ `
create table if not exists ballots (
  id                text primary key,
  title             text not null,
  status            text not null check (status in ('open', 'sealed', 'drawn', 'settled', 'cancelled')),
  inventory         integer not null check (inventory > 0),
  per_human_limit   integer not null check (per_human_limit > 0),
  max_quantity      integer not null check (max_quantity > 0),
  allow_partial     boolean not null default false,
  require_verified  boolean not null default true,
  price_cents       integer not null check (price_cents >= 0),
  currency          text not null default 'USD',
  closes_at         timestamptz not null,
  planned_round     integer not null,
  draw_round        integer,
  commitment_digest text,
  commitment_root   text,
  entry_count       integer,
  randomness        text,
  signature         text,
  draw_line         jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists entries (
  id                text primary key,
  ballot_id         text not null references ballots (id),
  quantity          integer not null check (quantity > 0),
  hold_cents        integer not null check (hold_cents >= 0),
  status            text not null check (status in ('awaiting_approval', 'held', 'captured', 'voided', 'rejected', 'cancelled', 'failed')),
  rejection         text check (rejection in ('unverified', 'duplicate', 'closed', 'declined')),
  outcome           text check (outcome in ('selected', 'not_selected')),
  selected_units    integer,
  position          integer,
  order_id          text unique,
  authorization_id  text unique,
  capture_id        text,
  human_tag         text,
  account_status    text,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Where to send the fan after PayPal: the web app's origin, checked against an allowlist.
alter table entries add column if not exists return_to text;

create index if not exists entries_by_ballot on entries (ballot_id, status);

-- One verified human, one live entry per ballot. Rejected and cancelled entries do not count.
create unique index if not exists entries_one_per_human
  on entries (ballot_id, human_tag)
  where status in ('held', 'captured', 'voided');

create table if not exists events (
  id         serial primary key,
  ballot_id  text not null,
  entry_id   text,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);

create index if not exists events_by_ballot on events (ballot_id, id);

-- Rightful: claims programs. The pool is split equally over approved claims.
create table if not exists programs (
  id                text primary key,
  title             text not null,
  status            text not null check (status in ('open', 'review', 'distributing', 'done')),
  pool_cents        integer not null check (pool_cents > 0),
  currency          text not null default 'USD',
  require_verified  boolean not null default true,
  sample_text       text not null default '',
  closes_at         timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- A claim is bound to a human when a PayPal account signs in for it: human_tag is the per-program
-- pseudonym, payee_sealed the payer ID encrypted at rest, and the only place a payout can go.
-- Agent-filed claims start unbound and wait for that sign-in. Only the /24 of the IP is kept.
create table if not exists claims (
  id                text primary key,
  program_id        text not null references programs (id),
  status            text not null check (status in ('unbound', 'filed', 'held', 'approved', 'denied', 'paid', 'failed')),
  hold_reason       text check (hold_reason in ('unverified', 'ring')),
  ring_id           text,
  filed_via         text not null check (filed_via in ('web', 'agent')),
  human_tag         text,
  payee_sealed      text,
  verified          boolean,
  bind_code_hash    text,
  email             text not null,
  address           text not null,
  network           text not null,
  device            text not null,
  narrative         text not null,
  amount_cents      integer,
  payout_item_id    text,
  payout_status     text,
  filed_at          timestamptz not null default now(),
  bound_at          timestamptz,
  updated_at        timestamptz not null default now()
);

-- Distribution: the equal share each approved claim gets, and the Payouts batches that carry it.
alter table programs add column if not exists share_cents integer;
alter table programs add column if not exists payout_batches jsonb not null default '[]'::jsonb;

create index if not exists claims_by_program on claims (program_id, status);

-- One PayPal account, one claim per program.
create unique index if not exists claims_one_per_human on claims (program_id, human_tag) where human_tag is not null;
`;
