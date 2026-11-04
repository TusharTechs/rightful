import { api, claimUrl, type Program } from "../api.ts";
import { DemoButton } from "../components/DemoButton.tsx";
import { HowItWorks } from "../components/HowItWorks.tsx";
import { PoolViz } from "../components/PoolViz.tsx";
import { startTour } from "../components/Tour.tsx";
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
        <PoolViz />
        <div data-tour="demo">
          <DemoButton />
        </div>
        <p className="tour-invite">
          First time here?{" "}
          <button className="tour-link" onClick={startTour}>
            Take the guided tour
          </button>{" "}
          (about four minutes, no sign-in).
        </p>
      </section>

      <section>
        <h2 className="section-title">Programs</h2>
        {error && !programs && <p className="notice error">Can't reach the Rightful API right now. {error.message}</p>}
        {!programs && !error && <p className="muted">Loading…</p>}
        {programs && programs.length === 0 && <p className="muted">No programs yet. An administrator opens one through the API.</p>}
        {programs && programs.length > 0 && (
          <p className="muted small section-note">Live programs in PayPal's sandbox: file a claim in the open one, or open a paid one's ledger and check it yourself.</p>
        )}
        <div className="cards">
          {programs
            ?.filter((p) => p.commitment || p.status !== "open" || new Date(p.closesAt).getTime() > now)
            .sort((a, b) => rank(a, now) - rank(b, now))
            .map((program) => <ProgramCard key={program.id} program={program} now={now} />)}
        </div>
      </section>

      <HowItWorks />
    </>
  );
}

function ProgramCard({ program, now }: { program: Program; now: number }) {
  const closesIn = new Date(program.closesAt).getTime() - now;
  const accepting = program.status === "open" && closesIn > 0;
  const claims = Object.values(program.claims).reduce((sum, n) => sum + n, 0);
  const meta = accepting
    ? closesIn > 48 * 3_600_000
      ? `closes ${new Date(program.closesAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : `closes in ${countdown(closesIn)}`
    : program.shareCents
      ? `${money(program.shareCents, program.currency)} each`
      : "";
  const body = (
    <>
      <div className="card-head">
        <StatusPill status={program.status} />
        {meta && <span className="card-meta">{meta}</span>}
      </div>
      <h3>{program.title}</h3>
      <p className="card-facts">
        Pool {money(program.poolCents, program.currency)} · {claims} {claims === 1 ? "claim" : "claims"}
      </p>
      <span className="card-cta">
        {program.commitment ? "See the ledger and receipts →" : accepting ? "File a claim with PayPal →" : "In review"}
      </span>
    </>
  );
  return program.commitment ? (
    <Link to={`/l/${program.id}`} className="card">
      {body}
    </Link>
  ) : accepting ? (
    <a href={claimUrl(program.id)} className="card card-open">
      {body}
    </a>
  ) : (
    <div className="card">{body}</div>
  );
}

/** Open programs first, then paid ones, then the rest. */
function rank(program: Program, now: number): number {
  if (program.status === "open" && new Date(program.closesAt).getTime() > now) return 0;
  return program.commitment ? 1 : 2;
}
