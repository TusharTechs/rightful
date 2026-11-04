import { type ReactNode, useState } from "react";
import type { CheckStep } from "../verify-ledger.ts";

/** "Don't trust us, check": runs a list of checks in this browser and shows each result. */
export function ChecksPanel(props: {
  title: string;
  blurb: ReactNode;
  passed: string;
  run: (onStep: (step: CheckStep) => void) => Promise<boolean>;
  /** The guided tour's name for this panel. */
  tour?: string;
}) {
  const [steps, setSteps] = useState<CheckStep[]>([]);
  const [state, setState] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const [took, setTook] = useState<number>();

  const run = async () => {
    setSteps([]);
    setState("running");
    const started = performance.now();
    const ok = await props.run((step) => setSteps((previous) => [...previous, step]));
    setTook(Math.round(performance.now() - started));
    setState(ok ? "passed" : "failed");
  };

  return (
    <section className={`panel verify ${state}`} data-tour={props.tour}>
      <div className="panel-head">
        <h2>{props.title}</h2>
        <button className="secondary" onClick={run} disabled={state === "running"}>
          {state === "running" ? "Checking…" : state === "idle" ? "Verify in my browser" : "Run again"}
        </button>
      </div>
      <p className="muted">{props.blurb}</p>
      {steps.length > 0 && (
        <ul className="checks">
          {steps.map((step) => (
            <li key={step.label} className={step.skipped ? "skipped" : step.ok ? "ok" : "bad"}>
              <span className="mark-icon" aria-hidden="true">
                {step.skipped ? "–" : step.ok ? "✓" : "✗"}
              </span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {state === "passed" && <p className="verdict ok">All checks passed in {took} ms. {props.passed}</p>}
      {state === "failed" && <p className="verdict bad">A check failed. Do not trust this result.</p>}
    </section>
  );
}
