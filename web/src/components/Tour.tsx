import { type ReactNode, useEffect, useState } from "react";
import { API_URL, tokens } from "../api.ts";
import { navigate } from "../lib.ts";

/**
 * The guided tour: a guide that walks a visitor (a judge, say) through the real app, page by page.
 * It never fakes anything: each step points at a live element (`data-tour="…"`) and moves on when
 * the visitor does the thing, or when they press Next. Progress is kept in this browser only.
 */

const PAID_CLAIM = "clm_n1bJwZ5ALKjI0c_K";
const PAID_PROGRAM = "prg_7Gj9VD1w1pfaBqZ_";
const SHOWCASE_PROGRAM = "prg_rh4Pg_Ch_CzamLn9";
const KEY = "rf_tour";

type Step = {
  title: string;
  body: ReactNode;
  /** Where the step happens; the guide offers to go there if the visitor is elsewhere. */
  where: (path: string) => boolean;
  go?: () => string | null;
  /** The element to point at, by its data-tour name. */
  target?: string;
  /** Moves on by itself when this becomes true. */
  done?: (path: string) => boolean;
  /** Replaces Next, for steps the visitor completes by acting. */
  waitFor?: string;
  next?: string;
};

const demoId = () => tokens.lastDemo()?.programId ?? null;
const atHome = (p: string) => p === "/" || p === "/tour";
const atConsole = (p: string) => p.startsWith("/console/");

const STEPS: Step[] = [
  {
    title: "Hey, nice to see you!",
    body: (
      <>
        I'm your guide to Rightful. In about four minutes you'll run a <strong>$2 million settlement</strong>, catch the claim farms hiding in it,
        pay people through PayPal, and check the proof yourself. Nothing to sign in to, nothing to install.
      </>
    ),
    where: atHome,
    go: () => "/",
    next: "Let's go",
  },
  {
    title: "The problem",
    body: (
      <>
        A settlement splits a fixed pool over every valid claim, so <strong>every fake claim comes out of a real person's share</strong>. Reuters
        reported 80 million settlement claims with signs of fraud in 2023, up 19,000% in two years. The pool above shows what that does.
      </>
    ),
    where: atHome,
    go: () => "/",
    target: "pool",
  },
  {
    title: "Your own $2M settlement",
    body: (
      <>
        Press the yellow button. You get a private copy of a settlement: 5,000 claims, about a third filed by claim farms, run through the real
        pipeline. Seeding takes about ten seconds.
      </>
    ),
    where: atHome,
    go: () => "/",
    target: "demo",
    done: atConsole,
    waitFor: "Press the yellow button",
  },
  {
    title: "Where the $2M goes",
    body: (
      <>
        You're the administrator now. This scoreboard is checked against the synthetic truth: pay every claim and <strong>$600,000</strong> goes
        to farms while each real person gets $400. Keep an eye on the third row as you decide.
      </>
    ),
    where: atConsole,
    go: () => (demoId() ? `/console/${demoId()}` : null),
    target: "scoreboard",
  },
  {
    title: "Groups, not guesses",
    body: (
      <>
        Rightful grouped claims that share devices, inboxes, buildings, networks or a scripted story. <strong>Open a group</strong>: you'll see who
        shares what, and the investigator's memo. The AI only answers three typed questions and never sees names, emails or PayPal IDs; every fact
        in the memo is computed in code.
      </>
    ),
    where: atConsole,
    go: () => (demoId() ? `/console/${demoId()}` : null),
    target: "rings",
  },
  {
    title: "You decide, not the AI",
    body: (
      <>
        Deny the groups the investigator recommends denying. It's still your click, for each group. Then watch the third scoreboard row:{" "}
        <strong>money to rings drops</strong> and every real claimant's share rises.
      </>
    ),
    where: atConsole,
    go: () => (demoId() ? `/console/${demoId()}` : null),
    target: "bulk",
  },
  {
    title: "Held is not denied",
    body: (
      <>
        <strong>Needs a look</strong> holds mixed groups: some are families sharing one laptop. A held claimant can ask a person to look again,
        and it shows up right here. Decide the rest (or flip <em>Show ground truth</em> to check yourself).
      </>
    ),
    where: atConsole,
    go: () => (demoId() ? `/console/${demoId()}` : null),
    target: "tabs",
  },
  {
    title: "Commit, then pay",
    body: (
      <>
        Once every group is decided, press <strong>Commit and pay</strong>. Before any money moves, every payout is sealed into one Merkle root that
        names a drand round in the future. Then PayPal Payouts pays each claimant's own PayPal account. (This demo's payouts are simulated; a real
        one is coming up.)
      </>
    ),
    where: atConsole,
    go: () => (demoId() ? `/console/${demoId()}` : null),
    target: "pay",
  },
  {
    title: "Don't trust us: check",
    body: (
      <>
        This is the public ledger. Press <strong>Verify in my browser</strong>: your browser recomputes the root from every payout, fetches the
        drand round from drand itself, checks its signature and redraws the audit sample, trusting nothing from our server.
      </>
    ),
    where: (p) => p.startsWith("/l/") && p !== `/l/${PAID_PROGRAM}`,
    go: () => (demoId() ? `/l/${demoId()}` : null),
    target: "verify",
  },
  {
    title: "Now a real one",
    body: (
      <>
        That was the demo. This claim was paid for real in PayPal's sandbox: <strong>$1.00 to the PayPal account that signed in</strong>, and
        nowhere else. This is the page its claimant follows.
      </>
    ),
    where: (p) => p === `/claim/${PAID_CLAIM}`,
    go: () => `/claim/${PAID_CLAIM}`,
    target: "claim-steps",
  },
  {
    title: "PayPal keeps a copy",
    body: (
      <>
        Its receipt checks out in your browser, and <strong>PayPal's own record of the payment carries the same ledger fingerprint</strong> in its
        note. Rightful also found it in PayPal's transaction history: completed, exactly the share.
      </>
    ),
    where: (p) => p === `/l/${PAID_PROGRAM}`,
    go: () => `/l/${PAID_PROGRAM}?claim=${PAID_CLAIM}`,
    target: "receipt",
  },
  {
    title: "Agents can file. Only people get paid.",
    body: (
      <>
        An assistant can file and follow claims for someone over MCP at <code>{API_URL}/mcp</code>, but it has no tool to confirm, decide or be
        paid. Want the claimant side? <a href={`${API_URL}/claim/start?program=${SHOWCASE_PROGRAM}`}>File a claim</a> with a PayPal sandbox
        personal account, then sign in again to see a second claim refused.
      </>
    ),
    where: () => true,
  },
  {
    title: "That's Rightful. Thanks for visiting!",
    body: (
      <>
        Your console stays yours to keep playing with. The README has the code map, the numbers and what is simulated. Settlement money, for the
        people it's owed.
      </>
    ),
    where: () => true,
    next: "Finish",
  },
];

function load(): number | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === null ? null : Math.min(Math.max(0, Number(value) || 0), STEPS.length - 1);
  } catch {
    return null;
  }
}

function save(step: number | null) {
  try {
    if (step === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(step));
  } catch {
    // The tour still works for this page view.
  }
}

export function startTour() {
  save(0);
  window.dispatchEvent(new Event("rf-tour"));
}

export function TourGuide({ path }: { path: string }) {
  const [step, setStep] = useState<number | null>(() => (path === "/tour" ? 0 : load()));
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    const onStart = () => {
      setStep(0);
      setMinimized(false);
    };
    window.addEventListener("rf-tour", onStart);
    return () => window.removeEventListener("rf-tour", onStart);
  }, []);
  useEffect(() => save(step), [step]);

  const current = step === null ? null : STEPS[step]!;
  const here = current ? current.where(path) : false;

  // Moves on once the visitor has done what the step asked.
  useEffect(() => {
    if (step !== null && current?.done?.(path)) setStep(step + 1);
  }, [path, step, current]);

  // Points at the step's element, waiting for it to render (the console loads its data first).
  useEffect(() => {
    if (!current?.target || !here || minimized) return;
    let el: Element | null = null;
    let tries = 0;
    const find = setInterval(() => {
      el = document.querySelector(`[data-tour="${current.target}"]`);
      if (el || ++tries > 40) {
        clearInterval(find);
        if (el) {
          el.classList.add("tour-target");
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }, 150);
    return () => {
      clearInterval(find);
      el?.classList.remove("tour-target");
    };
  }, [current, here, minimized, path]);

  if (step === null || !current) return null;
  const end = () => setStep(null);
  const destination = !here ? current.go?.() ?? null : null;

  if (minimized) {
    return (
      <button className="tour-fab" onClick={() => setMinimized(false)} aria-label="Open the tour guide">
        <span className="mark" aria-hidden="true">R</span> Tour · {step + 1}/{STEPS.length}
      </button>
    );
  }

  return (
    <aside className="tour" role="dialog" aria-live="polite" aria-label="Guided tour">
      <div className="tour-head">
        <span className="tour-avatar" aria-hidden="true">R</span>
        <div>
          <span className="tour-kicker">Your guide · step {step + 1} of {STEPS.length}</span>
          <h2>{current.title}</h2>
        </div>
        <button className="tour-x" onClick={() => setMinimized(true)} aria-label="Minimize the guide" title="Minimize">
          –
        </button>
      </div>
      <p className="tour-body">{current.body}</p>
      <div className="tour-progress" aria-hidden="true">
        {STEPS.map((_, i) => (
          <span key={i} className={i < step ? "done" : i === step ? "now" : ""} />
        ))}
      </div>
      <div className="tour-actions">
        <button className="tour-link" onClick={end}>
          End tour
        </button>
        <span className="tour-spacer" />
        {step > 0 && (
          <button className="secondary" onClick={() => setStep(step - 1)}>
            Back
          </button>
        )}
        {!here && destination ? (
          <button className="tour-primary" onClick={() => navigate(destination)}>
            Take me there
          </button>
        ) : !here && !destination ? (
          <button className="tour-primary" onClick={() => setStep(2)}>
            Start a demo first
          </button>
        ) : current.waitFor ? (
          <span className="tour-wait">{current.waitFor} ↑</span>
        ) : (
          <button className="tour-primary" onClick={() => (step === STEPS.length - 1 ? end() : setStep(step + 1))}>
            {current.next ?? "Next"}
          </button>
        )}
      </div>
    </aside>
  );
}
