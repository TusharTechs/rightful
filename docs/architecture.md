# Architecture (target)

Firsthand runs as one Render Blueprint. Each service exists for a reason; this page records the
reasons. Pieces marked *(planned)* are not built yet.

```
 Fans' browsers ─┐                         ┌─► Elastic: entry telemetry, ring search (Jina vectors, ES|QL)
 Fans' AI agents ┼─► firsthand-api ──► KV ─┼─► firsthand-gate (worker): System-1 screening
   (MCP)         │    (web service)        │
 PayPal webhooks ┘         │               └─► live counters → React Flow canvas (SSE)
                           │ Render SDK: start / poll runs
                           ▼
                  firsthand-workflows (private)          firsthand-clock (cron)
                  sealBallot · runDraw · settleBallot ◄── starts draws when the drand round
                  ├─ captureEntry × N   (fan-out)          arrives; reauthorization sweeps;
                  ├─ voidEntry × N      (fan-out)          nightly reconciliation
                  reauthorizeExpiring · investigateCluster
                  rehearseBallot · reconcile · payoutResale
                           │
                           ▼
                  firsthand-db (Postgres): ballots, entries, holds, draws, payouts, audit log
```

| Service | Type | Job | Why it is separate |
|---|---|---|---|
| `firsthand-web` *(in render.yaml)* | Static site, PR previews | Fan app: ballot page, PayPal entry, live draw, receipts; verifies proofs and the draw in the browser | No server needed; every PR gets a preview |
| `firsthand-api` *(in render.yaml)* | Web service | REST API, PayPal return pages, Log in with PayPal callback; next: webhook receiver, MCP gateway for fan agents, SSE updates | The only public backend, kept free of long jobs |
| `firsthand-gate` *(planned)* | Background worker | Reads the entry queue, screens each entry, writes telemetry | Keeps up with a bot storm without slowing the API |
| `firsthand-workflows` *(planned)* | Render Workflows (TypeScript SDK) | Durable money and AI tasks with retries; one subtask per capture or void | Settlement must survive crashes; retries reuse PayPal idempotency keys, so a replayed task never charges twice |
| `firsthand-clock` *(in render.yaml)* | Cron job, every minute | Seals closed ballots, draws once the round is out, settles; next: hold reauthorization sweep, nightly reconciliation | The backstop for ballots nobody is watching (the API advances watched ballots immediately) |
| `firsthand-db` *(in render.yaml)* | Postgres, private network only | Source of truth for money state, plus an append-only audit log | Durable, relational, easy to reconcile against PayPal |
| `firsthand-kv` *(planned)* | Key Value | Entry queue, rate limits, idempotency locks, pub/sub | Low-latency state shared by the API and the gate |

## Money flow

1. **Enter.** The fan approves an Orders v2 `AUTHORIZE` order. The API authorizes it and records the hold.
2. **Seal.** At close, `sealBallot` commits a Merkle root over all entries plus the terms and the drand round
   (`src/ballot/commit.ts`).
3. **Draw.** When the round is published, `runDraw` fetches and verifies the beacon and computes the line
   (`src/ballot/draw.ts`). No model or person is involved.
4. **Settle.** `settleBallot` fans out: selected entries are captured, every other hold is voided. Each call
   carries an idempotency key derived from the entry ID. Results are read back from PayPal.
5. **Resell at face value.** A buyer's hold is captured only after the ticket is reissued to them; the seller
   is paid with Payouts.
6. **Reconcile.** Transaction Search confirms the ledger matches PayPal.
