/**
 * A synthetic claims program with known rings, for measuring the detector.
 *
 * Genuine claimants include the people a naive rule would ban: households that share an address,
 * a laptop and a router; students on a campus network living in the same dorm; and people who paste
 * the program's sample text. Rings come in four kinds, from easy to impossible:
 *
 * - `device-farm`: many accounts driven from one to three devices, through rotating proxies.
 * - `address-mill`: one or two buildings with a new unit on every claim, and Gmail dot and `+tag`
 *   variants of a few mailboxes.
 * - `template-crew`: everything distinct except a fill-in-the-blanks narrative, filed in sessions.
 * - `quiet`: distinct everything, own words, filed over weeks. Built to evade; it sets the ceiling.
 *
 * Everything is fictional and deterministic in `seed`. No real person, address or account appears.
 */

import { type ClaimSignals, canonicalEmail } from "./signals.ts";

export type RingKind = "device-farm" | "address-mill" | "template-crew" | "quiet";
export type GenuineKind = "solo" | "household" | "campus" | "sample-text";

export interface Truth {
  ring: string | null;
  kind: RingKind | GenuineKind;
}

export interface ProgramOptions {
  seed: string;
  claims: number;
  /** Share of claims filed by rings, 0..1. */
  ringShare: number;
  startAt: number;
  windowDays: number;
}

export interface SyntheticProgram {
  sampleText: string;
  claims: ClaimSignals[];
  truth: Map<string, Truth>;
  rings: Array<{ id: string; kind: RingKind; size: number }>;
}

export const SAMPLE_TEXT = "I purchased the filter pitcher or replacement filters between 2019 and 2024 for personal use.";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

export function generateProgram(options: Partial<ProgramOptions> = {}): SyntheticProgram {
  const opts: ProgramOptions = { seed: "1", claims: 5000, ringShare: 0.3, startAt: Date.UTC(2026, 8, 1), windowDays: 60, ...options };
  const r = rng(opts.seed);
  const end = opts.startAt + opts.windowDays * DAY;
  const drafts: Array<Omit<ClaimSignals, "id"> & { truth: Truth }> = [];
  const rings: SyntheticProgram["rings"] = [];

  const account = (verifiedRate: number) => ({ humanTag: r.hex(64), verified: r.chance(verifiedRate) });
  // Two people never share a mailbox; only rings reuse one.
  const taken = new Set<string>();
  const ownEmail = (first: string, last: string) => {
    let email = personalEmail(r, first, last);
    while (taken.has(canonicalEmail(email))) email = email.replace("@", String(r.int(0, 9)) + "@");
    taken.add(canonicalEmail(email));
    return email;
  };
  const genuineTime = () => {
    // A news story on day 20 brings a two-day surge, so bursts alone mean nothing.
    const day = r.chance(0.2) ? 20 + r.next() * 2 : r.next() * opts.windowDays;
    const evening = r.chance(0.6) ? 17 + r.next() * 6 : r.next() * 24;
    return Math.min(end - 1, opts.startAt + Math.floor(day) * DAY + Math.floor(evening * HOUR));
  };

  const ringTotal = Math.round(opts.claims * opts.ringShare);
  let ringClaims = 0;
  while (ringClaims < ringTotal) {
    const kind = r.weighted<RingKind>([["device-farm", 3], ["address-mill", 2.5], ["template-crew", 3], ["quiet", 1.5]]);
    const range = { "device-farm": [10, 60], "address-mill": [5, 25], "template-crew": [8, 40], quiet: [4, 12] }[kind];
    const size = Math.min(ringTotal - ringClaims, r.int(range[0]!, range[1]!));
    const id = `truth_${String(rings.length + 1).padStart(3, "0")}`;
    rings.push({ id, kind, size });
    ringClaims += size;
    const truth = { ring: id, kind };
    const template = ringTemplate(r);
    const sessions = sessionTimes(r, opts.startAt, end, kind === "template-crew" ? r.int(2, 5) : r.int(1, 3));
    const devices = Array.from({ length: r.int(1, 3) }, () => r.hex(16));
    const buildings = Array.from({ length: r.int(1, 2) }, () => streetLine(r, false));
    const networks = Array.from({ length: r.int(2, 4) }, () => network(r));
    const roots = Array.from({ length: r.int(2, 4) }, () => `${r.pick(FIRST)}${r.pick(LAST)}${r.int(1, 99)}`);
    const catchAll = `${r.pick(WORDS)}${r.pick(WORDS)}.example`;
    const city = cityLine(r);

    for (let k = 0; k < size; k++) {
      const base = { ...account(0.8), truth };
      if (kind === "device-farm") {
        drafts.push({
          ...base,
          email: `${r.letters(r.int(6, 10))}${r.int(10, 9999)}@gmail.com`,
          address: `${streetLine(r, r.chance(0.3))}, ${cityLine(r)}`,
          ip: residentialIp(r),
          device: r.pick(devices),
          filedAt: inSession(r, sessions, r.int(2, 6) * HOUR),
          narrative: template(),
        });
      } else if (kind === "address-mill") {
        drafts.push({
          ...base,
          email: r.chance(0.7) ? mailboxVariant(r, r.pick(roots)) : `${r.letters(8)}${r.int(10, 999)}@gmail.com`,
          address: `${restyle(r, r.pick(buildings))} ${unit(r)}, ${city}`,
          ip: `${r.pick(networks)}.${r.int(2, 254)}`,
          device: r.hex(16),
          filedAt: opts.startAt + Math.floor(r.next() * Math.min(opts.windowDays, r.int(1, 10)) * DAY) + r.int(0, 23) * HOUR,
          narrative: genuineNarrative(r),
        });
      } else if (kind === "template-crew") {
        drafts.push({
          ...base,
          email: `${r.pick(WORDS)}.${r.pick(WORDS)}${r.int(1, 999)}@${catchAll}`,
          address: `${streetLine(r, r.chance(0.3))}, ${cityLine(r)}`,
          ip: residentialIp(r),
          device: r.hex(16),
          filedAt: inSession(r, sessions, r.int(30, 90) * MINUTE),
          narrative: template(),
        });
      } else {
        drafts.push({
          ...base,
          email: `${r.pick(FIRST).toLowerCase()}.${r.pick(LAST).toLowerCase()}@${catchAll}`,
          address: `${streetLine(r, r.chance(0.3))}, ${cityLine(r)}`,
          ip: residentialIp(r),
          device: r.hex(16),
          filedAt: genuineTime(),
          narrative: genuineNarrative(r),
        });
      }
    }
  }

  // About fifty claimants per campus whatever the program's size: one dorm, not a city.
  const campuses = Array.from({ length: Math.max(1, Math.round(opts.claims / 830)) }, () => ({ network: network(r), dorm: `${r.int(1, 9)}00 ${r.pick(LAST)} Hall`, city: cityLine(r) }));
  while (drafts.length < opts.claims) {
    const kind = r.weighted<GenuineKind>([["solo", 70], ["household", 12], ["campus", 6], ["sample-text", 12]]);
    const truth = { ring: null, kind };
    const last = r.pick(LAST);
    if (kind === "household") {
      const size = Math.min(opts.claims - drafts.length, r.int(2, 4));
      const address = `${streetLine(r, r.chance(0.3))}, ${cityLine(r)}`;
      const home = residentialIp(r);
      const laptop = r.hex(16);
      const evening = genuineTime();
      for (let k = 0; k < size; k++) {
        drafts.push({
          ...account(0.9),
          truth,
          email: ownEmail(r.pick(FIRST), last),
          address,
          ip: r.chance(0.85) ? home : residentialIp(r),
          device: r.chance(0.4) ? laptop : r.hex(16),
          filedAt: r.chance(0.6) ? evening + r.int(0, 90) * MINUTE : genuineTime(),
          narrative: r.chance(0.15) ? SAMPLE_TEXT : genuineNarrative(r),
        });
      }
      continue;
    }
    const campus = r.pick(campuses);
    drafts.push({
      ...account(0.9),
      truth,
      email: ownEmail(r.pick(FIRST), last),
      address: kind === "campus" && r.chance(0.5) ? `${campus.dorm} Room ${r.int(100, 450)}, ${campus.city}` : `${streetLine(r, r.chance(0.3))}, ${cityLine(r)}`,
      ip: kind === "campus" ? `${campus.network}.${r.int(2, 254)}` : residentialIp(r),
      device: r.hex(16),
      filedAt: genuineTime(),
      narrative: kind === "sample-text" ? (r.chance(0.6) ? SAMPLE_TEXT : `${SAMPLE_TEXT} ${r.pick(PERSONAL)(r)}`) : genuineNarrative(r),
    });
  }

  const order = r.shuffle(drafts.map((_, i) => i));
  const claims: ClaimSignals[] = [];
  const truth = new Map<string, Truth>();
  order.forEach((index, position) => {
    const { truth: t, ...signals } = drafts[index]!;
    const id = `clm_${String(position + 1).padStart(6, "0")}`;
    claims.push({ id, ...signals });
    truth.set(id, t);
  });
  return { sampleText: SAMPLE_TEXT, claims, truth, rings };
}

// --- randomness ---------------------------------------------------------------------------------

export interface Rng {
  next(): number;
  int(lo: number, hi: number): number;
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  weighted<T>(options: ReadonlyArray<readonly [T, number]>): T;
  shuffle<T>(list: T[]): T[];
  hex(length: number): string;
  letters(length: number): string;
}

/** mulberry32 seeded from an FNV-1a hash of the seed string. */
export function rng(seed: string): Rng {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193);
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const self: Rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)]!,
    weighted: (options) => {
      let roll = next() * options.reduce((sum, [, w]) => sum + w, 0);
      for (const [value, w] of options) if ((roll -= w) < 0) return value;
      return options[options.length - 1]![0];
    },
    shuffle: (list) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      return list;
    },
    hex: (length) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join(""),
    letters: (length) => Array.from({ length }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(next() * 26)]).join(""),
  };
  return self;
}

// --- people and places --------------------------------------------------------------------------

const FIRST = ["Avery", "Blake", "Casey", "Dana", "Eli", "Frankie", "Gray", "Harper", "Indy", "Jules", "Kai", "Lane", "Morgan", "Noor", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Tatum", "Uma", "Vic", "Wren", "Yael", "Zion", "Ari", "Bo", "Cam", "Devi", "Ember", "Finn", "Gia", "Hollis", "Ira", "Jody", "Kit", "Lior", "Mika", "Nico", "Remy"];
const LAST = ["Abara", "Bellweather", "Castellan", "Dunmore", "Eskildsen", "Fairbrook", "Galloway", "Halvorsen", "Ibarra", "Jarrow", "Kestrel", "Lindqvist", "Marchetti", "Nakashima", "Okonkwo", "Penhallow", "Quarry", "Rasmussen", "Stellan", "Thornbury", "Ulloa", "Vasquez", "Whitlock", "Yarrow", "Zelenko", "Ashdown", "Brightwater", "Calloway", "Dervish", "Eberly", "Fenwick", "Greaves", "Hawthorne", "Islington", "Juniper", "Kowalczyk", "Larkspur", "Merriweather", "Northcott", "Oyelaran"];
const STREETS = ["Oak", "Maple", "Cedar", "Willow", "Juniper", "Birch", "Aspen", "Linden", "Hawthorn", "Sycamore", "Chestnut", "Magnolia", "Laurel", "Alder", "Hickory", "Poplar", "Spruce", "Sequoia", "Cypress", "Elm", "Rowan", "Hazel", "Larch", "Tamarack", "Mulberry", "Orchard", "Meadow", "Ridge", "Harbor", "Summit"];
const SUFFIXES = ["Street", "Avenue", "Road", "Drive", "Lane", "Court", "Place", "Boulevard", "Terrace", "Way"];
const CITIES: Array<[string, string, number]> = [["Fairhaven", "OR", 97001], ["Millbrook", "OH", 43001], ["Cedar Falls", "TX", 75001], ["Riverton", "GA", 30001], ["Lakeside", "MI", 48001], ["Pinecrest", "NC", 27001], ["Brookfield", "AZ", 85001], ["Ashford", "PA", 15001], ["Glenwood", "CO", 80001], ["Harborview", "WA", 98001], ["Northfield", "MN", 55001], ["Westbury", "NY", 10001], ["Sunnyvale", "FL", 32001], ["Oakridge", "TN", 37001], ["Marlow", "IL", 60001], ["Kingsport", "VA", 22001], ["Elmwood", "WI", 53001], ["Stonebridge", "MO", 63001], ["Clearwater", "NV", 89001], ["Redfield", "IN", 46001]];
const WORDS = ["blue", "fox", "nova", "orbit", "pine", "quill", "rapid", "solar", "tide", "umber", "vale", "wisp", "zenith", "amber", "brisk", "coral", "delta", "ember", "flint", "glade"];
const WEBMAIL = ["gmail.com", "gmail.com", "gmail.com", "gmail.com", "yahoo.com", "outlook.com", "icloud.com", "hotmail.com", "aol.com"];

function cityLine(r: Rng): string {
  const [city, state, zip] = r.pick(CITIES);
  return `${city}, ${state} ${zip + r.int(0, 98)}`;
}

function streetLine(r: Rng, withUnit: boolean): string {
  const line = `${r.int(1, 9899)} ${r.pick(STREETS)} ${r.pick(SUFFIXES)}`;
  return withUnit ? `${line} ${unit(r)}` : line;
}

function unit(r: Rng): string {
  const n = `${r.int(1, 40)}${r.chance(0.3) ? r.pick(["A", "B", "C"]) : ""}`;
  return r.pick([`Apt ${n}`, `Apt. ${n}`, `#${n}`, `Unit ${n}`, `Suite ${n}`]);
}

/** The same street line, typed differently: "12 Oak Street" → "12 oak st." */
function restyle(r: Rng, line: string): string {
  let out = line;
  if (r.chance(0.5)) out = out.replace(/\b(Street|Avenue|Road|Drive|Lane|Court|Place|Boulevard|Terrace)\b/, (word) => ({ Street: "St", Avenue: "Ave", Road: "Rd", Drive: "Dr", Lane: "Ln", Court: "Ct", Place: "Pl", Boulevard: "Blvd", Terrace: "Ter" })[word]! + (r.chance(0.5) ? "." : ""));
  if (r.chance(0.3)) out = out.toLowerCase();
  return out;
}

function personalEmail(r: Rng, first: string, last: string): string {
  const [f, l] = [first.toLowerCase(), last.toLowerCase()];
  const local = r.pick([`${f}.${l}`, `${f}${l}${r.int(1, 99)}`, `${f[0]}${l}`, `${f}_${l}`, `${f}.${l}${r.int(1, 999)}`]);
  const domain = r.chance(0.15) ? `${r.pick(WORDS)}-net.example` : r.pick(WEBMAIL);
  return `${local}@${domain}`;
}

/** A Gmail root dressed up as a new mailbox: dots moved, case changed, a `+tag` added. */
function mailboxVariant(r: Rng, root: string): string {
  let local = root.toLowerCase();
  const dots = r.int(0, 2);
  for (let k = 0; k < dots; k++) {
    const at = r.int(1, local.length - 1);
    if (local[at - 1] !== "." && local[at] !== ".") local = `${local.slice(0, at)}.${local.slice(at)}`;
  }
  if (r.chance(0.5)) local = `${local}+${r.pick(WORDS)}${r.int(1, 99)}`;
  if (r.chance(0.3)) local = local[0]!.toUpperCase() + local.slice(1);
  return `${local}@${r.chance(0.1) ? "googlemail.com" : "gmail.com"}`;
}

function residentialIp(r: Rng): string {
  return `${network(r)}.${r.int(2, 254)}`;
}

function network(r: Rng): string {
  return `${r.int(24, 223)}.${r.int(0, 255)}.${r.int(0, 255)}`;
}

function sessionTimes(r: Rng, start: number, end: number, count: number): number[] {
  return Array.from({ length: count }, () => start + Math.floor(r.next() * (end - start - 6 * HOUR)));
}

function inSession(r: Rng, sessions: number[], length: number): number {
  return r.pick(sessions) + Math.floor(r.next() * length);
}

// --- narratives ---------------------------------------------------------------------------------

type Phrase = (r: Rng) => string;

const STORES = ["the grocery store", "a big-box store", "the pharmacy", "an online marketplace", "the hardware store", "a warehouse club", "the corner market", "a department store", "the co-op", "a discount store"];
const ITEMS = ["the filter pitcher", "the pitcher", "replacement filters", "a two-pack of filters", "the large pitcher", "the starter kit", "filter cartridges"];
const year = (r: Rng) => String(r.int(2019, 2024));
const month = (r: Rng) => r.pick(["January", "March", "April", "June", "July", "August", "October", "November", "December", "the spring", "the summer", "the fall"]);

const PURCHASE: Phrase[] = [
  (r) => `I bought ${r.pick(ITEMS)} at ${r.pick(STORES)} in ${month(r)} ${year(r)}.`,
  (r) => `We picked up ${r.pick(ITEMS)} from ${r.pick(STORES)} around ${year(r)}.`,
  (r) => `My first purchase was ${r.pick(ITEMS)} in ${year(r)} and I kept buying refills after that.`,
  (r) => `I have bought ${r.pick(ITEMS)} maybe ${r.int(3, 15)} times since ${year(r)}.`,
  (r) => `Got ${r.pick(ITEMS)} as a gift in ${year(r)}, then bought ${r.pick(ITEMS)} myself.`,
  (r) => `I ordered ${r.pick(ITEMS)} online in ${month(r)} of ${year(r)}.`,
  (r) => `Bought it at ${r.pick(STORES)}, I think in ${year(r)}, receipt is long gone.`,
  (r) => `${year(r)} is when we switched to ${r.pick(ITEMS)} from bottled water.`,
];
const USE: Phrase[] = [
  () => "We used it every day for drinking and cooking.",
  (r) => `It sat on the counter and we refilled it ${r.int(2, 6)} times a day.`,
  () => "I mostly used it for the kids' water bottles.",
  () => "Used it for coffee and for the dog's bowl too.",
  (r) => `I changed the filter about every ${r.int(1, 4)} months like the box said.`,
  () => "My partner and I relied on it because our tap water tastes bad.",
  () => "Honestly I trusted it completely and stopped buying bottled water.",
  (r) => `It was the only water we drank at home for ${r.int(2, 5)} years.`,
];
const PROBLEM: Phrase[] = [
  () => "Then I read that the filters did not remove what the box claimed.",
  () => "I found out from the news that the label was misleading.",
  () => "Later we learned the lead claim on the package was not true.",
  (r) => `In ${year(r)} I saw a report saying the filters were not certified the way they said.`,
  () => "I feel like I paid extra for protection that was not real.",
  () => "Our water test came back worse than expected even with the filter.",
  () => "I would never have paid that price if I had known.",
  () => "A friend sent me the article about the lawsuit and I was upset.",
];
const PERSONAL: Phrase[] = [
  (r) => `We have ${r.int(1, 4)} kids so this matters to us.`,
  () => "I am pregnant and was specifically worried about lead.",
  () => "We live in an old house with old pipes.",
  (r) => `I spent probably $${r.int(40, 300)} on filters over the years.`,
  () => "I still have one of the empty boxes in the garage.",
  () => "My elderly mother lives with us and drinks a lot of water.",
  () => "Thank you for setting this up.",
  (r) => `I can send a photo of the pitcher if needed, it is the ${r.pick(["blue", "white", "grey", "clear"])} one.`,
];

const OPENERS = ["Honestly", "Looking back", "For what it is worth", "To be clear", "Also", "Just so you know", "On top of that", "Funny thing is", "Anyway", "If it helps"];
const SUBJECTS = ["my husband", "my wife", "my roommate", "my son", "my daughter", "my dad", "our neighbor", "my sister", "my grandmother", "my coworker", "my partner", "my brother"];
const VERBS = ["still asks about", "first told me about", "was the one who bought", "complained about", "kept refilling", "threw out", "laughed at", "still uses", "never trusted", "recommended"];
const OBJECTS = ["that pitcher", "the filters", "the whole thing", "the brand", "the refills", "the box with the lead claim", "the starter kit", "the big jug"];
const WHEN = ["every single week", "back in college", "after we moved", "when the baby came", "during lockdown", "before the recall news", "for years", "at the old apartment", "until last spring", "on every grocery run"];

/** A sentence only this person would write: the part of real claims that never repeats. */
function ownWords(r: Rng): string {
  return `${r.pick(OPENERS)}, ${r.pick(SUBJECTS)} ${r.pick(VERBS)} ${r.pick(OBJECTS)} ${r.pick(WHEN)}.`;
}

function genuineNarrative(r: Rng): string {
  const parts = [r.pick(PURCHASE)(r), r.pick(USE)(r)];
  if (r.chance(0.8)) parts.push(r.pick(PROBLEM)(r));
  if (r.chance(0.5)) parts.push(r.pick(PERSONAL)(r));
  if (r.chance(0.85)) parts.push(ownWords(r));
  if (r.chance(0.35)) parts.push(ownWords(r));
  return r.shuffle(parts.slice(1)).reduce((text, part) => `${text} ${part}`, parts[0]!);
}

/** One operator's fill-in-the-blanks script: fixed sentences, a few swapped words, the odd typo. */
function ringTemplate(r: Rng): () => string {
  const sentences = [r.pick(PURCHASE), r.pick(USE), r.pick(PROBLEM), r.pick(PERSONAL)].map((phrase) => phrase(r));
  const swaps = [STORES, ITEMS].flatMap((list) => list.filter((word) => sentences.some((s) => s.includes(word))));
  return () => {
    let text = sentences.join(" ");
    for (const word of swaps) if (r.chance(0.3)) text = text.replace(word, r.pick(STORES.includes(word) ? STORES : ITEMS));
    text = text.replace(/\b(20\d\d)\b/, () => year(r));
    if (r.chance(0.2)) text = text.replace(/ the /, " teh ");
    return text;
  };
}
