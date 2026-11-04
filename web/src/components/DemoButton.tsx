import { useState } from "react";
import { api, tokens } from "../api.ts";
import { navigate } from "../lib.ts";

/** Opens a fresh $2M demo program for this visitor (or the one they already have). */
export function DemoButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const existing = tokens.lastDemo();

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const demo = await api.createDemo();
      tokens.set(demo.programId, demo.token);
      tokens.rememberDemo(demo.programId);
      navigate(`/console/${demo.programId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="demo-cta">
      <button className="paypal-button" disabled={busy} onClick={start}>
        {busy ? "Seeding 5,000 claims…" : "Run a $2M program as the administrator"}
      </button>
      {existing && (
        <button className="secondary" onClick={() => navigate(`/console/${existing.programId}`)}>
          Continue your demo
        </button>
      )}
      <span className="muted small">No sign-in. 5,000 synthetic claims, real ring detection, investigator memos, ledger and drand audit.</span>
      {error && <p className="notice error">{error}</p>}
    </div>
  );
}
