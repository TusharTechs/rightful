# Rightful

**Agents can file. Only verified humans get paid.**

Settlement and refund payouts that claim farms cannot drain. Built on PayPal.

> Status: in active development for the PayPal hackathon. Claims, payouts, the public ledger, the
> audit sample and the ring investigator work end to end on the PayPal sandbox; the administrator
> console and the hosted judge path are next.

## The problem

Class-action settlements and mass refunds pay a fixed pool split over valid claims. Bot farms file
thousands of fake claims with farmed accounts, so every real claimant's share shrinks, and
administrators either pay the fraud or freeze everyone while they investigate.

## How Rightful works

- **One claim per verified PayPal account.** Claimants sign in with PayPal. The program sees a
  per-program pseudonym, never the account, and a second claim from the same account is refused.
- **Agents can file; only people get paid.** An assistant can file a claim over the API. It waits,
  unbound, until the person it is for signs in with PayPal and confirms it.
- **Rings are held, not paid.** Claims that share devices, inboxes, buildings, networks or a scripted
  story are grouped by a deterministic detector. An investigator (TypeSafe Jev, typed answers only)
  rates each group, the memo's facts are computed in code, and a person decides.
- **The ledger comes first.** Before any money moves, every payout (claim, pseudonym, amount) is
  hashed into a Merkle root that also commits to a future drand round. Nobody can add a payout or
  change one afterwards.
- **Paid to the account that signed in.** PayPal Payouts sends each share with
  `recipient_type: PAYPAL_ID` to the payer ID captured at sign-in, and nowhere else.
- **An audit nobody picks.** Once the committed drand round is out, its randomness picks the claims to
  audit. Anyone can recompute the ledger and the sample in their browser.

## Try it

```bash
npm install
npm test                    # ledger, claims, payouts, detector, investigator, PayPal client
npm run eval:rings          # detector vs a VERIFIED-only baseline on synthetic programs (offline)
```

With a PayPal sandbox app ([docs/day0-sandbox-setup.md](docs/day0-sandbox-setup.md)) and the API
deployed or running:

```bash
npm run open:program -- --pool 2   # opens a $2 program, files one claim as an agent, prints links
npm run pay:program -- <programId> # review → ledger → payouts → audit, followed to the end
```

No database to install: without `DATABASE_URL` the API runs Postgres in-process (PGlite).

## License

[MIT](LICENSE)
