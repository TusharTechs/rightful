import type { ReactNode } from "react";

/** "How it works" as the money path: five stages on one rail, each with who acts and what proves it. */

type Stage = { title: string; body: string; who: string; proof: string; icon: ReactNode };

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const STAGES: Stage[] = [
  {
    title: "File",
    body: "Sign in with PayPal and file. One claim per verified PayPal account; an assistant can file for you, but the claim waits for you to confirm.",
    who: "Claimant or their assistant",
    proof: "Log in with PayPal",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" {...stroke} />
        <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" {...stroke} />
        <path d="m15.5 4.5 1.5 1.5 3-3" {...stroke} />
      </svg>
    ),
  },
  {
    title: "Group",
    body: "Claims sharing devices, inboxes, buildings, networks or a scripted story are held, not paid. An AI investigator explains each group.",
    who: "Detector + AI investigator",
    proof: "Facts computed in code",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="2.5" {...stroke} />
        <circle cx="5" cy="6" r="2" {...stroke} />
        <circle cx="19" cy="6" r="2" {...stroke} />
        <circle cx="5" cy="18" r="2" {...stroke} />
        <circle cx="19" cy="18" r="2" {...stroke} />
        <path d="m6.6 7.3 3.4 3M17.4 7.3l-3.4 3M6.6 16.7l3.4-3M17.4 16.7l-3.4-3" {...stroke} />
      </svg>
    ),
  },
  {
    title: "Decide",
    body: "A person denies or clears every group. Held is not denied: a claimant can ask a person to look again.",
    who: "Administrator",
    proof: "AI never decides",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="4" width="17" height="16" rx="3" {...stroke} />
        <path d="m8 12 2.5 2.5L16 9" {...stroke} />
      </svg>
    ),
  },
  {
    title: "Commit",
    body: "Before any money moves, every payout is sealed into one Merkle root that names a drand round still in the future.",
    who: "Rightful",
    proof: "Merkle root + drand",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="10.5" width="14" height="10" rx="2.5" {...stroke} />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" {...stroke} />
        <circle cx="12" cy="15.5" r="1.4" {...stroke} />
      </svg>
    ),
  },
  {
    title: "Pay and prove",
    body: "PayPal Payouts pays only the account that signed in, and every payment's note carries the ledger's digest. Anyone can check it in their browser.",
    who: "PayPal, then anyone",
    proof: "PayPal keeps a copy",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3.5h12v17l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" {...stroke} />
        <path d="M9 8.5h6M9 12h6M9 15.5h3.5" {...stroke} />
      </svg>
    ),
  },
];

export function HowItWorks() {
  return (
    <section className="how">
      <h2 className="section-title">How it works</h2>
      <p className="muted small section-note">The money path, from a claim to a payout anyone can check.</p>
      <div className="path-wrap">
        <span className="path-rail" aria-hidden="true">
          <span className="path-coin" />
        </span>
        <ol className="path">
        {STAGES.map((stage, i) => (
          <li key={stage.title} className="path-stage" style={{ animationDelay: `${i * 90}ms` }}>
            <span className="path-icon">{stage.icon}</span>
            <span className="path-step">Step {i + 1}</span>
            <h3>{stage.title}</h3>
            <p>{stage.body}</p>
            <span className="path-who">{stage.who}</span>
            <span className="path-proof">{stage.proof}</span>
          </li>
        ))}
        </ol>
      </div>
    </section>
  );
}
