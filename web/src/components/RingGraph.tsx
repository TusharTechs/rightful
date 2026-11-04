import type { RingMember } from "../api.ts";

/**
 * "Who shares what": a group's claims around the edge, linked to the devices, networks, buildings
 * and inboxes two or more of them share. Computed here from the members the console already shows,
 * so it is a picture of the evidence, not of anything the model said.
 */

type Kind = "device" | "network" | "building" | "inbox";
const KINDS: Record<Kind, { label: string; color: string }> = {
  device: { label: "same device", color: "#ff4d2e" },
  network: { label: "same network", color: "#3b82f6" },
  building: { label: "same building", color: "#a855f7" },
  inbox: { label: "same inbox", color: "#0ea5a4" },
};

function building(address: string): string {
  return address
    .toLowerCase()
    .replace(/\b(apt|apartment|unit|suite|ste|room|rm|flat)\.?\s*[\w-]+/g, "")
    .replace(/#\s*[\w-]+/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inbox(email: string): string {
  const [local = "", domain = ""] = email.toLowerCase().split("@");
  const base = local.split("+")[0]!;
  return `${domain === "gmail.com" || domain === "googlemail.com" ? base.replace(/\./g, "") : base}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export function RingGraph({ members, reveal }: { members: RingMember[]; reveal: boolean }) {
  const shown = members.slice(0, 40);
  const keyed = shown.map((m) => ({
    m,
    keys: [
      ["device", m.device],
      ["network", m.network],
      ["building", building(m.address)],
      ["inbox", inbox(m.email)],
    ] as Array<[Kind, string]>,
  }));
  const counts = new Map<string, { kind: Kind; value: string; members: number[] }>();
  keyed.forEach(({ keys }, i) =>
    keys.forEach(([kind, value]) => {
      if (!value) return;
      const id = `${kind}:${value}`;
      const hub = counts.get(id) ?? { kind, value, members: [] };
      hub.members.push(i);
      counts.set(id, hub);
    }),
  );
  const hubs = [...counts.values()].filter((h) => h.members.length >= 2).sort((a, b) => b.members.length - a.members.length).slice(0, 10);
  if (hubs.length === 0) return null;

  const W = 420;
  const H = 300;
  const cx = W / 2;
  const cy = H / 2;
  const outer = { x: 180, y: 128 };
  const inner = hubs.length === 1 ? 0 : 58;
  const at = (i: number, n: number, r: { x: number; y: number }, turn = 0) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2 + turn;
    return { x: cx + Math.cos(a) * r.x, y: cy + Math.sin(a) * r.y };
  };
  const memberPos = shown.map((_, i) => at(i, shown.length, outer));
  const hubPos = hubs.map((_, i) => at(i, hubs.length, { x: inner * 1.3, y: inner }, 0.4));
  const kindsPresent = [...new Set(hubs.map((h) => h.kind))];

  return (
    <figure className="ring-graph">
      <figcaption>
        <strong>Who shares what</strong>
        <span className="muted small"> · {shown.length < members.length ? `first ${shown.length} of ${members.length} claims` : `${members.length} claims`}, computed from the claims</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${hubs.length} shared signals among ${shown.length} claims`}>
        {hubs.map((hub, h) =>
          hub.members.map((i) => (
            <line key={`${h}-${i}`} x1={hubPos[h]!.x} y1={hubPos[h]!.y} x2={memberPos[i]!.x} y2={memberPos[i]!.y} stroke={KINDS[hub.kind].color} strokeOpacity={0.45} strokeWidth={1.4} className="rg-edge" />
          )),
        )}
        {shown.map((m, i) => {
          const truthRing = m.truth?.startsWith("ring");
          return (
            <circle
              key={m.id}
              cx={memberPos[i]!.x}
              cy={memberPos[i]!.y}
              r={6}
              className={`rg-claim ${reveal && m.truth ? (truthRing ? "is-ring" : "is-real") : ""} ${m.verified ? "" : "unverified"} ${m.appeal ? "appealed" : ""}`}
            >
              <title>{`${m.email} · ${m.network}.* · ${m.filedVia === "agent" ? "filed by an assistant" : "filed on the web"}${m.appeal ? " · asked for review" : ""}`}</title>
            </circle>
          );
        })}
        {hubs.map((hub, h) => (
          <g key={`${hub.kind}:${hub.value}`} className="rg-hub">
            <circle cx={hubPos[h]!.x} cy={hubPos[h]!.y} r={7 + Math.min(10, hub.members.length / 2)} fill={KINDS[hub.kind].color}>
              <title>{`${hub.members.length} claims, ${KINDS[hub.kind].label}`}</title>
            </circle>
            <text x={hubPos[h]!.x} y={hubPos[h]!.y + 3.5} textAnchor="middle" className="rg-count">
              {hub.members.length}
            </text>
          </g>
        ))}
      </svg>
      <p className="rg-legend small">
        {kindsPresent.map((k) => (
          <span key={k}>
            <span className="rg-key" style={{ background: KINDS[k].color }} /> {KINDS[k].label}
          </span>
        ))}
        <span>
          <span className="rg-key claim" /> a claim
        </span>
        {reveal && (
          <>
            <span>
              <span className="rg-key is-ring" /> ring (truth)
            </span>
            <span>
              <span className="rg-key is-real" /> real (truth)
            </span>
          </>
        )}
      </p>
    </figure>
  );
}
