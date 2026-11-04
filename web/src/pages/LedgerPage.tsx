import { payoutIsInLedger } from "../../../src/claims/ledger.ts";
import { Link } from "../components/Link.tsx";
import { api, ApiError, tokens, type PayoutReceipt, type Program, type PublicLedger } from "../api.ts";
import { ChecksPanel } from "../components/ChecksPanel.tsx";
import { money, short, usePoll } from "../lib.ts";
import { verifyPublishedLedger } from "../verify-ledger.ts";

/** A claims program's public payout ledger, with an optional claimant receipt (`?claim=`). */
export function LedgerPage({ id, claimId }: { id: string; claimId: string | null }) {
  const { value: program, error } = usePoll<Program>(() => api.program(id), 5000, (p) => p.status === "done", [id]);
  const distributed = Boolean(program?.commitment);
  const { value: ledger } = usePoll<PublicLedger | null>(
    () => (distributed ? api.ledger(id) : Promise.resolve(null)),
    5000,
    (l) => Boolean(l?.audit),
    [id, distributed],
  );
  const { value: receipt, error: receiptError } = usePoll<PayoutReceipt | null>(
    () => (claimId && distributed ? api.payoutReceipt(claimId) : Promise.resolve(null)),
    60_000,
    (r) => r !== null,
    [claimId, distributed],
  );

  if (error && !program) return <p className="notice error">{error instanceof ApiError && error.status === 404 ? "No such program." : error.message}</p>;
  if (!program) return <p className="muted">Loading…</p>;

  if (!ledger) {
    return (
      <article className="receipt">
        <h1>{program.title}</h1>
        <p className="muted">
          No payouts yet. The ledger appears here once claims are reviewed and every payout is committed. Pool {money(program.poolCents, program.currency)}.
        </p>
      </article>
    );
  }

  const inLedger = receipt ? receipt.programId === id && payoutIsInLedger(ledger.commitment.root, id, receipt.payout, receipt.proof) : null;
  const audited = claimId ? ledger.audit?.sample.includes(claimId) : false;

  return (
    <article className="receipt">
      <p className="muted small">
        Payout ledger · program <code>{id}</code>
        {program.kind === "demo" && tokens.get(id) && (
          <>
            {" · "}
            <Link to={`/console/${id}`}>back to the console</Link>
          </>
        )}
      </p>
      {program.kind === "demo" && (
        <p className="demo-banner">
          <strong>Demo program.</strong> The claimants are synthetic and the Payouts batches simulated; the ledger, its commitment, the drand round
          and the audit sample below are real and check out exactly as a live program's do.
        </p>
      )}
      <section className="outcome good">
        <h1>{program.title}</h1>
        <p>
          {money(ledger.terms.shareCents, ledger.terms.currency)} to each of {ledger.payouts.length} verified PayPal accounts, from a pool of{" "}
          {money(ledger.terms.poolCents, ledger.terms.currency)}. Each payout went to the account that signed in for the claim, and nowhere else.
        </p>
      </section>

      {claimId && (
        <section className={`panel proofbox ${inLedger ? "ok" : inLedger === false ? "bad" : ""}`}>
          {receiptError && !receipt ? (
            <h2>This claim has no payout in this ledger</h2>
          ) : inLedger === null ? (
            <h2>Checking your payout…</h2>
          ) : (
            <>
              <h2>{inLedger ? `✓ Your ${money(receipt!.payout.amountCents, ledger.terms.currency)} payout is in the ledger` : "✗ Your payout is not in the ledger"}</h2>
              <p className="muted">
                {inLedger
                  ? "Checked in your browser: your payout's hash and its Merkle path lead to this program's commitment, made before payouts were sent. Keep this page: if anyone later added a payout or changed yours, it would no longer lead to the root you see here."
                  : "The proof does not lead to the published commitment. Contact the program administrator."}
                {audited && " Your claim is in the audit sample."}
                {inLedger && ledger.paypal && (
                  <>
                    {" "}
                    In your PayPal account, the note on this payment carries <code>{ledger.paypal.anchor.slice(0, 40)}…</code>: the same digest,
                    on PayPal's own record.
                  </>
                )}
              </p>
              <details>
                <summary>See the proof</summary>
                <p>
                  Root <code>{ledger.commitment.root}</code> · {receipt!.proof.path.length} hashes in the path
                </p>
                <p>
                  Your pseudonym in this program <code>{short(receipt!.payout.humanTag, 16)}</code> (not your PayPal ID)
                </p>
              </details>
            </>
          )}
        </section>
      )}

      {ledger.delivery && <DeliveryPanel ledger={ledger} />}

      {ledger.paypal && <HistoryPanel ledger={ledger} />}

      <section className="panel">
        <h2>Audit sample</h2>
        {ledger.audit ? (
          <p className="muted">
            drand round {ledger.audit.round} picked these {ledger.audit.sample.length} claims for audit:{" "}
            {ledger.audit.sample.map((claim) => (
              <code key={claim}>{short(claim, 10)} </code>
            ))}
          </p>
        ) : (
          <p className="muted">Waiting for drand round {ledger.terms.auditRound}, fixed in the ledger before payouts were sent.</p>
        )}
      </section>

      <ChecksPanel
        title="Check this ledger yourself"
        blurb="Your browser recomputes the commitment from every published payout, checks that PayPal's records of the payout batches name this ledger, fetches the drand round from drand itself (not from us), checks its signature, and recomputes the audit sample. If anyone had added a payout, changed an amount, or picked the audited claims by hand, a check fails."
        passed="Every payout is in the published ledger, and the audit sample is exactly what the public randomness picked."
        run={(onStep) => verifyPublishedLedger(ledger, onStep)}
      />
    </article>
  );
}

/** Where every committed payout ended up, as PayPal reported it, so the ledger always adds up. */
function DeliveryPanel({ ledger }: { ledger: PublicLedger }) {
  const d = ledger.delivery;
  const cur = ledger.terms.currency;
  const n = d.notifications;
  return (
    <section className="panel">
      <h2>Where the money went</h2>
      <p>
        <strong>{d.delivered}</strong> of {ledger.payouts.length} payouts delivered
        {d.waiting.length > 0 && <>, {d.waiting.length} still with PayPal</>}
        {d.notDelivered.length > 0 && (
          <>
            , <strong>{d.notDelivered.length} not delivered</strong> ({money(d.notDeliveredCents, cur)})
          </>
        )}
        .
      </p>
      {d.notDelivered.length > 0 && (
        <>
          <p className="muted small">
            PayPal could not deliver these. Their money went back to the program's PayPal account and was not sent anywhere else; the payouts stay in
            the ledger exactly as committed.
          </p>
          <ul className="small">
            {d.notDelivered.slice(0, 10).map((p) => (
              <li key={p.claimId}>
                <code>{short(p.claimId, 10)}</code>: {p.status.toLowerCase()}
              </li>
            ))}
          </ul>
        </>
      )}
      {d.waiting.some((w) => w.status === "UNCLAIMED") && (
        <p className="muted small">Unclaimed payouts wait for their account; PayPal returns them to the program after 30 days.</p>
      )}
      <p className="muted small">
        {d.remainderCents > 0 ? `${money(d.remainderCents, cur)} left over from rounding stays in the pool. ` : ""}
        {n
          ? n.count > 0
            ? `PayPal notified us ${n.count} time${n.count === 1 ? "" : "s"} about these payouts (each signature checked with PayPal; last ${new Date(n.lastAt!).toLocaleString()}). Every notification only makes the API read the batch back from PayPal, which stays the source of truth.`
            : "Every payout's state is read back from PayPal's Payouts API; PayPal's notifications only make that happen sooner."
          : ""}
      </p>
    </section>
  );
}

/** What PayPal's own transaction history says about these payouts (Transaction Search, via the API). */
function HistoryPanel({ ledger }: { ledger: PublicLedger }) {
  const r = ledger.reconciliation;
  const refreshed = r?.historyRefreshedAt ? new Date(r.historyRefreshedAt).toLocaleString() : null;
  return (
    <section className={`panel history ${r?.state ?? "pending"}`}>
      <h2>PayPal's transaction history</h2>
      {!r ? (
        <p className="muted">Not checked yet. Once payouts settle, the API looks every payment up in PayPal's Transaction Search.</p>
      ) : r.state === "agrees" ? (
        <p>
          <strong>✓ PayPal's history agrees.</strong> All {r.payouts} payouts are in PayPal's own transaction history under the IDs Payouts gave
          them: completed, exactly the share, each with a note naming this ledger. Checked {new Date(r.checkedAt).toLocaleString()}.
        </p>
      ) : r.state === "pending" ? (
        <p className="muted">
          Waiting for PayPal's history to catch up ({r.found} of {r.payouts} payouts found so far{refreshed ? `; PayPal last refreshed it ${refreshed}` : ""}). Transaction
          Search refreshes every few hours; this is checked again every 10 minutes.
        </p>
      ) : (
        <>
          <p>
            <strong>{r.state === "incomplete" ? "PayPal's history never caught up" : "✗ PayPal's history disagrees"}</strong> on {r.problems.length} of {r.payouts}{" "}
            payouts.
          </p>
          <ul className="small">
            {r.problems.slice(0, 10).map((p) => (
              <li key={p.claimId}>
                <code>{short(p.claimId, 10)}</code>: {p.problem}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">Read from PayPal by the Rightful API with PayPal's Server SDK; your own PayPal payment shows the same note.</p>
    </section>
  );
}
