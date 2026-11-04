import { useState } from "react";
import { ApiError, type ClaimStatus, api } from "../api.ts";
import { Link } from "../components/Link.tsx";
import { money, usePoll } from "../lib.ts";

type Step = { label: string; detail: string; state: "done" | "now" | "todo" | "stopped" };

/** A claimant's own page: where the claim stands, in plain words, and what (if anything) to do. */
export function ClaimPage({ id }: { id: string }) {
  const { value: claim, error } = usePoll<ClaimStatus>(() => api.claim(id), 15_000, (c) => c.status === "paid" || c.status === "denied", [id]);

  if (error && !claim) return <p className="notice error">{error instanceof ApiError && error.status === 404 ? "No such claim. Check the link you were given." : error.message}</p>;
  if (!claim) return <p className="muted">Loading your claim…</p>;

  const steps = stepsFor(claim);
  return (
    <article className="receipt">
      <p className="muted small">
        Your claim · <code>{claim.id}</code>
      </p>
      <h1>{claim.program.title}</h1>

      <section className="panel" aria-live="polite">
        <h2>{headline(claim)}</h2>
        <ol className="claim-steps">
          {steps.map((step) => (
            <li key={step.label} className={step.state}>
              <span className="dot" aria-hidden="true">
                {step.state === "done" ? "✓" : step.state === "stopped" ? "✗" : ""}
              </span>
              <div>
                <strong>{step.label}</strong>
                <span className="sr-only"> ({step.state === "done" ? "done" : step.state === "now" ? "current step" : step.state === "stopped" ? "stopped" : "to come"})</span>
                <p className="muted small">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {claim.status === "held" && <AppealPanel claim={claim} />}

      {claim.status === "paid" && (
        <section className="panel">
          <h2>Your receipt</h2>
          <p className="muted">
            Check, in your browser, that your {money(claim.amountCents ?? 0)} payout is in the program's ledger, committed before any money moved, and
            that PayPal's own record of your payment names that ledger.
          </p>
          <Link to={`/l/${claim.programId}?claim=${encodeURIComponent(claim.id)}`} className="btn">
            Open my receipt →
          </Link>
        </section>
      )}

      <p className="muted small">
        Keep this page's address: it is how you follow this claim. It shows no personal details and no PayPal account information.
      </p>
    </article>
  );
}

function headline(claim: ClaimStatus): string {
  switch (claim.status) {
    case "unbound":
      return "Waiting for you to confirm it";
    case "filed":
      return "Filed. Review starts when the program closes.";
    case "held":
      return claim.holdReason === "unverified" ? "Waiting for your PayPal account to be verified" : "Held for a person to review";
    case "approved":
      return "Approved. Your payment is on its way.";
    case "paid":
      return `Paid: ${money(claim.amountCents ?? 0)} to your PayPal account`;
    case "failed":
      return "PayPal could not deliver your payment";
    case "denied":
      return "Not approved";
  }
}

function stepsFor(claim: ClaimStatus): Step[] {
  const order = ["unbound", "filed", "held", "approved", "paid"] as const;
  const at = claim.status === "denied" || claim.status === "failed" ? -1 : order.indexOf(claim.status as (typeof order)[number]);
  const reviewed = ["approved", "paid", "denied", "failed"].includes(claim.status);
  const held = claim.status === "held";
  return [
    {
      label: claim.filedVia === "agent" ? (claim.bound ? "Filed by an assistant, confirmed by you" : "Filed by an assistant, waiting for you to confirm") : "Filed after you signed in with PayPal",
      detail: claim.bound ? "Tied to the PayPal account you signed in with. Only that account can be paid." : "Open the link you were sent and sign in with PayPal to confirm it. Until then it cannot be paid.",
      state: claim.bound ? "done" : "now",
    },
    {
      label: "Review",
      detail: held
        ? claim.holdReason === "unverified"
          ? "Your PayPal account is not verified yet. Verify it with PayPal; the claim then goes ahead."
          : "Your claim looks similar to a group of other claims, so a person checks it before anything is paid. Being held is not a decision."
        : reviewed
          ? claim.status === "denied"
            ? "A person reviewed it and did not approve it."
            : "Reviewed and approved."
          : `After the program closes on ${new Date(claim.program.closesAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`,
      state: claim.status === "denied" ? "stopped" : reviewed ? "done" : claim.bound && (held || at >= 1) ? "now" : "todo",
    },
    {
      label: "Paid to your PayPal account",
      detail:
        claim.status === "paid"
          ? `${money(claim.amountCents ?? 0)}, by PayPal Payouts, to the account you signed in with.`
          : claim.status === "failed"
            ? "PayPal returned the payment. The program administrator will be in touch."
            : claim.status === "approved"
              ? "Sent; PayPal is delivering it."
              : "An equal share of the pool, once every claim is reviewed.",
      state: claim.status === "paid" ? "done" : claim.status === "failed" ? "stopped" : claim.status === "approved" ? "now" : "todo",
    },
  ];
}

function AppealPanel({ claim }: { claim: ClaimStatus }) {
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(claim.appealed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (sent) {
    return (
      <section className="panel" role="status">
        <h2>You asked for a review</h2>
        <p className="muted">A person will read what you wrote before deciding. You do not need to do anything else.</p>
      </section>
    );
  }
  if (claim.holdReason === "unverified") return null;
  return (
    <section className="panel appeal-form">
      <h2>Ask a person to look again</h2>
      <p className="muted">
        If you share a home, a computer or a network with other claimants, say so. It helps the reviewer, and it is the only thing they need from you.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await api.appeal(claim.id, message);
            setSent(true);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="appeal">What should the reviewer know?</label>
        <textarea id="appeal" value={message} onChange={(e) => setMessage(e.target.value)} minLength={10} maxLength={1000} required />
        <button className="paypal-button" disabled={busy} style={{ marginTop: 12 }}>
          {busy ? "Sending…" : "Ask for a review"}
        </button>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
