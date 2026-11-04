import { api, claimUrl, type Program } from "../api.ts";
import { DemoButton } from "../components/DemoButton.tsx";
import { Link } from "../components/Link.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { countdown, money, useNow, usePoll } from "../lib.ts";

export function HomePage() {
  const { value: programs, error } = usePoll(() => api.programs(), 10_000);
  const now = useNow();

  return (
    <>
      <section className="hero">
        <h1>
          Settlement money for the people it's owed.
          <br />
          <span className="accent">Agents can file. Only verified humans get paid.</span>
        </h1>
        <p className="lede">
          Claim farms file thousands of fake claims and dilute every real one. Rightful pays each verified PayPal account at most once, holds
          suspected rings for a person to decide, commits who gets paid what before any money moves, and pays only the account that signed
          in.
        </p>
        <DemoButton />
      </section>

      <section>
        <h2 className="section-title">Programs</h2>
        {error && !programs && <p className="notice error">Can't reach the Rightful API right now. {error.message}</p>}
        {!programs && !error && <p className="muted">Loading…</p>}
        {programs && programs.length === 0 && <p className="muted">No programs yet. An administrator opens one through the API.</p>}
        <div className="cards">
          {programs?.map((program) => <ProgramCard key={program.id} program={program} now={now} />)}
        </div>
      </section>

      <section className="how">
        <h2 className="section-title">How it works</h2>
        <ol className="steps">
          <li>
            <strong>One claim per verified PayPal account.</strong> Claimants sign in with PayPal and file. An assistant can file for you; the
            claim waits until you sign in and confirm it.
          </li>
          <li>
            <strong>Rings are held, not paid.</strong> Claims that share devices, inboxes, buildings or a scripted story are grouped. An
            investigator explains each group, and a person decides.
          </li>
          <li>
            <strong>The ledger comes first.</strong> Before any payout, every payout is hashed into one public commitment that names a future
            drand round. Change a payout afterwards and every receipt stops matching.
          </li>
          <li>
            <strong>Paid to the account that signed in.</strong> PayPal Payouts sends each share to that account and nowhere else. drand's
            randomness then picks the claims to audit, and anyone can check it.
          </li>
        </ol>
      </section>
    </>
  );
}

function ProgramCard({ program, now }: { program: Program; now: number }) {
  const closesIn = new Date(program.closesAt).getTime() - now;
  const claims = Object.values(program.claims).reduce((sum, n) => sum + n, 0);
  const body = (
    <>
      <div className="card-head">
        <StatusPill status={program.status} />
        <span className="muted small">{program.status === "open" ? `closes in ${countdown(closesIn)}` : program.shareCents ? `${money(program.shareCents, program.currency)} each` : ""}</span>
      </div>
      <h3>{program.title}</h3>
      <p className="muted">
        Pool {money(program.poolCents, program.currency)} · {claims} {claims === 1 ? "claim" : "claims"}
      </p>
    </>
  );
  return program.commitment ? (
    <Link to={`/l/${program.id}`} className="card">
      {body}
    </Link>
  ) : program.status === "open" ? (
    <a href={claimUrl(program.id)} className="card">
      {body}
    </a>
  ) : (
    <div className="card">{body}</div>
  );
}
