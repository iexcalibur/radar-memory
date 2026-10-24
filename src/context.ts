import type { MemoryStore, MessageSource } from "./adapters.js";
import type { Model } from "./model.js";
import type { Person, Place } from "./types.js";
import { dateFor } from "./util.js";

/** Tuning. The defaults are what Sledge runs with. */
export interface Options {
  /** A burst has ended when its place has been quiet this long: then it is read. */
  quietMs: number;
  /** Topics untouched this long close; the reader looks back no further than this. */
  staleMs: number;
  /** New messages read per model call. */
  batch: number;
  /** Earlier messages of the place shown for context: the reverse window. */
  lookBack: number;
  /** Open topics in this place shown in full. */
  hereLimit: number;
  /** Open topics elsewhere shown in full when they share people and specific words. */
  nearbyLimit: number;
  /** Every other open topic, shown on the radar by title and open points. */
  radarSize: number;
  /** How often the slow sweep (merge, split, close) runs per person. */
  sweepEveryMs: number;
  /** A read or sweep holds its lock this long at most. */
  lockMs: number;
  /** The time zone times are written in for the model. */
  timeZone: string;
  /** Lessons from a person's corrections shown on every read. */
  lessonsShown: number;
  /** Log lines kept per topic. */
  logKept: number;
  /** Message ids kept per topic. */
  maxMessagesPerTopic: number;
}

export const DEFAULTS: Options = {
  quietMs: 2 * 60_000,
  staleMs: 7 * 24 * 3600_000,
  batch: 40,
  lookBack: 20,
  hereLimit: 8,
  nearbyLimit: 3,
  radarSize: 40,
  sweepEveryMs: 60 * 60_000,
  lockMs: 3 * 60_000,
  timeZone: "UTC",
  lessonsShown: 15,
  logKept: 40,
  maxMessagesPerTopic: 500,
};

export interface Deps {
  source: MessageSource;
  store: MemoryStore;
  model: Model;
  options: Options;
  /** Called with every prompt and model output, for debugging. */
  debug?: (e: { task: "read" | "sweep"; prompt: string; out: unknown }) => void;
}

/** One person's view while reading: who's who, which places they can see, how times read. */
export interface Ctx {
  userId: string;
  people: Map<string, Person>;
  places: Map<string, Place>;
  date: (ts: number) => string;
}

export async function contextFor(deps: Deps, userId: string): Promise<Ctx> {
  const [places, people] = await Promise.all([deps.source.places(userId), deps.source.people(userId)]);
  return { userId, people: new Map(people.map((p) => [p.id, p])), places: new Map(places.map((p) => [p.id, p])), date: dateFor(deps.options.timeZone) };
}

/** How a place is named to the model: "#product", or "a direct message with Priya". */
export const placeLabel = (p: Place) => (p.kind === "dm" ? `a direct message with ${p.name}` : p.name.startsWith("#") ? p.name : `#${p.name}`);
