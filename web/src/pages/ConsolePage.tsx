import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type ConsoleRing, type ConsoleView, type Outcome, type RingMember, consoleApi, tokens } from "../api.ts";
import { Link } from "../components/Link.tsx";
import { RingGraph } from "../components/RingGraph.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { money, short } from "../lib.ts";

/** AG Grid loads only when the administrator opens the table. */
const ClaimsGrid = lazy(() => import("../components/ClaimsGrid.tsx"));
/** Bryntum Scheduler loads only when the timeline is opened. */
const RingTimeline = lazy(() => import("../components/RingTimeline.tsx"));

const PATTERN_LABELS: Record<string, string> = {
  "device-farm": "Device farm",
  "address-mill": "Address mill",
  "template-crew": "Template crew",
  household: "Household",
  "shared-network": "Shared network",
  coincidence: "Coincidence",
};

const TRUTH_LABELS: Record<string, string> = {
  "device-farm": "device-farm ring",
  "address-mill": "address-mill ring",
  "template-crew": "template-crew ring",
  quiet: "quiet ring",
  solo: "real people",
  household: "a real household",
  campus: "real students",
  "sample-text": "real people",
};

type Filter = "all" | "deny" | "review" | "clear" | "decided";

/** The administrator's console: decide each held group, then commit the ledger and pay. */
export function ConsolePage({ id }: { id: string }) {
  const [token, setToken] = useState(() => {
    // A shared console link carries the token in the fragment, which never reaches a server.
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (fromLink) {
      tokens.set(id, fromLink);
      window.history.replaceState({}, "", window.location.pathname);
    }
    return tokens.get(id);
  });
  if (!token) return <TokenForm onToken={(t) => (tokens.set(id, t), setToken(t))} />;
  return <Console id={id} token={token} onForget={() => (localStorage.removeItem(`rf_console:${id}`), setToken(null))} />;
}

function Console({ id, token, onForget }: { id: string; token: string; onForget: () => void }) {
  const client = useMemo(() => consoleApi(id, token), [id, token]);
  const [view, setView] = useState<ConsoleView>();
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [table, setTable] = useState(false);
  const [timeline, setTimeline] = useState(false);

  const openRing = (ringId: string) => {
    setFilter("all");
    setOpen(ringId);
    setTimeout(() => document.getElementById(`ring-${ringId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const refresh = useCallback(async () => {
    try {
      setView(await client.view());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // While paying, read the payouts back (and draw the audit once its drand round is out).
  const status = view?.program.status;
  useEffect(() => {
    if (status !== "distributing" && status !== "done") return;
    let alive = true;
    const timer = setInterval(async () => {
      const sync = await client.sync().catch(() => null);
      if (alive) await refresh();
      if (sync?.done && sync.audit) clearInterval(timer);
    }, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [status, client, refresh]);

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(null);
    }
  };

  if (error && !view) {
    const denied = error instanceof ApiError && error.status === 401;
    return (
      <div className="notice error">
        {denied ? "That token does not open this program's console." : error.message}{" "}
        {denied && (
          <button className="secondary" onClick={onForget}>
            Use another token
          </button>
        )}
      </div>
    );
  }
  if (!view) return <p className="muted">Loading the console…</p>;

  const { program, rings, projection, demo } = view;
  const total = Object.values(view.counts).reduce((a, b) => a + (b ?? 0), 0);
  const undecided = rings.filter((r) => !r.decision);
  const byRec = (rec: string) => undecided.filter((r) => r.memo?.recommendation === rec);
  const shown = rings.filter((r) =>
    filter === "all" ? true : filter === "decided" ? Boolean(r.decision) : !r.decision && r.memo?.recommendation === filter,
  );
  const reviewing = program.status === "review";

  return (
    <div className="console">
      {program.kind === "demo" && (
        <p className="demo-banner">
          <strong>Demo program.</strong> 5,000 synthetic claimants, about a third of them filed by rings. Everything runs on the real pipeline;
          only the claimants and therefore the payouts are simulated. The ledger and the drand audit are real.
        </p>
      )}

      <header className="console-head">
        <div>
          <p className="muted small">
            Administrator console · <code>{program.id}</code>
          </p>
          <h1>{program.title}</h1>
        </div>
        <StatusPill status={program.status as "review"} />
      </header>

      <section className="stats">
        <Stat label="Pool" value={money(program.poolCents, program.currency)} />
        <Stat label="Claims" value={total.toLocaleString("en-US")} detail={`${view.agentFiled.toLocaleString("en-US")} filed by agents, then confirmed`} />
        <Stat
          label="Held in groups"
          value={view.held.ring.toLocaleString("en-US")}
          detail={`${rings.length} groups · ${undecided.length} to decide`}
          tone={undecided.length ? "warn" : undefined}
        />
        <Stat label="Held: unverified" value={view.held.unverified.toLocaleString("en-US")} detail="paid once the account is verified" />
        <Stat
          label={program.shareCents ? "Paid to each claim" : "Each approved claim, if paid now"}
          value={money(projection.shareCents, program.currency)}
          detail={`${projection.claims.toLocaleString("en-US")} claims`}
          tone="good"
        />
      </section>

      {demo && <Scoreboard demo={demo} currency={program.currency} />}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Held groups</h2>
            <p className="muted small">
              The detector groups claims that share devices, inboxes, buildings, networks or a scripted story. The investigator (TypeSafe
              Jev) answers three typed questions about each group; the facts in the memo are computed in code. You decide.
            </p>
          </div>
          {demo && (
            <label className="toggle">
              <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} /> Show ground truth
            </label>
          )}
        </div>

        <div className="tabs" role="tablist" data-tour="tabs">
          {(
            [
              ["all", `All ${rings.length}`],
              ["deny", `Recommend deny ${byRec("deny").length}`],
              ["review", `Needs a look ${byRec("review").length}`],
              ["clear", `Recommend clear ${byRec("clear").length}`],
              ["decided", `Decided ${rings.length - undecided.length}`],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? "tab active" : "tab"} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>

        {reviewing && undecided.length > 0 && (
          <div className="bulk" data-tour="bulk">
            {byRec("deny").length > 0 && (
              <button
                className="btn danger"
                disabled={busy !== null}
                onClick={() =>
                  confirm(`Deny all ${byRec("deny").length} groups the investigator recommends denying (${count(byRec("deny"))} claims)?`) &&
                  act("bulk-deny", () => client.decide(byRec("deny").map((r) => r.id), "deny"))
                }
              >
                Deny the {byRec("deny").length} recommended for denial
              </button>
            )}
            {byRec("clear").length > 0 && (
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  confirm(`Clear all ${byRec("clear").length} groups the investigator recommends clearing (${count(byRec("clear"))} claims)? They will be paid.`) &&
                  act("bulk-clear", () => client.decide(byRec("clear").map((r) => r.id), "approve"))
                }
              >
                Clear the {byRec("clear").length} recommended to clear
              </button>
            )}
            {filter === "review" && byRec("review").length > 0 && (
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  confirm(`Deny all ${byRec("review").length} groups that need a look (${count(byRec("review"))} claims) without opening them? Some may be real people; the scoreboard will show it.`) &&
                  act("bulk-review", () => client.decide(byRec("review").map((r) => r.id), "deny"))
                }
              >
                Deny these {byRec("review").length} unopened
              </button>
            )}
            <span className="muted small">Each is still your decision; nothing is decided until you click.</span>
          </div>
        )}

        <div className="rings" data-tour="rings">
          {shown.length === 0 && <p className="muted">Nothing here.</p>}
          {shown.map((ring) => (
            <RingRow
              key={ring.id}
              ring={ring}
              open={open === ring.id}
              onToggle={() => setOpen(open === ring.id ? null : ring.id)}
              reveal={reveal}
              disabled={!reviewing || busy !== null}
              onDecide={(decision) => act(ring.id, () => client.decide([ring.id], decision))}
              loadMembers={() => client.members(ring.id)}
            />
          ))}
        </div>
      </section>

      <section className="panel" data-tour="timeline">
        <div className="panel-head">
          <div>
            <h2>The attack on a timeline</h2>
            <p className="muted small">
              Every held group as a row, every claim at the moment it was filed. Rows are sorted by the investigator's fraud probability, so its
              triage reads off the time axis: farms are dense spikes, households a few claims over weeks.
            </p>
          </div>
          <button className="secondary" onClick={() => setTimeline(!timeline)} aria-expanded={timeline}>
            {timeline ? "Hide the timeline" : "Open the timeline"}
          </button>
        </div>
        {timeline && (
          <Suspense fallback={<p className="muted small">Loading the timeline…</p>}>
            <RingTimeline rings={rings} load={() => client.claims()} onOpenRing={openRing} reveal={reveal} />
          </Suspense>
        )}
      </section>

      <section className="panel" data-tour="table">
        <div className="panel-head">
          <div>
            <h2>Every claim</h2>
            <p className="muted small">
              All {total.toLocaleString("en-US")} claims in one table: sort, filter and search the evidence, export it, and jump from any claim to its
              group. Payer IDs are never shown; only the per-program pseudonym exists here.
            </p>
          </div>
          <button className="secondary" onClick={() => setTable(!table)} aria-expanded={table}>
            {table ? "Hide the table" : `Open the table`}
          </button>
        </div>
        {table && (
          <Suspense fallback={<p className="muted small">Loading the table…</p>}>
            <ClaimsGrid load={() => client.claims()} currency={program.currency} reveal={reveal} onOpenRing={openRing} />
          </Suspense>
        )}
      </section>

      <PayPanel view={view} busy={busy} onPay={() => act("pay", () => client.distribute())} />
      {error && <p className="notice error">{error.message}</p>}
    </div>
  );
}

function count(rings: ConsoleRing[]) {
  return rings.reduce((n, r) => n + r.size, 0).toLocaleString("en-US");
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "good" | "warn" }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

function Scoreboard({ demo, currency }: { demo: NonNullable<ConsoleView["demo"]>; currency: string }) {
  const rows: Array<[string, string, Outcome]> = [
    ["Pay every claim", "No checks at all", demo.payEveryone],
    ["Pay every verified PayPal account", "Verification alone; farmed accounts are verified too", demo.verifiedOnly],
    ["Rightful, with your decisions", "Held groups are not paid until you decide them", demo.rightful],
  ];
  const max = Math.max(...rows.map(([, , o]) => o.shareCents));
  return (
    <section className="panel scoreboard" data-tour="scoreboard">
      <h2>Where the $2M goes</h2>
      <p className="muted small">
        Scored against the synthetic program's truth: {demo.totals.ringClaims.toLocaleString("en-US")} ring claims and{" "}
        {demo.totals.genuineClaims.toLocaleString("en-US")} real claimants. A ring claim that is paid comes out of every real claimant's share.
      </p>
      {rows.map(([name, note, o], i) => (
        <div key={name} className={`score-row ${i === 2 ? "ours" : ""}`}>
          <div className="score-name">
            <strong>{name}</strong>
            <span className="muted small">{note}</span>
          </div>
          <div className="score-bar">
            <span style={{ width: `${(o.shareCents / max) * 100}%` }} />
          </div>
          <div className="score-nums">
            <strong>{money(o.shareCents, currency)}</strong> per claim
            <span className={o.toRingsCents ? "bad-text" : "good-text"}>{money(o.toRingsCents, currency)} to rings</span>
            <span className={i === 2 && o.genuineDenied ? "bad-text small" : "muted small"}>
              {i === 0
                ? "every real claimant paid, and every ring"
                : i === 1
                  ? `${o.genuineDenied.toLocaleString("en-US")} real claimants refused as unverified`
                  : `${o.genuineDenied.toLocaleString("en-US")} real claimants denied by your decisions · ${(o.genuineUnpaid - o.genuineDenied).toLocaleString("en-US")} waiting on verification or a decision`}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

function RingRow(props: {
  ring: ConsoleRing;
  open: boolean;
  onToggle: () => void;
  reveal: boolean;
  disabled: boolean;
  onDecide: (decision: "deny" | "approve") => void;
  loadMembers: () => Promise<RingMember[]>;
}) {
  const { ring, open, reveal } = props;
  const memo = ring.memo;
  const rec = memo?.recommendation ?? "review";
  const signals = Object.entries(ring.signals)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const truthIsRing = ring.truth ? ring.truth.ringClaims >= ring.truth.genuineClaims : null;

  return (
    <div id={`ring-${ring.id}`} className={`ring ${open ? "open" : ""} ${ring.decision ? "decided" : ""}`}>
      <button className="ring-summary" onClick={props.onToggle} aria-expanded={open}>
        <span className="ring-size">{ring.size}</span>
        <span className="ring-main">
          <strong>{!memo ? "No memo" : !memo.verdict ? "Model output rejected" : PATTERN_LABELS[memo.verdict.pattern] ?? memo.verdict.pattern}</strong>
          <span className="muted small">{memo?.evidence[0] ?? signals.map(([s, n]) => `${s} ×${n}`).join(" · ")}</span>
        </span>
        {memo?.verdict && (
          <span className="ring-odds" title="The model's probability that this group is a fraud operation">
            <span className="odds-bar">
              <span style={{ width: `${memo.verdict.coordinated * 100}%` }} />
            </span>
            <span className="small">{Math.round(memo.verdict.coordinated * 100)}% fraud</span>
          </span>
        )}
        <span className={`chip chip-${ring.decision ? (ring.decision === "deny" ? "denied" : "cleared") : rec}`}>
          {ring.decision ? (ring.decision === "deny" ? "Denied" : "Cleared") : rec === "deny" ? "Recommend deny" : rec === "clear" ? "Recommend clear" : "Needs a look"}
        </span>
        {ring.appeals > 0 && (
          <span className="chip chip-appeal" title="Members of this group asked for a person to look again">
            {ring.appeals} asked for review
          </span>
        )}
        {reveal && ring.truth && (
          <span className={`chip truth ${truthIsRing ? "truth-ring" : "truth-real"}`}>
            {ring.truth.genuineClaims && ring.truth.ringClaims
              ? `${ring.truth.ringClaims} ring · ${ring.truth.genuineClaims} real`
              : `truth: ${TRUTH_LABELS[ring.truth.kind] ?? ring.truth.kind}`}
          </span>
        )}
      </button>
      {open && <RingDetail {...props} />}
    </div>
  );
}

function RingDetail({ ring, reveal, disabled, onDecide, loadMembers }: Parameters<typeof RingRow>[0]) {
  const [members, setMembers] = useState<RingMember[]>();
  useEffect(() => {
    loadMembers().then(setMembers, () => setMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ring.id]);
  const memo = ring.memo;

  return (
    <div className="ring-detail">
      <div className="memo">
        <h3>Investigator memo</h3>
        {memo ? (
          <>
            <ul>
              {memo.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {memo.verdict ? (
              <p className="muted small">
                Model answers ({memo.verdict.model}): fraud operation {Math.round(memo.verdict.coordinated * 100)}%; best fit “
                {PATTERN_LABELS[memo.verdict.pattern]}” ({Math.round(memo.verdict.patternConfidence * 100)}%); evidence strength{" "}
                {memo.verdict.strength.toFixed(1)} of 4. The facts above are computed from the claims, not written by the model.
              </p>
            ) : (
              <p className="notice small">
                <strong>Model output rejected:</strong> {memo.rejected}. Its answer was not used; the facts above are computed from the claims.
                Decide on the evidence.
              </p>
            )}
          </>
        ) : (
          <p className="muted">No memo for this group: decide on the evidence below.</p>
        )}
        {!ring.decision && (
          <div className="decide">
            <button className="btn danger" disabled={disabled} onClick={() => onDecide("deny")}>
              Deny {ring.size} claims
            </button>
            <button className="btn" disabled={disabled} onClick={() => onDecide("approve")}>
              Clear and pay them
            </button>
          </div>
        )}
      </div>
      {members && members.length > 0 && <RingGraph members={members} reveal={reveal} />}
      <div className="members">
        {!members ? (
          <p className="muted small">Loading claims…</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Filed</th>
                <th>Email</th>
                <th>Address</th>
                <th>Network</th>
                <th>Device</th>
                <th>Story</th>
                {reveal && <th>Truth</th>}
              </tr>
            </thead>
            <tbody>
              {members.slice(0, 60).map((m) => (
                <tr key={m.id}>
                  <td className="nowrap">
                    {new Date(m.filedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {m.filedVia === "agent" && (
                      <span className="tag" title={m.agentName ? `Filed by an assistant that called itself “${m.agentName}”, then confirmed by the person` : "Filed by an assistant, then confirmed by the person"}>
                        agent{m.agentName ? `: ${m.agentName}` : ""}
                      </span>
                    )}
                    {!m.verified && <span className="tag warn">unverified</span>}
                    {m.appeal && (
                      <span className="tag appeal" title={m.appeal}>
                        asked for review
                      </span>
                    )}
                  </td>
                  <td>{m.email}</td>
                  <td>{m.address}</td>
                  <td className="mono">{m.network}.*</td>
                  <td className="mono">{short(m.device, 6).replace("…", "")}</td>
                  <td className="story">
                    {m.narrative}
                    {m.appeal && <span className="appeal-text">Their request for review: “{m.appeal}”</span>}
                  </td>
                  {reveal && <td className="nowrap">{m.truth?.replace(":", " · ")}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {members && members.length > 60 && <p className="muted small">First 60 of {members.length} claims.</p>}
      </div>
    </div>
  );
}

function PayPanel({ view, busy, onPay }: { view: ConsoleView; busy: string | null; onPay: () => void }) {
  const { program, projection, counts } = view;
  if (program.status === "review") {
    const ready = projection.undecidedRings === 0;
    return (
      <section className="panel pay" data-tour="pay">
        <h2>Commit the ledger, then pay</h2>
        <p className="muted">
          {ready
            ? `${projection.claims.toLocaleString("en-US")} approved claims get ${money(projection.shareCents, program.currency)} each. First the ledger of every payout is hashed into one Merkle root that names a drand round 30 seconds in the future; then PayPal Payouts sends each share to the PayPal account that signed in for the claim (recipient_type PAYPAL_ID).`
            : `Payouts start only when every held group has your decision: ${projection.undecidedRings} to go.`}
          {program.kind === "demo" && " In this demo the Payouts batches are simulated: no sandbox account can fund $2M."}
        </p>
        <button className="paypal-button" disabled={!ready || busy !== null} onClick={onPay}>
          {busy === "pay" ? "Committing…" : `Commit and pay ${projection.claims.toLocaleString("en-US")} claims`}
        </button>
      </section>
    );
  }
  const paid = counts.paid ?? 0;
  return (
    <section className="panel pay done" data-tour="pay">
      <h2>{program.status === "done" ? `All ${paid.toLocaleString("en-US")} claims paid` : `Paying: ${paid.toLocaleString("en-US")} of ${projection.claims.toLocaleString("en-US")}`}</h2>
      <p className="muted">
        Ledger committed before any money moved: <code>{short(program.commitment, 16)}</code>. Anyone can recompute it, and the drand-picked audit
        sample, in their browser.
      </p>
      <Link to={`/l/${program.id}`} className="btn">
        Open the public ledger →
      </Link>
    </section>
  );
}

function TokenForm({ onToken }: { onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <section className="panel">
      <h2>Administrator console</h2>
      <p className="muted">Paste the admin token to open this program. It stays in this browser.</p>
      <form
        className="enter-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <input className="text-input" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Admin token" />
        <button className="secondary">Open</button>
      </form>
    </section>
  );
}
