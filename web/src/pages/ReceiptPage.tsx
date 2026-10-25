import { useEffect } from "react";
import { api, ApiError, type Ballot, type Entry, type PublicProof } from "../api.ts";
import { Link } from "../components/Link.tsx";
import { Timeline } from "../components/Timeline.tsx";
import { VerifyPanel } from "../components/VerifyPanel.tsx";
import { money, myEntries, short, useNow, usePoll } from "../lib.ts";
import { entryIsSealed } from "../verify.ts";

const FINAL: Entry["status"][] = ["captured", "voided", "rejected", "cancelled", "failed"];

export function ReceiptPage({ id }: { id: string }) {
  const { value: entry, error } = usePoll(() => api.entry(id), 2000, (e) => FINAL.includes(e.status), [id]);
  const ballotId = entry?.ballotId;
  const { value: ballot } = usePoll<Ballot | null>(
    () => (ballotId ? api.ballot(ballotId) : Promise.resolve(null)),
    2000,
    (b) => b?.status === "settled" || b?.status === "cancelled",
    [ballotId],
  );
  const sealed = Boolean(ballot?.commitment);
  const { value: proof } = usePoll<PublicProof | null>(
    () => (ballotId && sealed ? api.proof(ballotId) : Promise.resolve(null)),
    3000,
    (p) => p?.status === "settled",
    [ballotId, sealed],
  );
  const now = useNow(ballot?.serverTime);

  useEffect(() => {
    if (entry) myEntries.add(entry.id, entry.ballotId);
  }, [entry?.id]);

  if (error && !entry) return <p className="notice error">{error instanceof ApiError && error.status === 404 ? "No such entry." : error.message}</p>;
  if (!entry) return <p className="muted">Loading…</p>;

  const currency = ballot?.currency ?? "USD";
  const charged = entry.selectedUnits && ballot ? ballot.priceCents * entry.selectedUnits : 0;
  const inList = proof?.commitment && entry.inclusionProof ? entryIsSealed(proof.commitment.root, entry.inclusionProof) : null;

  return (
    <article className="receipt">
      <p className="muted small">
        Entry <code>{entry.id}</code>
        {ballot && (
          <>
            {" "}
            in <Link to={`/b/${ballot.id}`}>{ballot.title}</Link>
          </>
        )}
      </p>

      <Outcome entry={entry} charged={charged} currency={currency} />

      {ballot && <Timeline ballot={ballot} now={now} />}

      {inList !== null && (
        <section className={`panel proofbox ${inList ? "ok" : "bad"}`}>
          <h2>{inList ? "✓ Your entry is in the sealed list" : "✗ Your entry is not in the sealed list"}</h2>
          <p className="muted">
            {inList
              ? "Checked in your browser: your entry's hash and its Merkle path lead to the commitment published before the draw. It could not have been added, dropped or changed after sealing."
              : "The proof does not lead to the published commitment. Contact the organizer."}
          </p>
          <details>
            <summary>See the proof</summary>
            <p>
              Leaf <code>{entry.inclusionProof?.leaf}</code>
            </p>
            <p>
              Root <code>{proof?.commitment?.root}</code> · {entry.inclusionProof?.path.length} hashes in the path
            </p>
            <p>
              Your pseudonym in this ballot <code>{short(entry.humanTag, 16)}</code> (not your PayPal ID)
            </p>
          </details>
        </section>
      )}

      {proof?.line && <VerifyPanel proof={proof} />}
    </article>
  );
}

function Outcome({ entry, charged, currency }: { entry: Entry; charged: number; currency: string }) {
  const hold = money(entry.holdCents, currency);
  switch (entry.status) {
    case "awaiting_approval":
      return <Hero tone="neutral" title="Waiting for PayPal" body="Approve the hold in PayPal to finish entering. Nothing is charged by approving it." />;
    case "held":
      return entry.outcome === "selected" ? (
        <Hero tone="good" title="You were selected!" body={`Your ${entry.selectedUnits === 1 ? "seat is" : "seats are"} being confirmed with PayPal.`} />
      ) : entry.outcome === "not_selected" ? (
        <Hero tone="neutral" title="Not selected this time" body="Your hold is being released with PayPal. You pay nothing." />
      ) : (
        <Hero tone="good" title="You're in" body={`${hold} is on hold in your PayPal account, not charged. If you're selected it's captured; if not, it's released.`} />
      );
    case "captured":
      return (
        <Hero
          tone="good"
          title={`You got ${entry.selectedUnits} ${entry.selectedUnits === 1 ? "seat" : "seats"}`}
          body={`Selected at position #${(entry.position ?? 0) + 1}. PayPal captured ${money(charged, currency)}.`}
        />
      );
    case "voided":
      return (
        <Hero
          tone="neutral"
          title="Not selected this time"
          body={`You were #${(entry.position ?? 0) + 1} in line. Your ${hold} hold was released at PayPal. You paid nothing.`}
        />
      );
    case "rejected":
      return (
        <Hero
          tone="bad"
          title="This entry didn't count"
          body={
            entry.rejection === "duplicate"
              ? "This PayPal account already has an entry in this ballot. The extra hold was released, and you were not charged."
              : entry.rejection === "unverified"
                ? "This ballot needs a verified PayPal account. The hold was released, and you were not charged."
                : "Entries closed before your approval arrived. Nothing was held."
          }
        />
      );
    case "cancelled":
      return <Hero tone="neutral" title="Cancelled" body="You cancelled in PayPal, or entries closed first. Nothing was held." />;
    case "failed":
      return <Hero tone="bad" title="Payment needs attention" body="PayPal refused to capture this hold. The organizer has been alerted." />;
  }
}

function Hero({ tone, title, body }: { tone: "good" | "neutral" | "bad"; title: string; body: string }) {
  return (
    <section className={`outcome ${tone}`}>
      <h1>{title}</h1>
      <p>{body}</p>
    </section>
  );
}
