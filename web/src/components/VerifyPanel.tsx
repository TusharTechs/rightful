import { useState } from "react";
import type { PublicProof } from "../api.ts";
import { type CheckStep, verifyPublishedDraw } from "../verify.ts";

/** "Don't trust us, check": recomputes the draw in this browser. */
export function VerifyPanel({ proof }: { proof: PublicProof }) {
  const [steps, setSteps] = useState<CheckStep[]>([]);
  const [state, setState] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const [took, setTook] = useState<number>();

  const run = async () => {
    setSteps([]);
    setState("running");
    const started = performance.now();
    const ok = await verifyPublishedDraw(proof, (step) => setSteps((previous) => [...previous, step]));
    setTook(Math.round(performance.now() - started));
    setState(ok ? "passed" : "failed");
  };

  return (
    <section className={`panel verify ${state}`}>
      <div className="panel-head">
        <h2>Check this draw yourself</h2>
        <button className="secondary" onClick={run} disabled={state === "running"}>
          {state === "running" ? "Checking…" : state === "idle" ? "Verify in my browser" : "Run again"}
        </button>
      </div>
      <p className="muted">
        Your browser recomputes the sealed list, fetches the drand round from drand itself (not from us), checks its signature, and
        re-runs the draw. If anyone had changed an entry, the round or the order, a check fails.
      </p>
      {steps.length > 0 && (
        <ul className="checks">
          {steps.map((step) => (
            <li key={step.label} className={step.ok ? "ok" : "bad"}>
              <span className="mark-icon" aria-hidden="true">
                {step.ok ? "✓" : "✗"}
              </span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {state === "passed" && <p className="verdict ok">All checks passed in {took} ms. This draw is exactly what the public randomness says.</p>}
      {state === "failed" && <p className="verdict bad">A check failed. Do not trust this result.</p>}
    </section>
  );
}
