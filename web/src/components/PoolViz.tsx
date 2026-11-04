import { useEffect, useMemo, useRef, useState } from "react";
import { money } from "../lib.ts";

/**
 * The idea in one picture: the demo settlement as 500 dots (10 claims each). Paying every claim
 * hands farm dots a full share; with Rightful the farm dots are held and denied, and every real
 * claimant's share grows. Numbers are the demo program's (held-out seed), as in the README.
 */

const DOTS = 500;
const FARM = 150; // 1,500 ring claims of 5,000
const LEAK = 12; // ring claims still paid with Rightful: $48,025 of $600,000 ≈ 8%
const COLS = 50;

const MODES = {
  everyone: { label: "Pay every claim", share: 40_000, toFarms: 60_000_000, note: "No checks: every farm claim takes a full share." },
  rightful: { label: "With Rightful", share: 63_191, toFarms: 4_802_500, note: "Farm groups held and denied by a person; real claimants paid more." },
} as const;
type Mode = keyof typeof MODES;

/** A fixed shuffle, so farm dots are scattered the same way on every visit. */
function layout() {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kinds: string[] = Array.from({ length: DOTS }, (_, i) => (i < FARM ? (i < LEAK ? "leak" : "farm") : "real"));
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  return kinds;
}

function useCount(target: number, ms = 900) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const begin = from.current;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(begin + (target - begin) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

export function PoolViz() {
  const kinds = useMemo(layout, []);
  const [mode, setMode] = useState<Mode>("everyone");
  const [touched, setTouched] = useState(false);
  const share = useCount(MODES[mode].share);
  const toFarms = useCount(MODES[mode].toFarms);

  // Plays itself until the visitor picks a mode.
  useEffect(() => {
    if (touched || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => setMode((m) => (m === "everyone" ? "rightful" : "everyone")), 3600);
    return () => clearInterval(id);
  }, [touched]);

  const pick = (m: Mode) => {
    setTouched(true);
    setMode(m);
  };
  const rows = DOTS / COLS;

  return (
    <section className={`pool pool-${mode}`} data-tour="pool" aria-label="How a $2M settlement is split">
      <div className="pool-switch" role="radiogroup" aria-label="How the pool is paid">
        {(Object.keys(MODES) as Mode[]).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => pick(m)}>
            {MODES[m].label}
          </button>
        ))}
      </div>
      <div className="pool-body">
        <svg viewBox={`0 0 ${COLS * 12} ${rows * 12}`} className="pool-dots" role="img" aria-label={`${FARM * 10} farm claims among 5,000`}>
          {kinds.map((kind, i) => (
            <circle key={i} cx={(i % COLS) * 12 + 6} cy={Math.floor(i / COLS) * 12 + 6} r={4} className={`dot ${kind}`} style={{ transitionDelay: `${(i % 37) * 9}ms` }} />
          ))}
        </svg>
        <div className="pool-numbers">
          <div>
            <span className="pool-label">Each real claimant gets</span>
            <span className="pool-share">{money(share)}</span>
          </div>
          <div>
            <span className="pool-label">Paid to claim farms</span>
            <span className="pool-farms">{money(toFarms)}</span>
          </div>
          <p className="muted small">{MODES[mode].note}</p>
          <p className="pool-legend small">
            <span className="dot-key real" /> real claimant <span className="dot-key farm" /> claim farm · each dot is 10 of the demo's 5,000 claims
          </p>
        </div>
      </div>
    </section>
  );
}
