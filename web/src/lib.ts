/** Small helpers shared by the pages. */

import { useEffect, useRef, useState } from "react";

export function money(cents: number, currency = "USD"): string {
  // en-US so USD reads "$45.00" everywhere, not "US$45.00" in other locales.
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export function short(id: string | null | undefined, keep = 6): string {
  if (!id) return "—";
  const [prefix, rest] = id.includes("_") ? [id.slice(0, id.indexOf("_") + 1), id.slice(id.indexOf("_") + 1)] : ["", id];
  return `${prefix}${rest.slice(0, keep)}…`;
}

/** Calls `load` now and every `ms` until `stop(result)` is true. */
export function usePoll<T>(load: () => Promise<T>, ms: number, stop: (value: T) => boolean = () => false, deps: unknown[] = []) {
  const [value, setValue] = useState<T | undefined>();
  const [error, setError] = useState<Error | undefined>();
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const next = await load();
        if (!alive) return;
        setValue(next);
        setError(undefined);
        if (stopRef.current(next)) return;
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      }
      timer = setTimeout(run, ms);
    };
    run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { value, error };
}

/** A clock that ticks every second, corrected by the server's clock when one is given. */
export function useNow(serverTime?: string): number {
  const [now, setNow] = useState(() => Date.now());
  const skew = useRef(0);
  useEffect(() => {
    if (serverTime) skew.current = new Date(serverTime).getTime() - Date.now();
  }, [serverTime]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  return now + skew.current;
}

export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${sec}s`;
}

export function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
