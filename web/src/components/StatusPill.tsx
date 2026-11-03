import type { ProgramStatus } from "../api.ts";

const LABELS: Record<ProgramStatus, string> = {
  open: "Claims open",
  review: "In review",
  distributing: "Paying out",
  done: "Paid",
};

export function StatusPill({ status }: { status: ProgramStatus }) {
  return <span className={`pill pill-${status}`}>{LABELS[status]}</span>;
}
