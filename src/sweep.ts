import { z } from "zod";
import { contextFor, placeLabel, type Ctx, type Deps } from "./context.js";
import { SWEEPER } from "./prompts.js";
import type { Topic, TopicItem } from "./types.js";
import { clean, newId } from "./util.js";

/** The slow sweep: once an hour per person, looks across all their open topics at once. Merges the
 *  same work opened twice, splits a topic that drifted from one purpose to the next, closes
 *  finished ones. The model proposes; code guards decide what is safe to apply. */

export const SweepOut = z.object({
  merges: z.array(z.object({ keep: z.string(), merge: z.array(z.string()), title: z.string(), why: z.string(), sure: z.boolean() })),
  splits: z.array(z.object({ topic: z.string(), parts: z.array(z.object({ title: z.string(), points: z.array(z.string()), needs: z.string() })), why: z.string() })),
  closes: z.array(z.object({ topic: z.string(), why: z.string() })),
});

/** Runs the sweep when it's due (or now, with `force`). Returns whether it ran. */
export async function sweep(deps: Deps, userId: string, opts: { force?: boolean; ctx?: Ctx } = {}): Promise<boolean> {
  const { store, source, model, options: o } = deps;
  const cur = await store.cursor(userId, "_sweep");
  const now = Date.now();
  if (!opts.force && cur && now - cur.lastAt < o.sweepEveryMs) return false;
  if (cur?.runningAt && now - cur.runningAt < o.lockMs) return false;
  await store.saveCursor({ userId, key: "_sweep", lastAt: cur?.lastAt ?? 0, runningAt: now });
  try {
    const open = (await store.topics(userId, { since: now - o.staleMs, state: "active", limit: 80 })).filter((t) => t.state === "active");
    if (open.length < 2) return false;
    const ctx = opts.ctx ?? (await contextFor(deps, userId));
    const ref = new Map(open.map((t, i) => [`T${i + 1}`, t]));
    const placeOf = (t: Topic) => t.placeIds.map((p) => (ctx.places.get(p) ? placeLabel(ctx.places.get(p)!) : null)).filter(Boolean).join(" and ");
    const who = (t: Topic) => t.people.map((p) => (p === userId ? "you" : (ctx.people.get(p)?.name.split(" ")[0] ?? "someone"))).join(", ");
    const lines = [...ref].map(([r, t]) =>
      [`[${r}] in ${placeOf(t)}, with ${who(t)}, ${ctx.date(t.firstAt)} to ${ctx.date(t.lastAt)}: ${t.title}`, ...t.items.slice(0, 15).map((it, i) => `  [${r}.i${i + 1}] ${it.status}${it.pinned ? " (set by you)" : ""}: ${it.text}`)].join("\n"),
    );
    const prompt = `Reader: ${ctx.people.get(userId)?.name ?? "the reader"}\n\nOpen topics:\n${lines.join("\n")}`;
    const out = await model.structured({ task: "sweep", system: SWEEPER, prompt, schema: SweepOut, effort: "medium", maxTokens: 3000 });
    if (!out) return true;
    deps.debug?.({ task: "sweep", prompt, out });
    const gone = new Set<string>();

    for (const m of out.merges) {
      const keep = ref.get(clean(m.keep));
      const others = m.merge.map((r) => ref.get(clean(r))).filter((t): t is Topic => !!t && t.id !== keep?.id && !gone.has(t.id));
      if (!keep || gone.has(keep.id) || others.length === 0 || !m.sure) continue;
      // the same work has the same people: at least one besides the reader in common with each
      const theirs = (t: Topic) => new Set(t.people.filter((p) => p !== userId));
      if (others.some((x) => ![...theirs(x)].some((p) => theirs(keep).has(p)))) continue;
      if (others.some((x) => keep.unlinked.includes(x.id) || x.unlinked.includes(keep.id))) continue; // a person said they aren't related
      const all = [keep, ...others];
      const log = [...keep.log, ...others.map((x) => ({ at: now, text: `Merged with "${x.title}". ${m.why.trim()}` }))];
      await store.saveTopic({
        ...keep,
        title: (m.title.trim() || keep.title).slice(0, 400),
        placeIds: [...new Set(all.flatMap((t) => t.placeIds))],
        messageIds: [...new Set(all.flatMap((t) => t.messageIds))].slice(-o.maxMessagesPerTopic),
        people: [...new Set(all.flatMap((t) => t.people))],
        firstAt: Math.min(...all.map((t) => t.firstAt).filter(Boolean)),
        lastAt: Math.max(...all.map((t) => t.lastAt)),
        items: all.flatMap((t) => t.items),
        needs: all.map((t) => t.needs).filter(Boolean).join(" "),
        related: all.flatMap((t) => t.related).filter((x, i, a) => !all.some((y) => y.id === x.id) && a.findIndex((z) => z.id === x.id) === i),
        excluded: [...new Set(all.flatMap((t) => t.excluded))],
        unlinked: [...new Set(all.flatMap((t) => t.unlinked))],
        dismissed: all.flatMap((t) => t.dismissed),
        log: log.slice(-o.logKept),
        updatedAt: now,
      });
      for (const x of others) {
        await store.deleteTopic(x.id);
        gone.add(x.id);
      }
    }

    for (const sp of out.splits) {
      const t = ref.get(clean(sp.topic));
      if (!t || gone.has(t.id) || sp.parts.length < 2) continue;
      const r = clean(sp.topic);
      const pointOf = (x: string) => {
        const m = clean(x).match(new RegExp(`^${r}\\.i(\\d+)$`));
        return m ? t.items[Number(m[1]) - 1] : undefined;
      };
      const parts = sp.parts.map((p) => ({ ...p, items: p.points.map(pointOf).filter((x): x is TopicItem => !!x) })).filter((p) => p.items.length > 0);
      const placed = new Set(parts.flatMap((p) => p.items.map((i) => i.id)));
      if (parts.length < 2 || placed.size !== t.items.length) continue; // every point in exactly one part, or leave it be
      if (parts.some((p) => p.items.length < 2)) continue;
      // messages follow the points they back; the rest stay with the first part
      const claimedBy = parts.map((p) => new Set(p.items.flatMap((i) => i.refs)));
      const msgs = await source.messagesByIds(t.messageIds);
      // one conversation (a message and its replies) is never split across topics
      const partsOfRoot = new Map<string, Set<number>>();
      for (const x of msgs) for (const [i, c] of claimedBy.entries()) if (c.has(x.id)) partsOfRoot.set(x.rootId ?? x.id, (partsOfRoot.get(x.rootId ?? x.id) ?? new Set()).add(i));
      if ([...partsOfRoot.values()].some((v) => v.size > 1)) continue;
      // a topic drifts from one purpose to the next over time; parts whose messages interleave are
      // one activity seen from several sides (a run of issues), so they stay together
      const spans = claimedBy.map((c) => msgs.filter((x) => c.has(x.id)).map((x) => x.createdAt)).filter((ts) => ts.length).map((ts) => [Math.min(...ts), Math.max(...ts)]);
      spans.sort((a, b) => a[0] - b[0]);
      if (spans.some((x, i) => i > 0 && x[0] < spans[i - 1][1])) continue;
      for (const [i, p] of parts.entries()) {
        const mine = msgs.filter((x) => claimedBy[i].has(x.id) || (i === 0 && !claimedBy.some((c) => c.has(x.id))));
        const times = mine.map((x) => x.createdAt);
        await store.saveTopic({
          ...t,
          id: i === 0 ? t.id : newId("tp_"),
          title: p.title.trim().slice(0, 400),
          state: "active",
          placeIds: [...new Set(mine.map((x) => x.placeId))],
          messageIds: mine.map((x) => x.id),
          people: [...new Set(mine.map((x) => x.authorId))],
          firstAt: times.length ? Math.min(...times) : t.firstAt,
          lastAt: times.length ? Math.max(...times) : t.lastAt,
          items: p.items,
          needs: p.needs.trim(),
          log: [...t.log, { at: now, text: `Split from "${t.title}". ${sp.why.trim()}` }].slice(-o.logKept),
          updatedAt: now,
        });
      }
      gone.add(t.id);
    }

    for (const c of out.closes) {
      const t = ref.get(clean(c.topic));
      if (!t || gone.has(t.id) || t.items.some((i) => i.status === "open" || i.status === "promised")) continue;
      await store.saveTopic({ ...t, state: "closed", log: [...t.log, { at: now, text: `Closed: ${c.why.trim()}` }].slice(-o.logKept), updatedAt: now });
    }
    return true;
  } finally {
    await store.saveCursor({ userId, key: "_sweep", lastAt: now, runningAt: 0 }).catch(() => null);
  }
}
