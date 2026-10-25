import { Link } from "./Link.tsx";
import type { PublicProof } from "../api.ts";
import { money, short } from "../lib.ts";

/** The published line: every sealed entry in draw order, selected ones first-class. */
export function DrawLine({ proof, mine, currency, priceCents }: { proof: PublicProof; mine: Set<string>; currency: string; priceCents: number }) {
  const line = proof.line ?? [];
  const selected = line.filter((p) => p.selected > 0);
  const units = selected.reduce((sum, p) => sum + p.selected, 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>The draw</h2>
        <span className="muted small">
          round {proof.beacon?.round} · randomness <code>{proof.beacon?.randomness.slice(0, 12)}…</code>
        </span>
      </div>
      <p className="muted">
        {units} {units === 1 ? "seat" : "seats"} went to {selected.length} {selected.length === 1 ? "entry" : "entries"}. Everyone else's
        hold is released, so they pay nothing.
      </p>
      <ol className="line">
        {line.map((placement, i) => {
          const isMine = mine.has(placement.entryId);
          return (
            <li
              key={placement.entryId}
              className={`${placement.selected > 0 ? "selected" : "waitlist"} ${isMine ? "mine" : ""}`}
              style={{ animationDelay: `${Math.min(i, 30) * 60}ms` }}
            >
              <span className="pos">#{placement.position + 1}</span>
              <span className="who">
                {isMine ? (
                  <Link to={`/e/${placement.entryId}`}>You · {short(placement.entryId)}</Link>
                ) : (
                  <code>{short(placement.entryId)}</code>
                )}
              </span>
              <span className="ticket" title="HMAC of this entry under the round's randomness">
                <code>{placement.ticket.slice(0, 8)}</code>
              </span>
              <span className="result">
                {placement.selected > 0
                  ? `${placement.selected} ${placement.selected === 1 ? "seat" : "seats"} · ${money(priceCents * placement.selected, currency)}`
                  : "released"}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
