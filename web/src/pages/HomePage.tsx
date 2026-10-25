import { Link } from "../components/Link.tsx";
import { api, type Ballot } from "../api.ts";
import { StatusPill } from "../components/StatusPill.tsx";
import { countdown, money, useNow, usePoll } from "../lib.ts";

export function HomePage() {
  const { value: ballots, error } = usePoll(() => api.ballots(), 5000);
  const now = useNow(ballots?.[0]?.serverTime);

  return (
    <>
      <section className="hero">
        <h1>
          Fair ballots for anything scarce.
          <br />
          <span className="accent">One verified human, one entry.</span>
        </h1>
        <p className="lede">
          Bots and scalpers sweep up tickets, drops and classes before people can. Firsthand lets each verified PayPal account enter
          once. Nobody pays to enter: you approve a PayPal hold, and only selected fans are charged. A public drand beacon decides the
          order, and anyone can check the draw.
        </p>
      </section>

      <section>
        <h2 className="section-title">Ballots</h2>
        {error && !ballots && <p className="notice error">Can't reach the Firsthand API right now. {error.message}</p>}
        {!ballots && !error && <p className="muted">Loading…</p>}
        {ballots && ballots.length === 0 && <p className="muted">No ballots yet. An organizer creates one through the API.</p>}
        <div className="cards">
          {ballots?.map((ballot) => <BallotCard key={ballot.id} ballot={ballot} now={now} />)}
        </div>
      </section>

      <section className="how">
        <h2 className="section-title">How it works</h2>
        <ol className="steps">
          <li>
            <strong>Enter with PayPal.</strong> Approve a hold for the ticket price. Nothing is charged. One live entry per verified PayPal
            account.
          </li>
          <li>
            <strong>The list is sealed.</strong> When entries close, every entry is hashed into one commitment that names a future drand
            round. Nobody can know that round's randomness yet.
          </li>
          <li>
            <strong>drand decides.</strong> The round's public randomness fixes the order. No person or model picks anyone.
          </li>
          <li>
            <strong>Only selected fans pay.</strong> Selected holds are captured; every other hold is voided, so you pay nothing.
          </li>
        </ol>
      </section>
    </>
  );
}

function BallotCard({ ballot, now }: { ballot: Ballot; now: number }) {
  const closesIn = new Date(ballot.closesAt).getTime() - now;
  const entered = (ballot.entries.held ?? 0) + (ballot.entries.captured ?? 0) + (ballot.entries.voided ?? 0);
  return (
    <Link to={`/b/${ballot.id}`} className="card ballot-card">
      <div className="card-head">
        <StatusPill status={ballot.status} />
        <span className="muted small">{ballot.status === "open" ? `closes in ${countdown(closesIn)}` : `round ${ballot.drawRound}`}</span>
      </div>
      <h3>{ballot.title}</h3>
      <p className="muted">
        {ballot.inventory} {ballot.inventory === 1 ? "seat" : "seats"} · {money(ballot.priceCents, ballot.currency)} each · {entered}{" "}
        {entered === 1 ? "entry" : "entries"}
      </p>
    </Link>
  );
}
