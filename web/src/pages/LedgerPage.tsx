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
          No payouts yet. The ledger is published here, before any money moves, once claims are reviewed. Pool {money(program.poolCents, program.currency)}.
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
                  ? "Checked in your browser: your payout's hash and its Merkle path lead to the commitment published before payouts were sent. Nobody could add a payout, or change yours, afterwards."
                  : "The proof does not lead to the published commitment. Contact the program administrator."}
                {audited && " Your claim is in the audit sample."}
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
        blurb="Your browser recomputes the commitment from every published payout, fetches the drand round from drand itself (not from us), checks its signature, and recomputes the audit sample. If anyone had added a payout, changed an amount, or picked the audited claims by hand, a check fails."
        passed="Every payout is in the published ledger, and the audit sample is exactly what the public randomness picked."
        run={(onStep) => verifyPublishedLedger(ledger, onStep)}
      />
    </article>
  );
}
