import "@bryntum/scheduler-community/scheduler.css";
import "@bryntum/scheduler-community/svalbard.css";
import { Scheduler } from "@bryntum/scheduler-community";
import { useEffect, useRef, useState } from "react";
import type { AdminClaim, ConsoleRing } from "../api.ts";

/**
 * The attack on a timeline (Bryntum Scheduler, Community tier): one row per held group, sorted by
 * the investigator's fraud probability, each claim at the moment it was filed, and a band over the
 * group's filing window. Farms show up as dense spikes; households as a few claims spread over
 * weeks. The row carries the investigator's verdict, so its triage reads straight off the time
 * axis; click a row to open that group's memo and decide it. Replay plays the filings back.
 */

const PATTERNS: Record<string, string> = {
  "device-farm": "Device farm",
  "address-mill": "Address mill",
  "template-crew": "Template crew",
  household: "Household",
  "shared-network": "Shared network",
  coincidence: "Coincidence",
};

type Props = { rings: ConsoleRing[]; load: () => Promise<AdminClaim[]>; onOpenRing: (ringId: string) => void; reveal: boolean };

export default function RingTimeline({ rings, load, onOpenRing, reveal }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const scheduler = useRef<Scheduler | null>(null);
  const [claims, setClaims] = useState<AdminClaim[]>();
  const [error, setError] = useState<string>();
  const [replay, setReplay] = useState<{ at: number; filed: number } | null>(null);
  const span = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const openRef = useRef(onOpenRing);
  openRef.current = onOpenRing;

  useEffect(() => {
    load().then(setClaims, (err) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!claims || !host.current) return;
    const held = claims.filter((c) => c.ring_id);
    const byRing = new Map<string, AdminClaim[]>();
    for (const c of held) byRing.set(c.ring_id!, [...(byRing.get(c.ring_id!) ?? []), c]);
    const times = held.map((c) => new Date(c.filed_at).getTime());
    const start = Math.min(...times);
    const end = Math.max(...times);
    span.current = { start, end };
    const pad = (end - start) * 0.03;

    const resources = rings
      .filter((r) => byRing.has(r.id))
      .map((r) => ({
        id: r.id,
        name: r.memo?.verdict ? PATTERNS[r.memo.verdict.pattern] ?? r.memo.verdict.pattern : "No memo",
        size: r.size,
        fraud: r.memo?.verdict ? Math.round(r.memo.verdict.coordinated * 100) : null,
        rec: r.decision ? (r.decision === "deny" ? "denied" : "cleared") : r.memo?.recommendation ?? "review",
        truthRing: r.truth ? r.truth.ringClaims >= r.truth.genuineClaims : null,
      }))
      .sort((a, b) => (b.fraud ?? -1) - (a.fraud ?? -1) || b.size - a.size);

    const events = [
      ...resources.map((r) => {
        const list = byRing.get(r.id)!;
        const t = list.map((c) => new Date(c.filed_at).getTime());
        return { id: `band-${r.id}`, resourceId: r.id, startDate: new Date(Math.min(...t)), endDate: new Date(Math.max(...t) + 3_600_000), cls: `rt-band rt-${r.rec}`, name: "", band: true };
      }),
      ...held.map((c) => ({
        id: c.id,
        resourceId: c.ring_id!,
        startDate: new Date(c.filed_at),
        endDate: new Date(new Date(c.filed_at).getTime() + 2 * 3_600_000),
        cls: `rt-claim ${c.demo_truth?.startsWith("ring") ? "truth-ring" : "truth-real"}`,
        name: "",
        claim: c,
      })),
    ];

    const s = new Scheduler({
      appendTo: host.current,
      height: 460,
      readOnly: true,
      rowHeight: 34,
      barMargin: 6,
      eventLayout: "none",
      startDate: new Date(start - pad),
      endDate: new Date(end + pad),
      viewPreset: "weekAndMonth",
      columns: [
        {
          text: "Group (investigator's verdict)",
          field: "name",
          width: 260,
          htmlEncode: false,
          renderer: ({ record }: { record: { get: (k: string) => unknown } }) => {
            const rec = record.get("rec") as string;
            const fraud = record.get("fraud") as number | null;
            return `<span class="rt-row"><strong>${record.get("name")}</strong><span class="rt-chip rt-${rec}">${rec === "deny" ? "deny" : rec === "clear" ? "clear" : rec === "review" ? "look" : rec}</span>${fraud === null ? "" : `<span class="rt-fraud">${fraud}% fraud</span>`}</span>`;
          },
        },
        { text: "Size", field: "size", width: 64, align: "right" },
      ],
      features: {
        eventTooltip: {
          template: ({ eventRecord }: { eventRecord: { get: (k: string) => unknown } }) => {
            const c = eventRecord.get("claim") as AdminClaim | undefined;
            if (!c) return `<div class="rt-tip">The group's filing window</div>`;
            const when = new Date(c.filed_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
            return `<div class="rt-tip"><strong>${when}</strong><br>${c.filed_via === "agent" ? "filed by an assistant" : "filed on the web"} · ${c.verified ? "verified" : "unverified"}<br><span>${c.network}.* · device ${c.device.slice(0, 6)}</span></div>`;
          },
        },
      },
      resources,
      events,
      listeners: {
        cellClick: ({ record }) => openRef.current(String(record.id)),
      },
    });
    scheduler.current = s;
    return () => {
      s.destroy();
      scheduler.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims]);

  // Ground truth colours the claims when the administrator reveals it.
  useEffect(() => {
    host.current?.classList.toggle("rt-reveal", reveal);
  }, [reveal]);

  // Replay: claims appear as they were filed.
  const play = () => {
    const s = scheduler.current;
    if (!s) return;
    const { start, end } = span.current;
    const steps = 80;
    let i = 0;
    const tick = () => {
      i++;
      const at = start + ((end - start) * i) / steps;
      // Each step replaces the last filter (filterBy alone adds to it). Bryntum's typings declare an
      // async predicate; a plain one works and keeps the replay in step.
      const store = s.eventStore as unknown as { clearFilters: (silent?: boolean) => void; filterBy: (fn: (e: { get: (k: string) => unknown; startDate: Date }) => boolean) => void };
      store.clearFilters(true);
      store.filterBy(
        (e) => Boolean(e.get("band")) || e.startDate.getTime() <= at,
      );
      setReplay({ at, filed: s.eventStore.count - s.resourceStore.count });
      if (i < steps) timer = window.setTimeout(tick, 90);
      else {
        s.eventStore.clearFilters();
        setReplay(null);
      }
    };
    let timer = window.setTimeout(tick, 0);
  };

  if (error) return <p className="notice error">{error}</p>;
  return (
    <div className="ring-timeline">
      <div className="grid-toolbar">
        <button className="secondary" onClick={play} disabled={!claims || replay !== null}>
          {replay ? "Replaying…" : "▶ Replay the filings"}
        </button>
        <span className="muted small">
          {replay
            ? `${new Date(replay.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${replay.filed.toLocaleString("en-US")} claims in held groups so far`
            : "Rows sorted by the investigator's fraud probability. Dense spikes are farms; a few claims over weeks is usually a household. Click a row to open its memo."}
        </span>
      </div>
      {!claims && <p className="muted small">Loading the timeline…</p>}
      <div ref={host} className="rt-host" />
    </div>
  );
}
