/**
 * A tour of radar-memory on a small made-up team. Needs ANTHROPIC_API_KEY. Costs about a cent.
 *
 *   ANTHROPIC_API_KEY=... npm run example
 *
 * 1. Priya tests a build over an afternoon and sends issues in her DM; Leo mentions related work
 *    in #product. Memory groups the DM into one topic and links #product by meaning.
 * 2. You reply that one bug is fixed: the old point moves to done, with the reason.
 * 3. You correct a point yourself. Then Priya says it's still broken: memory keeps your call but
 *    flags the disagreement, so you decide.
 */
import { ArraySource, InMemoryStore, anthropicModel, createMemory, type Message, type Topic } from "../src/index.js";

const you = { id: "u_sam", name: "Sam Rivera" };
const priya = { id: "u_priya", name: "Priya Shah" };
const leo = { id: "u_leo", name: "Leo Park" };
const dm = { id: "dm_priya", kind: "dm" as const, name: "Priya" };
const product = { id: "ch_product", kind: "channel" as const, name: "product" };

const start = Date.now() - 4 * 3600_000;
let n = 0;
const msg = (placeId: string, author: string, minutes: number, text: string, extra: Partial<Message> = {}): Message => ({ id: `m${++n}`, placeId, authorId: author, text, createdAt: start + minutes * 60_000, ...extra });

const source = new ArraySource([dm, product], [you, priya, leo], [
  msg(dm.id, priya.id, 0, "Started testing build 1.4 on Android. Checkout shows min amount 1000 but then says minimum is 5000."),
  msg(dm.id, you.id, 2, "Let me check the minimum logic."),
  msg(dm.id, priya.id, 14, "Scheduled orders don't show up in the Orders tab at all."),
  msg(dm.id, priya.id, 27, "Also no confirmation email for scheduled orders, other orders get one."),
  msg(dm.id, priya.id, 41, "Can we have pull down to refresh in Orders?"),
  msg(dm.id, priya.id, 63, "The portfolio page is buried too deep. I want to reach my holdings in one click from home."),
  msg(dm.id, priya.id, 95, "Bank account can't be edited from the profile. It should be."),
  msg(product.id, leo.id, 110, "I'm designing a one-tap shortcut to the investments screen from the home tab, for next sprint."),
]);
const store = new InMemoryStore();
const memory = createMemory({ source, store, model: anthropicModel(), options: { timeZone: "Asia/Kolkata" } });

const show = (title: string, topics: Topic[]) => {
  console.log(`\n=== ${title}`);
  for (const t of topics) {
    console.log(`\n${t.state === "closed" ? "(closed) " : ""}${t.title}  [${t.placeIds.join(", ")} · ${t.messageIds.length} messages]`);
    for (const i of t.items) {
      console.log(`  ${i.status.padEnd(9)}${i.forYou ? "you " : "    "}${i.text}${i.pinned ? "  (set by you)" : ""}`);
      if (i.why && !i.pinned) console.log(`             why: ${i.why}`);
      if (i.disagree) console.log(`             ⚠ memory now thinks ${i.disagree.status}: ${i.disagree.why}`);
    }
    for (const r of t.related) console.log(`  related → ${r.id}: ${r.why}`);
  }
};

// 1. read everything that's there
await memory.tick(you.id, { quietMs: 0, maxPlaces: 10 });
show("After the first read", await memory.topics(you.id));

// 2. you reply later in the DM
source.add(msg(dm.id, you.id, 150, "Fixed the scheduled orders bug, they show in Orders now. Can you check on 1.4.1?"));
await memory.tick(you.id, { quietMs: 0 });
show("After your reply", await memory.topics(you.id));

// 3. you correct a point yourself, then Priya contradicts it
const testing = (await memory.topics(you.id)).find((t) => t.placeIds.includes(dm.id))!;
const refresh = testing.items.find((i) => /refresh/i.test(i.text));
if (refresh) {
  await memory.correctPoint(you.id, testing.id, refresh.id, "done");
  source.add(msg(dm.id, priya.id, 170, "Pull down to refresh still does nothing on 1.4.1."));
  await memory.tick(you.id, { quietMs: 0 });
  show("After your correction, and Priya saying it's still broken", await memory.topics(you.id));
}

console.log("\n=== Waiting on you");
for (const { topic, item } of await memory.forYou(you.id)) console.log(`  ${item.status.padEnd(9)}${item.text}  (${topic.title})`);
console.log("\n=== What memory learned from you");
for (const l of await store.lessons(you.id, 10)) console.log(`  - ${l.text}`);
