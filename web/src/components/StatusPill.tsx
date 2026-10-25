import type { BallotStatus } from "../api.ts";

const LABELS: Record<BallotStatus, string> = {
  open: "Entries open",
  sealed: "Sealed",
  drawn: "Drawn",
  settled: "Settled",
  cancelled: "Cancelled",
};

export function StatusPill({ status }: { status: BallotStatus }) {
  return <span className={`pill pill-${status}`}>{LABELS[status]}</span>;
}
