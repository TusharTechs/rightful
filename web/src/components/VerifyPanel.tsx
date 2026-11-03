import type { PublicProof } from "../api.ts";
import { verifyPublishedDraw } from "../verify.ts";
import { ChecksPanel } from "./ChecksPanel.tsx";

/** "Don't trust us, check": recomputes the draw in this browser. */
export function VerifyPanel({ proof }: { proof: PublicProof }) {
  return (
    <ChecksPanel
      title="Check this draw yourself"
      blurb="Your browser recomputes the sealed list, fetches the drand round from drand itself (not from us), checks its signature, and re-runs the draw. If anyone had changed an entry, the round or the order, a check fails."
      passed="This draw is exactly what the public randomness says."
      run={(onStep) => verifyPublishedDraw(proof, onStep)}
    />
  );
}
