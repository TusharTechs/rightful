import {
  AllCommunityModule,
  type ColDef,
  type ICellRendererParams,
  type RowClassParams,
  ModuleRegistry,
  colorSchemeDark,
  themeQuartz,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AdminClaim } from "../api.ts";
import { money } from "../lib.ts";

/**
 * Every claim in the program, in one grid (AG Grid Community): sort, filter, search and export
 * the evidence behind the groups, and jump from any claim to its group's memo and decision.
 * Loaded only when the administrator opens it.
 */

ModuleRegistry.registerModules([AllCommunityModule]);

const params = {
  accentColor: "#ff4d2e",
  borderRadius: 10,
  wrapperBorderRadius: 14,
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  headerFontFamily: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
  headerFontWeight: 700,
  fontSize: 13,
  rowHeight: 38,
  headerHeight: 40,
  spacing: 7,
} as const;
const light = themeQuartz.withParams({ ...params, backgroundColor: "#ffffff", foregroundColor: "#121212", borderColor: "#e2ded3", headerBackgroundColor: "#f6f4ee", oddRowBackgroundColor: "#fbfaf6" });
const dark = themeQuartz.withPart(colorSchemeDark).withParams({ ...params, backgroundColor: "#1b1b19", foregroundColor: "#f2f0ea", borderColor: "#2e2d29", headerBackgroundColor: "#151514", oddRowBackgroundColor: "#1f1f1d" });

const STATUS_LABEL: Record<string, string> = {
  unbound: "Unbound",
  filed: "Filed",
  held: "Held",
  approved: "Approved",
  denied: "Denied",
  paid: "Paid",
  failed: "Not delivered",
};

function useDark() {
  const [isDark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const q = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    q?.addEventListener("change", on);
    return () => q?.removeEventListener("change", on);
  }, []);
  return isDark;
}

export default function ClaimsGrid(props: {
  load: () => Promise<AdminClaim[]>;
  currency: string;
  reveal: boolean;
  onOpenRing: (ringId: string) => void;
}) {
  const [rows, setRows] = useState<AdminClaim[]>();
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState<number | null>(null);
  const grid = useRef<AgGridReact<AdminClaim>>(null);
  const isDark = useDark();

  useEffect(() => {
    props.load().then(setRows, (err) => setError(err instanceof Error ? err.message : String(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = useMemo<ColDef<AdminClaim>[]>(
    () => [
      { headerName: "Claim", field: "id", pinned: "left", width: 150, valueFormatter: (p) => (p.value as string).replace(/^clm_[^_]+_/, "clm_…"), cellClass: "mono" },
      {
        headerName: "Status",
        field: "status",
        width: 130,
        cellRenderer: (p: ICellRendererParams<AdminClaim>) => <span className={`grid-status s-${p.value}`}>{STATUS_LABEL[p.value as string] ?? p.value}</span>,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => STATUS_LABEL[p.value as string] ?? (p.value as string),
      },
      {
        headerName: "Held for",
        field: "hold_reason",
        width: 120,
        valueFormatter: (p) => (p.value === "ring" ? "group" : p.value === "unverified" ? "unverified" : ""),
      },
      {
        headerName: "Group",
        field: "ring_id",
        width: 130,
        cellRenderer: (p: ICellRendererParams<AdminClaim>) =>
          p.value ? (
            <button className="grid-link" onClick={() => props.onOpenRing(p.value as string)} title="Open this group's memo and decision">
              open group →
            </button>
          ) : null,
      },
      {
        headerName: "Filed",
        field: "filed_at",
        width: 150,
        sort: "asc",
        valueFormatter: (p) => new Date(p.value as string).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        filter: "agDateColumnFilter",
        filterValueGetter: (p) => new Date(p.data!.filed_at),
      },
      {
        headerName: "Via",
        field: "filed_via",
        width: 150,
        valueFormatter: (p) => (p.value === "agent" ? `assistant${p.data?.agent_name ? `: ${p.data.agent_name}` : ""}` : "web"),
      },
      {
        headerName: "Verified",
        field: "verified",
        width: 115,
        cellDataType: false,
        valueFormatter: (p) => (p.value ? "✓ verified" : "unverified"),
        getQuickFilterText: (p) => (p.value ? "verified" : "unverified"),
        cellClass: (p) => (p.value ? "good-text" : "bad-text"),
      },
      { headerName: "Email", field: "email", width: 230 },
      { headerName: "Address", field: "address", width: 250 },
      { headerName: "Network", field: "network", width: 120, valueFormatter: (p) => `${p.value}.*`, cellClass: "mono" },
      { headerName: "Device", field: "device", width: 110, valueFormatter: (p) => (p.value as string).slice(0, 8), cellClass: "mono" },
      { headerName: "Story", field: "narrative", width: 360, tooltipField: "narrative" },
      {
        headerName: "Amount",
        field: "amount_cents",
        width: 120,
        type: "numericColumn",
        filter: "agNumberColumnFilter",
        valueFormatter: (p) => (p.value == null ? "" : money(p.value as number, props.currency)),
      },
      { headerName: "Asked for review", field: "appeal_message", width: 260, tooltipField: "appeal_message" },
      {
        headerName: "Truth (demo)",
        field: "demo_truth",
        width: 170,
        hide: !props.reveal,
        valueFormatter: (p) => (p.value ? (p.value as string).replace(":", " · ") : ""),
        cellClass: (p) => ((p.value as string | null)?.startsWith("ring") ? "bad-text" : "good-text"),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.reveal, props.currency],
  );

  if (error) return <p className="notice error">{error}</p>;
  if (!rows) return <p className="muted small">Loading every claim…</p>;

  return (
    <div className="claims-grid">
      <div className="grid-toolbar">
        <input
          className="text-input"
          type="search"
          placeholder="Search every column: an email, a street, a device, a status…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search claims"
        />
        <span className="muted small">{(shown ?? rows.length).toLocaleString("en-US")} of {rows.length.toLocaleString("en-US")} claims</span>
        <button className="secondary" onClick={() => grid.current?.api.exportDataAsCsv({ fileName: "rightful-claims.csv" })}>
          Export CSV
        </button>
      </div>
      <div style={{ height: 520 }}>
        <AgGridReact<AdminClaim>
          ref={grid}
          theme={isDark ? dark : light}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          quickFilterText={search}
          getRowId={(p) => p.data.id}
          rowClassRules={{
            "row-denied": (p: RowClassParams<AdminClaim>) => p.data?.status === "denied",
            "row-held": (p: RowClassParams<AdminClaim>) => p.data?.status === "held",
          }}
          tooltipShowDelay={300}
          animateRows={false}
          onModelUpdated={(e) => setShown(e.api.getDisplayedRowCount())}
        />
      </div>
    </div>
  );
}
