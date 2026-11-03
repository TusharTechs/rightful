/**
 * What a claims program sees about each claim, and the normalizers that make rings show.
 *
 * A ring beats "one claim per PayPal account" by farming accounts, so the account itself is not a
 * signal. What leaks is everything around it: the device, a mailbox that only differs by dots or a
 * `+tag`, a building with a different unit number on each claim, a narrative filled in from one
 * template. These functions turn those variants into keys that collide.
 */

export interface ClaimSignals {
  id: string;
  /** Per-program pseudonym of the PayPal account that signed in (see `src/engine/human.ts`). */
  humanTag: string;
  verified: boolean;
  email: string;
  address: string;
  ip: string;
  /** Device fingerprint hash. */
  device: string;
  /** Milliseconds since the epoch. */
  filedAt: number;
  narrative: string;
}

/** Public webmail: sharing one of these says nothing. Sharing any other mail domain is a weak signal. */
export const WEBMAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com", "yandex.com"]);

/** Mailboxes that ignore dots in the local part. Every provider here also ignores `+tags`. */
const DOT_BLIND = new Set(["gmail.com"]);
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };

export function canonicalEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return email.trim().toLowerCase();
  const rawDomain = email.slice(at + 1).trim().toLowerCase();
  const domain = DOMAIN_ALIASES[rawDomain] ?? rawDomain;
  let local = email.slice(0, at).trim().toLowerCase().split("+")[0] ?? "";
  if (DOT_BLIND.has(domain)) local = local.replaceAll(".", "");
  return `${local}@${domain}`;
}

const STREET_WORDS: Record<string, string> = {
  street: "st", str: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln",
  boulevard: "blvd", court: "ct", place: "pl", terrace: "ter", circle: "cir", highway: "hwy",
  parkway: "pkwy", north: "n", south: "s", east: "e", west: "w",
};
/** The claim's mail domain, or "" for public webmail. */
export function privateDomain(email: string): string {
  const domain = canonicalEmail(email).split("@")[1] ?? "";
  return WEBMAIL.has(domain) ? "" : domain;
}

const UNIT_WORDS = new Set(["apt", "apartment", "unit", "suite", "ste", "no", "rm", "room", "fl", "floor", "#"]);

/**
 * `full` keeps the unit, so a household collides with itself; `building` drops it, so
 * "12 Oak Street Apt 3" and "12 oak st. #14" land together.
 */
export function canonicalAddress(address: string): { full: string; building: string } {
  const tokens = address
    .toLowerCase()
    .replaceAll("#", " # ")
    .replace(/[^a-z0-9# ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => STREET_WORDS[token] ?? token);
  const full: string[] = [];
  const building: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (UNIT_WORDS.has(token) && i + 1 < tokens.length) {
      full.push("unit", tokens[++i]!);
      continue;
    }
    full.push(token);
    building.push(token);
  }
  return { full: full.join(" "), building: building.join(" ") };
}

/** The /24 an IPv4 address sits in. */
export function ipPrefix(ip: string): string {
  return ip.split(".").slice(0, 3).join(".");
}

/** Word bigrams: robust to a swapped name or date, sensitive to a shared template. */
export function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  if (words.length === 1) out.add(words[0]!);
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** MinHash signature: two sets agree on each slot with probability equal to their Jaccard index. */
export function minhash(set: Set<string>, slots: number): Uint32Array {
  const signature = new Uint32Array(slots).fill(0xffffffff);
  for (const item of set) {
    const base = fnv1a(item);
    for (let s = 0; s < slots; s++) {
      const h = mix(base ^ Math.imul(s + 1, 0x9e3779b9));
      if (h < signature[s]!) signature[s] = h;
    }
  }
  return signature;
}
