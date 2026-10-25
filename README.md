# Firsthand

**Agents welcome. Bots aren't.**

Fair, bot-proof ballots for anything scarce: concert tickets, limited drops, popular classes.
Built on PayPal.

> Status: day 2 of the build. Fans can enter a ballot with PayPal, watch the draw and verify it in
> their browser; the organizer console and agent gateway are next.

## The idea

- **One verified human, one entry.** Fans enter with their PayPal account. Organizers see a per-ballot
  pseudonym, never the account.
- **Nobody pays to enter.** An entry is a PayPal authorization hold. Selected fans are captured;
  everyone else's hold is voided.
- **A draw nobody can rig.** Entries are sealed under a Merkle root that commits to a future drand
  round. The order is computed from that round's public randomness, and anyone can recompute it.
- **Agents welcome, bots aren't.** A fan's AI assistant can enter for them, with a scoped delegation
  that traces back to one verified human.

## Try what exists today

```bash
npm install
npm test          # ballot engine, PayPal client, money handling
npm run probe -- drand
```

The drand probe fetches a live quicknet beacon, verifies its BLS signature against the pinned chain
key, and runs a 10,000-entry draw over it.

With a PayPal sandbox app set up ([docs/day0-sandbox-setup.md](docs/day0-sandbox-setup.md)):

```bash
npm run demo:ballot -- 3 2   # 3 fans, 2 seats, on the real sandbox
npm run dev:api              # the API on http://localhost:8787
```

The demo prints one PayPal approval link per fan. Approve each as a different sandbox Personal account
(use "Not you?" on PayPal's page to switch). It then seals the list, waits for the drand round, draws,
captures the selected holds, voids the rest, reads every hold back from PayPal and re-verifies the draw.
No database to install: without `DATABASE_URL` it runs Postgres in-process (PGlite).

### Run the fan app locally, no PayPal account needed

```bash
npm run dev:api:fake   # API with a stand-in PayPal approval page (local only, refused in production)
npm run dev:web        # fan app on http://localhost:5173
```

Create a ballot (`ADMIN_TOKEN` is `dev-admin-token` in this mode), open it in the fan app, enter, and
approve on the stand-in page. Two minutes later the clock seals, draws and settles it, and
**Verify in my browser** re-checks the draw against drand itself.

```bash
curl -X POST localhost:8787/api/ballots -H "authorization: Bearer dev-admin-token" \
  -H "content-type: application/json" \
  -d '{"title":"Night one","priceCents":4500,"inventory":2,"perHumanLimit":2,"closesInSeconds":120}'
```

## License

[MIT](LICENSE)
