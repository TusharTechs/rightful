# Firsthand

**Agents welcome. Bots aren't.**

Fair, bot-proof ballots for anything scarce: concert tickets, limited drops, popular classes.
Built on PayPal.

> Status: day 0 of the build. The ballot engine and the PayPal sandbox client work and are tested;
> the fan app, organizer console and agent gateway are next.

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

To probe your own PayPal sandbox app, follow [docs/day0-sandbox-setup.md](docs/day0-sandbox-setup.md).

## License

[MIT](LICENSE)
