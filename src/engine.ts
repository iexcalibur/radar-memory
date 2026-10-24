import type { MemoryStore, MessageSource } from "./adapters.js";
import { contextFor, DEFAULTS, type Deps, type Options } from "./context.js";
import { correctPoint, removeMessage, setTopicState, unlinkTopics } from "./judgment.js";
import type { Model } from "./model.js";
import { readPlace } from "./reader.js";
import { sweep } from "./sweep.js";
import type { Status, Topic, TopicItem } from "./types.js";

export interface Memory {
  /** Call this often (on a timer, on each page view, after messages arrive): reads every place
   *  where a burst has ended since the last read, closes topics untouched for `staleMs`, and runs
   *  the slow sweep when it's due. Returns how many messages it read. `quietMs: 0` reads everything
   *  now (for a backfill, or before building a summary). */
  tick(userId: string, opts?: { quietMs?: number; maxPlaces?: number; maxBatches?: number }): Promise<number>;
  /** Reads one place now, from where it last stopped. */
  read(userId: string, placeId: string, opts?: { maxBatches?: number }): Promise<number>;
  /** Runs the slow sweep now if it's due, or at once with `force`. */
  sweep(userId: string, opts?: { force?: boolean }): Promise<boolean>;

  /** A person's topics, newest first. */
  topics(userId: string, opts?: { since?: number; state?: Topic["state"]; limit?: number }): Promise<Topic[]>;
  /** Everything waiting on the person: open or promised points marked for them, in active topics. */
  forYou(userId: string): Promise<{ topic: Topic; item: TopicItem }[]>;
  /** The topic a message is in for this person, and the point it raised (if any). */
  topicOf(userId: string, messageId: string): Promise<{ topic: Topic; item: TopicItem | null } | null>;

  /** The judgment layer. Every correction is kept and becomes a lesson the reader learns from. */
  correctPoint(userId: string, topicId: string, itemId: string, status: Status | "dismiss"): Promise<Topic>;
  removeMessage(userId: string, topicId: string, messageId: string): Promise<Topic>;
  setTopicState(userId: string, topicId: string, state: Topic["state"]): Promise<Topic>;
  unlinkTopics(userId: string, a: string, b: string): Promise<[Topic, Topic]>;
}

/** Builds the engine from your messages, a store for memory, and a model. */
export function createMemory(cfg: { source: MessageSource; store: MemoryStore; model: Model; options?: Partial<Options>; debug?: Deps["debug"] }): Memory {
  const deps: Deps = { source: cfg.source, store: cfg.store, model: cfg.model, options: { ...DEFAULTS, ...cfg.options }, debug: cfg.debug };
  const o = deps.options;

  return {
    async tick(userId, opts = {}) {
      const quiet = opts.quietMs ?? o.quietMs;
      const now = Date.now();
      const ctx = await contextFor(deps, userId);
      const ids = [...ctx.places.keys()];
      if (ids.length === 0) return 0;
      const [latest, cursors] = await Promise.all([deps.source.latestAt(ids), Promise.all(ids.map((id) => deps.store.cursor(userId, id)))]);
      const readTo = new Map(ids.map((id, i) => [id, cursors[i]?.lastAt ?? now - o.staleMs]));
      const due = ids.filter((id) => {
        const last = latest.get(id);
        return last !== undefined && last > readTo.get(id)! && now - last >= quiet;
      });
      let read = 0;
      for (const id of due.slice(0, opts.maxPlaces ?? 3)) read += await readPlace(deps, userId, id, { ctx, maxBatches: opts.maxBatches });
      // topics untouched for a while close; the slow sweep looks across the rest
      for (const t of await deps.store.topics(userId, { state: "active" })) if (t.state === "active" && t.lastAt < now - o.staleMs) await deps.store.saveTopic({ ...t, state: "closed", updatedAt: now });
      await sweep(deps, userId, { ctx });
      return read;
    },
    read: (userId, placeId, opts) => readPlace(deps, userId, placeId, opts),
    sweep: (userId, opts) => sweep(deps, userId, opts),

    topics: (userId, opts) => deps.store.topics(userId, opts),
    async forYou(userId) {
      const out: { topic: Topic; item: TopicItem }[] = [];
      for (const topic of await deps.store.topics(userId, { state: "active" })) for (const item of topic.items) if (item.forYou && (item.status === "open" || item.status === "promised")) out.push({ topic, item });
      return out;
    },
    async topicOf(userId, messageId) {
      for (const topic of await deps.store.topics(userId)) if (topic.messageIds.includes(messageId)) return { topic, item: topic.items.find((i) => i.refs.includes(messageId)) ?? null };
      return null;
    },

    correctPoint: (userId, topicId, itemId, status) => correctPoint(deps, userId, topicId, itemId, status),
    removeMessage: (userId, topicId, messageId) => removeMessage(deps, userId, topicId, messageId),
    setTopicState: (userId, topicId, state) => setTopicState(deps, userId, topicId, state),
    unlinkTopics: (userId, a, b) => unlinkTopics(deps, userId, a, b),
  };
}
