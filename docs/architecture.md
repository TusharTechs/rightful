# Architecture

Rightful runs as one Render Blueprint (`render.yaml`). Each service exists for a reason; this page
records the reasons. Pieces marked *(planned)* are not built yet.

```
 Claimants' browsers ─┐                                   ┌─► PayPal: Log in with PayPal (identity)
 Claimants' agents ───┼─► rightful-api (web service) ─────┼─► PayPal: Payouts to PAYPAL_ID
   (JSON; MCP planned)│     claims · review · ledger      ├─► TypeSafe Jev: ring investigator (typed)
                      │              │                    └─► drand quicknet: audit randomness
 rightful-web ────────┘              ▼
 (static: programs,          rightful-db (Postgres): programs, claims (payer ID sealed),
  ledger, verifier)          rings and memos, ledger commitments, audit samples
                                     ▲
                       rightful-clock (cron, every minute): payout read-back, audit draws
```

| Service | Type | Job | Why it is separate |
|---|---|---|---|
| `rightful-api` | Web service, always on | Claim pages after Log in with PayPal, JSON for agents and the web app, organizer review, distribution, ledgers | Judges never hit a cold start; the build runs the type checker and tests, and a failing build never deploys |
| `rightful-web` | Static site, PR previews | Programs, the payout ledger, and the in-browser verifier | Needs no server; it bundles the same ledger code the API runs, so verification does not trust the API |
| `rightful-clock` | Cron job, every minute | Reads payout items back from PayPal; draws audit samples once their drand round is out | Sandbox webhooks can lag by hours, so polling is the source of truth; it runs whether or not anyone is watching |
| `rightful-db` | Postgres, private network only | Source of truth for claims and money state | Paid plan: free databases are deleted after 30 days, and judging runs into December |
| `rightful-secrets` | Env group | `HUMAN_TAG_SECRET` (pseudonyms, claim passes, sealed payer IDs) and `ADMIN_TOKEN` | Generated once, shared by the API and the clock |

## The money path

1. **Sign in.** Log in with PayPal returns the payer ID and verification status. The API turns them
   into a 30-minute claim pass: the per-program human tag, the verified flag, and the payer ID sealed
   with AES-256-GCM. The browser carries the pass but cannot read or change it.
2. **File or confirm.** A claim stores the human tag (unique per program) and the sealed payer ID. An
   agent-filed claim has neither until its person signs in and confirms it.
3. **Review.** After close, the detector groups suspected rings and the investigator writes a memo on
   each. Unverified accounts and rings are held; a person denies or clears each ring.
4. **Commit, then pay.** In one transaction the share is fixed and the ledger committed (Merkle root
   plus a drand round at least 30 seconds ahead). Only then are Payouts batches sent, with batch IDs
   derived from the program so a retry can never pay twice.
5. **Read back and audit.** The clock polls every payout item to `paid` or `failed`, and once the
   committed round is out, draws the audit sample from its randomness.

## Also on the API

- The claimant MCP server at `/mcp` (`src/api/mcp.ts`): the same filing path and limit as the JSON API; see `docs/agents.md`.
- Payouts webhooks at `POST /webhooks/paypal` (`src/claims/webhooks.ts`): each delivery's signature is checked with PayPal, it is recorded once by event ID, and it only makes the API read that batch back at once. Polling stays the source of truth. Register with `npm run webhook:register`; the API finds its webhook by URL.
