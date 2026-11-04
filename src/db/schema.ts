/**
 * The ledger. Money state lives here; PayPal is read back to confirm it.
 *
 * Amounts are integer cents. Claims must pay the account that signed in, so they keep its payer ID,
 * but only encrypted (`payee_sealed`); everything public uses the per-program `human_tag`.
 */

export const SCHEMA = /* sql */ `
-- Claims programs. The pool is split equally over approved claims.
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
-- The public ledger: committed before payouts are sent, with a future drand round for the audit.
alter table programs add column if not exists commitment_root text;
alter table programs add column if not exists commitment_digest text;
alter table programs add column if not exists audit_round integer;
alter table programs add column if not exists audit_size integer;
alter table programs add column if not exists audit_randomness text;
alter table programs add column if not exists audit_signature text;
alter table programs add column if not exists audit_sample jsonb;

-- Demo programs are seeded from the synthetic generator, pay by a simulated Payouts (a $2M pool is
-- more than a sandbox account holds), and keep each claim's ground truth for the console's scoreboard.
alter table programs add column if not exists kind text not null default 'live' check (kind in ('live', 'demo'));
alter table claims add column if not exists demo_truth text;
-- The assistant that filed an agent claim, as it named itself (unverified; shown to the administrator).
alter table claims add column if not exists agent_name text;
-- PayPal's transaction ID for the payout, from Payouts read-back; Transaction Search is matched on it.
alter table claims add column if not exists payout_transaction_id text;
-- The last reconciliation of a live program's payouts against PayPal's transaction history.
alter table programs add column if not exists reconciliation jsonb;
-- A held claimant's request for a person to look again (once per claim), shown in the console.
alter table claims add column if not exists appeal_message text;
alter table claims add column if not exists appealed_at timestamptz;
-- The smallest group the ring detector reports. Lower is more sensitive: it also flags households,
-- which the investigator and a person then clear.
alter table programs add column if not exists ring_min_size integer not null default 5 check (ring_min_size >= 3);

create index if not exists claims_by_program on claims (program_id, status);

-- Suspected rings from the latest review, the investigator's memo, and a person's decision.
create table if not exists rings (
  program_id  text not null references programs (id),
  id          text not null,
  claim_ids   jsonb not null,
  evidence    jsonb not null,
  memo        jsonb,
  decision    text check (decision in ('deny', 'approve')),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  primary key (program_id, id)
);

-- One PayPal account, one claim per program.
create unique index if not exists claims_one_per_human on claims (program_id, human_tag) where human_tag is not null;
`;
