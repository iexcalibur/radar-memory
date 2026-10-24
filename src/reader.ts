import { z } from "zod";
import type { Deps } from "./context.js";
import { contextFor, placeLabel, type Ctx } from "./context.js";
import { READER } from "./prompts.js";
import { nearbyTopics } from "./radar.js";
import type { Message, Place, Topic, TopicItem } from "./types.js";
import { clean, excerpt, newId } from "./util.js";

/** The reader: goes over one place for one person, from where it last stopped, a batch at a time.
 *  Each batch is read against the place's recent messages (the reverse window) and against open
 *  topics here and everywhere else (the radar), and the model decides where each message goes and
 *  how each point now stands. Your corrections are always kept. */

const STATUSES = ["open", "promised", "answered", "done", "info"] as const;
export const ReadOut = z.object({
  placement: z.array(z.object({ message: z.string(), why: z.string(), topic: z.string() })),
  moves: z.array(z.object({ message: z.string(), topic: z.string() })),
  topics: z.array(
    z.object({
      ref: z.string(),
      title: z.string(),
      items: z.array(z.object({ ref: z.string(), text: z.string(), status: z.enum(STATUSES), refs: z.array(z.string()), for_you: z.boolean(), why: z.string() })),
      needs: z.string(),
    }),
  ),
  links: z.array(z.object({ a: z.string(), b: z.string(), why: z.string() })),
});
type Out = z.infer<typeof ReadOut>;

/** Reads one place for one person. Returns how many messages it read. */
export async function readPlace(deps: Deps, userId: string, placeId: string, opts: { maxBatches?: number; ctx?: Ctx } = {}): Promise<number> {
  const { store, source, options: o } = deps;
  const cur = await store.cursor(userId, placeId);
  const now = Date.now();
  if (cur?.runningAt && now - cur.runningAt < o.lockMs) return 0; // another reader is on it
  const from = cur?.lastAt ?? now - o.staleMs;
  await store.saveCursor({ userId, key: placeId, lastAt: from, runningAt: now });
  let read = 0;
  let after = from;
  try {
    const ctx = opts.ctx ?? (await contextFor(deps, userId));
    const place = ctx.places.get(placeId);
    if (!place) return 0;
    for (let b = 0; b < (opts.maxBatches ?? 3); b++) {
      const batch = await source.messagesAfter(placeId, after, o.batch);
      if (batch.length === 0) break;
      if (!(await readBatch(deps, ctx, place, batch))) break;
      after = batch[batch.length - 1].createdAt;
      read += batch.length;
      await store.saveCursor({ userId, key: placeId, lastAt: after, runningAt: Date.now() });
      if (batch.length < o.batch) break;
    }
  } finally {
    await store.saveCursor({ userId, key: placeId, lastAt: after, runningAt: 0 }).catch(() => null);
  }
  return read;
}

/** One model call: a batch of new messages in one place, read against memory. */
async function readBatch(deps: Deps, ctx: Ctx, place: Place, batch: Message[]): Promise<boolean> {
  const { store, source, model, options: o } = deps;
  const rootOf = (m: Message) => m.rootId ?? m.id;
  const earlier = await source.messagesBefore(place.id, batch[0].createdAt, batch[0].createdAt - o.staleMs, o.lookBack);
  const open = (await store.topics(ctx.userId, { since: Date.now() - o.staleMs, state: "active", limit: 200 })).filter((t) => t.state === "active");
  const here = open.filter((t) => t.placeIds.includes(place.id)).slice(0, o.hereLimit);
  const nearby = nearbyTopics(open, place.id, batch, ctx.userId, o.nearbyLimit);
  const shownTopics = [...here, ...nearby];
  // the rest of the radar: every other open topic, by title and open points, so a match by meaning
  // (not by shared words) can still be found
  const radar = open.filter((t) => !shownTopics.includes(t)).slice(0, o.radarSize);

  // references the model sees: m1… earlier, n1… new, T1… topics shown in full, R1… on the radar
  const ref = new Map<string, Message>();
  const refOf = new Map<string, string>();
  earlier.forEach((m, i) => (ref.set(`m${i + 1}`, m), refOf.set(m.id, `m${i + 1}`)));
  batch.forEach((m, i) => (ref.set(`n${i + 1}`, m), refOf.set(m.id, `n${i + 1}`)));
  const topicRef = new Map<string, Topic>();
  shownTopics.forEach((t, i) => topicRef.set(`T${i + 1}`, t));
  radar.forEach((t, i) => topicRef.set(`R${i + 1}`, t));
  const tRefOf = new Map([...topicRef].map(([r, t]) => [t.id, r]));
  const inTopic = new Map<string, string>();
  for (const t of shownTopics) for (const id of t.messageIds) inTopic.set(id, tRefOf.get(t.id)!);
  const convOf = new Map<string, string>();
  for (const m of [...earlier, ...batch]) if (!convOf.has(rootOf(m))) convOf.set(rootOf(m), `c${convOf.size + 1}`);

  const name = (id: string) => (id === ctx.userId ? `${ctx.people.get(id)?.name ?? "The reader"} (the reader)` : (ctx.people.get(id)?.name ?? "Someone"));
  const first = (id: string) => ctx.people.get(id)?.name.split(" ")[0] ?? "someone";
  const line = (r: string, m: Message) => {
    const l = m.label;
    const tag = l?.kind ? ` (${l.kind}${l.waitingOn?.length ? `, waiting on ${l.waitingOn.map(first).join(" and ")}` : ""})` : "";
    const where = inTopic.get(m.id) ? ` [in ${inTopic.get(m.id)}]` : "";
    return `[${r}] conv ${convOf.get(rootOf(m))} ${ctx.date(m.createdAt)} ${name(m.authorId)}${m.parentId ? ", in a thread" : ""}${tag}${where}: ${excerpt(m.text, 500).replace(/\s+/g, " ")}`;
  };
  const placeName = (t: Topic) => t.placeIds.map((p) => (p === place.id ? "here" : ctx.places.get(p) ? placeLabel(ctx.places.get(p)!) : null)).filter(Boolean).join(" and ");
  const topicLines = shownTopics.map((t) => {
    const r = tRefOf.get(t.id)!;
    const pts = t.items.map((it, i) => `  [${r}.i${i + 1}] ${it.status}${it.pinned ? " (set by the reader: keep)" : ""}${it.forYou ? ", for you" : ""}: ${it.text}`);
    return [`[${r}] in ${placeName(t)}: ${t.title}`, ...(t.needs ? [`  For you: ${t.needs}`] : []), ...pts].join("\n");
  });
  const radarLines = radar.map((t) =>
    [`[${tRefOf.get(t.id)}] in ${placeName(t)}: ${t.title}`, ...t.items.filter((i) => i.status === "open" || i.status === "promised").slice(0, 8).map((i) => `  - ${excerpt(i.text, 70)}`)].join("\n"),
  );
  const lessons = (await store.lessons(ctx.userId, o.lessonsShown)).map((l) => l.text).reverse();
  const prompt = [
    `Reader: ${ctx.people.get(ctx.userId)?.name ?? "the reader"}`,
    lessons.length ? `Lessons from the reader's own corrections (judge similar cases the same way):\n${lessons.map((l) => `- ${l}`).join("\n")}` : "",
    `Place: ${placeLabel(place)}`,
    `Open topics:\n${topicLines.join("\n") || "none yet"}`,
    radarLines.length ? `Other open topics, title and open points only (the radar):\n${radarLines.join("\n")}` : "",
    `Earlier messages here, already in memory, for context only, oldest first:\n${earlier.map((m) => line(refOf.get(m.id)!, m)).join("\n") || "none"}`,
    `New messages to place, oldest first:\n${batch.map((m) => line(refOf.get(m.id)!, m)).join("\n")}`,
    `Place all ${batch.length} new messages (n1 to n${batch.length}).`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const out = await model.structured({ task: "read", system: READER, prompt, schema: ReadOut, effort: "low", maxTokens: 6000 });
  if (!out) return false;
  deps.debug?.({ task: "read", prompt, out });
  await apply(deps, ctx, place, out, { ref, topicRef });
  return true;
}

/** Writes what the model decided: messages into topics, points and their statuses, links, and a
 *  line in each topic's log for every change. */
async function apply(deps: Deps, ctx: Ctx, place: Place, out: Out, refs: { ref: Map<string, Message>; topicRef: Map<string, Topic> }) {
  const { store, options: o } = deps;
  const now = Date.now();
  const msgOf = (r: string) => refs.ref.get(clean(r));
  const shown = [...refs.topicRef.values()];
  const byId = (id: string) => shown.find((x) => x.id === id);
  const idOf = new Map<string, string>(); // model ref → topic id, including new ones
  for (const [r, t] of refs.topicRef) idOf.set(r, t.id);
  for (const t of out.topics) if (!refs.topicRef.has(clean(t.ref))) idOf.set(clean(t.ref), newId("tp_"));

  // where each message goes; a message moved out of a topic leaves it
  const moved = new Map<string, Set<string>>(); // topic id → message ids leaving it
  const touched = new Map<string, { t: Topic | null; spec: Out["topics"][number] }>();
  for (const spec of out.topics) touched.set(idOf.get(clean(spec.ref))!, { t: refs.topicRef.get(clean(spec.ref)) ?? null, spec });
  const claimed = new Map<string, string>(); // message id → topic id
  // a message a person took out of a topic never goes back into it
  const excludedFrom = (topicId: string, messageId: string) => !!byId(topicId)?.excluded.includes(messageId);
  for (const pl of [...out.placement, ...out.moves]) {
    const m = msgOf(pl.message);
    const id = idOf.get(clean(pl.topic));
    if (m && id && !claimed.has(m.id) && !excludedFrom(id, m.id)) claimed.set(m.id, id);
  }
  // a new message a point is drawn from belongs to that point's topic, listed or not
  for (const [id, { spec }] of touched)
    for (const r of spec.items.flatMap((it) => it.refs))
      if (clean(r).startsWith("n")) {
        const m = msgOf(r);
        if (m && !claimed.has(m.id) && !excludedFrom(id, m.id)) claimed.set(m.id, id);
      }
  // an open topic that got messages but no new points is still touched
  const untouched = (t: Topic) => ({ t, spec: { ref: "", title: t.title, items: [], needs: t.needs } });
  for (const to of new Set(claimed.values())) if (!touched.has(to) && byId(to)) touched.set(to, untouched(byId(to)!));
  for (const t of shown)
    for (const [mid, to] of claimed)
      if (to !== t.id && t.messageIds.includes(mid)) {
        moved.set(t.id, (moved.get(t.id) ?? new Set()).add(mid));
        if (!touched.has(t.id)) touched.set(t.id, untouched(t));
      }

  for (const [id, { t, spec }] of touched) {
    const old: Topic = t ?? { id, userId: ctx.userId, title: "", state: "active", placeIds: [], messageIds: [], people: [], firstAt: 0, lastAt: 0, items: [], needs: "", log: [], related: [], excluded: [], unlinked: [], dismissed: [], updatedAt: 0 };
    // only new messages can make memory disagree with a status a person set
    const joiningAny = [...claimed.values()].includes(id);
    const log = [...old.log];
    const r = t ? [...refs.topicRef].find(([, x]) => x.id === t.id)?.[0] : null;
    const items: TopicItem[] = [];
    const seen = new Set<string>();
    for (const it of spec.items) {
      const m = r ? clean(it.ref).match(new RegExp(`^${r}\\.i(\\d+)$`)) : null;
      const prev = m ? old.items[Number(m[1]) - 1] : undefined;
      const msgIds = it.refs.map((x) => msgOf(x)?.id).filter((x): x is string => !!x);
      if (prev?.pinned) {
        // set by a person: the status stays; only new messages behind it are added
        seen.add(prev.id);
        const differs = prev.status !== it.status && joiningAny;
        if (differs) log.push({ at: now, text: `Kept your "${prev.status}" for "${prev.text}" (memory would have said ${it.status}${it.why ? `: ${it.why}` : ""})` });
        items.push({ ...prev, refs: [...new Set([...prev.refs, ...msgIds])], disagree: differs ? { status: it.status, why: it.why.trim(), at: now } : prev.disagree });
      } else if (prev) {
        seen.add(prev.id);
        const changed = prev.status !== it.status;
        if (changed) log.push({ at: now, text: `"${prev.text}": ${prev.status} → ${it.status}${it.why ? `. ${it.why}` : ""}` });
        items.push({ ...prev, text: it.text.trim() || prev.text, status: it.status, refs: [...new Set([...prev.refs, ...msgIds])], forYou: it.for_you, why: changed ? it.why.trim() : prev.why, changedAt: changed ? now : prev.changedAt });
      } else {
        // a point a person dismissed doesn't come back
        if (old.dismissed.some((x) => x.text.trim().toLowerCase() === it.text.trim().toLowerCase())) continue;
        log.push({ at: now, text: `New: "${it.text.trim()}" (${it.status})` });
        items.push({ id: newId("pt_"), text: it.text.trim(), status: it.status, refs: msgIds, forYou: it.for_you, why: it.why.trim(), changedAt: now });
      }
    }
    for (const prev of old.items) if (!seen.has(prev.id)) items.push(prev); // never drop a point

    const leaving = moved.get(id) ?? new Set<string>();
    const joining = [...claimed].filter(([, to]) => to === id).map(([mid]) => mid);
    const msgs = joining.map((mid) => [...refs.ref.values()].find((m) => m.id === mid)!).filter(Boolean);
    const times = msgs.map((m) => m.createdAt);
    if (leaving.size) log.push({ at: now, text: `${leaving.size} message${leaving.size === 1 ? "" : "s"} moved to another topic` });
    if (!t && msgs.length === 0) continue; // a new topic with nothing in it
    await store.saveTopic({
      ...old,
      title: (spec.title.trim() || old.title).slice(0, 400),
      // new messages reopen a closed topic; a topic that only lost messages keeps its state
      state: joining.length ? "active" : old.state,
      placeIds: [...new Set([...old.placeIds, ...(msgs.length ? [place.id] : [])])],
      messageIds: [...new Set([...old.messageIds.filter((x) => !leaving.has(x)), ...joining])].slice(-o.maxMessagesPerTopic),
      people: [...new Set([...old.people, ...msgs.map((m) => m.authorId)])],
      firstAt: Math.min(...[old.firstAt, ...times].filter((x) => !!x)),
      lastAt: Math.max(old.lastAt, ...times),
      items,
      needs: spec.needs.trim(),
      log: log.slice(-o.logKept),
      updatedAt: now,
    });
  }

  // related, not merged: each side remembers the other and why
  for (const l of out.links) {
    const a = idOf.get(clean(l.a));
    const b = idOf.get(clean(l.b));
    if (!a || !b || a === b) continue;
    if (byId(a)?.unlinked.includes(b) || byId(b)?.unlinked.includes(a)) continue; // a person said they aren't related
    for (const [x, y] of [
      [a, b],
      [b, a],
    ]) {
      const t = await store.topic(x);
      if (!t || t.related.some((r) => r.id === y)) continue;
      await store.saveTopic({ ...t, related: [...t.related, { id: y, why: l.why.trim() }] });
    }
  }
}
