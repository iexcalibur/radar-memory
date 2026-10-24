import type { Message, Topic } from "./types.js";

/** The radar's cheap first look, before any model call: open topics in other places that new
 *  messages may belong to, by shared people and shared specific words. These are shown to the
 *  model in full; every other open topic is shown on the radar by title and open points only, so
 *  the model can still match by meaning. */

const STOP = new Set(
  "about after also been before being could does done from have here into just like make more need only other over please same should some still than that their them then there these they this those very want what when which will with would your yours".split(" "),
);
export const termsOf = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []).filter((w) => !STOP.has(w)));
/** A word that names one specific thing: has a digit or underscore, or is long. */
const weight = (w: string) => (/[0-9_]/.test(w) || w.length >= 9 ? 2 : 1);

export function nearbyTopics(topics: Topic[], placeId: string, batch: Message[], readerId: string, limit: number): Topic[] {
  const authors = new Set(batch.map((m) => m.authorId).filter((a) => a !== readerId));
  const words = termsOf(batch.map((m) => m.text).join(" "));
  return topics
    .filter((t) => !t.placeIds.includes(placeId))
    .map((t) => {
      const people = t.people.filter((p) => authors.has(p)).length;
      const theirs = termsOf([t.title, ...t.items.map((i) => i.text)].join(" "));
      let shared = 0;
      for (const w of words) if (theirs.has(w)) shared += weight(w);
      return { t, score: Math.min(people, 2) * 2 + shared, people, shared };
    })
    .filter((x) => (x.people > 0 && x.shared >= 3) || x.shared >= 6)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t);
}
