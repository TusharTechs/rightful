/**
 * The ledger. Money state lives here; PayPal is read back to confirm it.
 *
 * Amounts are integer cents. Rounds fit in `integer` (quicknet is near 3.4e7 and grows by ~1e7 a
 * year). Payer IDs are never stored: entries keep only the per-ballot `human_tag`.
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
`;
