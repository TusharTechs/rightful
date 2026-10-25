import type { Ballot } from "../api.ts";
import { countdown } from "../lib.ts";

/** The four moments of a ballot, with the one in progress highlighted. */
export function Timeline({ ballot, now }: { ballot: Ballot; now: number }) {
  const order = ["open", "sealed", "drawn", "settled"] as const;
  const at = order.indexOf(ballot.status === "cancelled" ? "open" : ballot.status);
  const closes = new Date(ballot.closesAt).getTime();
  const draws = new Date(ballot.drawAt).getTime();

  const steps = [
    {
      title: "Entries open",
      detail: ballot.status === "open" ? (closes > now ? `closes in ${countdown(closes - now)}` : "closing now") : "closed",
    },
    {
      title: "List sealed",
      detail: ballot.commitment ? `commitment ${ballot.commitment.slice(0, 10)}…` : "at close",
    },
    {
      title: `drand round ${ballot.drawRound}`,
      detail:
        ballot.status === "drawn" || ballot.status === "settled"
          ? "published"
          : draws > now
            ? `${ballot.drawRoundFixed ? "" : "about "}${countdown(draws - now)}`
            : "any second",
    },
    { title: "Settled", detail: ballot.status === "settled" ? "holds captured or released" : "after the draw" },
  ];

  return (
    <ol className="timeline">
      {steps.map((step, i) => (
        <li key={step.title} className={i < at ? "done" : i === at ? "current" : "next"}>
          <span className="dot" aria-hidden="true" />
          <span className="t-title">{step.title}</span>
          <span className="t-detail">{step.detail}</span>
        </li>
      ))}
    </ol>
  );
}
