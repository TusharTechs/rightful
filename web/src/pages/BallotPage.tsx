import { useState } from "react";
import { api, ApiError, type Ballot, type PublicProof } from "../api.ts";
import { DrawLine } from "../components/DrawLine.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { VerifyPanel } from "../components/VerifyPanel.tsx";
import { money, myEntries, useNow, usePoll } from "../lib.ts";

export function BallotPage({ id }: { id: string }) {
  const { value: ballot, error } = usePoll(() => api.ballot(id), 2000, (b) => b.status === "settled" || b.status === "cancelled", [id]);
  const drawn = ballot && (ballot.status === "drawn" || ballot.status === "settled");
  const { value: proof } = usePoll<PublicProof | null>(
    () => (drawn ? api.proof(id) : Promise.resolve(null)),
    3000,
    (p) => p?.status === "settled",
    [id, drawn],
  );
  const now = useNow(ballot?.serverTime);
  const cancelled = new URLSearchParams(window.location.search).get("cancelled") === "1";

  if (error && !ballot) {
    return <p className="notice error">{error instanceof ApiError && error.status === 404 ? "No such ballot." : error.message}</p>;
  }
  if (!ballot) return <p className="muted">Loading…</p>;

  const mine = new Set(myEntries.forBallot(ballot.id));
  const entered = (ballot.entries.held ?? 0) + (ballot.entries.captured ?? 0) + (ballot.entries.voided ?? 0) + (ballot.entries.failed ?? 0);

  return (
    <article className="ballot">
      <div className="ballot-head">
        <StatusPill status={ballot.status} />
        <h1>{ballot.title}</h1>
        <p className="facts">
          <span>
            <strong>{ballot.inventory}</strong> {ballot.inventory === 1 ? "seat" : "seats"}
          </span>
          <span>
            <strong>{money(ballot.priceCents, ballot.currency)}</strong> each
          </span>
          <span>
            up to <strong>{ballot.perHumanLimit}</strong> per verified human
          </span>
          <span>
            <strong>{entered}</strong> {entered === 1 ? "entry" : "entries"}
          </span>
        </p>
      </div>

      {cancelled && <p className="notice">You cancelled in PayPal. Nothing was held.</p>}

      <Timeline ballot={ballot} now={now} />

      {ballot.status === "open" && new Date(ballot.closesAt).getTime() > now && <EnterPanel ballot={ballot} />}

      {ballot.status === "sealed" && (
        <section className="panel waiting">
          <div className="beacon" aria-hidden="true" />
          <div>
            <h2>Waiting for drand</h2>
            <p>
              The entry list is sealed. The order will come from drand round <strong>{ballot.drawRound}</strong>, which nobody can know
              before it is published.
            </p>
          </div>
        </section>
      )}

      {drawn && proof?.line && <DrawLine proof={proof} mine={mine} currency={ballot.currency} priceCents={ballot.priceCents} />}
      {drawn && proof && <VerifyPanel proof={proof} />}
    </article>
  );
}

function EnterPanel({ ballot }: { ballot: Ballot }) {
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const enter = async () => {
    setBusy(true);
    setFailure(undefined);
    try {
      const { entryId, approveUrl } = await api.enter(ballot.id, quantity);
      myEntries.add(entryId, ballot.id);
      window.location.assign(approveUrl);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const hold = money(ballot.priceCents * quantity, ballot.currency);
  return (
    <section className="panel enter">
      <div>
        <h2>Enter this ballot</h2>
        <p className="muted">
          You'll approve a <strong>{hold}</strong> hold in PayPal. If you're selected, it's captured. If not, it's released and you pay
          nothing. One entry per verified PayPal account.
        </p>
      </div>
      <div className="enter-row">
        {ballot.maxQuantity > 1 && (
          <label className="stepper">
            <span>Seats</span>
            <select value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} disabled={busy}>
              {Array.from({ length: ballot.maxQuantity }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="paypal-button" onClick={enter} disabled={busy}>
          {busy ? "Opening PayPal…" : `Enter with PayPal · hold ${hold}`}
        </button>
      </div>
      {failure && <p className="notice error">{failure}</p>}
    </section>
  );
}
