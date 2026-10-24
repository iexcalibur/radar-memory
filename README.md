# radar-memory

Shared memory for team chat. It reads your DMs and channels the way a person catching up would, groups messages into **topics** by what they're about (not by time, and across places), keeps **every point's status** (open, promised, answered, done, FYI) up to date as later messages arrive, and **learns from people's corrections**.

It plugs into any chat app: you give it read access to your messages and a place to store memory; Claude does the reading.

```
Priya, DM, 16:11–17:49, 13 messages          #product, 18:30
  "min shows 1000 but says 5000"               "one-tap shortcut to investments
  "scheduled orders missing"                    from home, next sprint"
  "pull to refresh in Orders?"                        │
  "holdings buried too deep"  ◄──── related ──────────┘ (matched by meaning)
        │
        ▼
Topic: "Priya is testing build 1.4 and sent you 6 issues"
  promised  Checkout minimum mismatch        why: You said you'd check at 16:13
  done      Scheduled orders missing         why: You replied "fixed" at 18:02
  done      Pull to refresh (set by you)     ⚠ memory now thinks open: Priya says it still fails
  open      Holdings buried too deep
```

## How it works

Three ideas, applied every time a burst of messages ends in a place (2 quiet minutes by default):

**1. The reverse sliding window.** New messages are never read alone. The reader looks back over the place's recent messages (20 by default, each tagged with the topic it is already in), so "also the email is broken" lands in the same topic as the issues before it, and "fixed it" can settle a point raised an hour or a week earlier. A later message can change an earlier point's status, and every change records **why**, in one sentence naming who said what and when.

**2. The radar.** Memory sits in the centre; every DM and channel the person can see is around it. For each read the reader looks in three rings:

| Ring | What the model sees | Chosen by |
|---|---|---|
| Here | open topics in this place, in full | same place |
| Nearby | up to 3 open topics elsewhere, in full | shared people and shared specific words (cheap, no model) |
| Radar | every other open topic, title and open points only | everything else, so the model can match **by meaning** ("one-tap to investments" ↔ "holdings in one click") |

The model then places every new message (an existing topic, a radar topic, a new topic, or "none" for chit-chat), updates each point's status with a reason, and may **link** related topics. Joining a topic in another place needs the same specific work and the same people; otherwise topics are linked, not merged.

**3. The slow sweep.** Once an hour per person, the model looks across all open topics at once and proposes merges (the same work opened twice), splits (a topic that drifted from one purpose to another) and closes (everything done). Code guards decide what's safe: merges only when the model is sure and the topics share someone besides the reader; a conversation (a message and its replies) is never split; parts whose messages interleave in time are never split (a run of issues from one testing session stays together).

**The judgment layer.** People can correct memory: set a point's status, dismiss a point, take a message out of a topic, close or reopen a topic, unlink two topics. Their call is final. The reader and the sweep never undo it, never put back a removed message or dismissed point, and never relink or merge unlinked topics. If later messages suggest otherwise, memory keeps the person's status and **flags** the point (`disagree`) so they decide. Every correction becomes a **lesson** shown to the reader on every read ("In 'X': 'Y' is done, not open"), so it judges similar cases the way that person does.

Memory is **per person**: each reader has their own topics, built only from places they can see, with "for you" meaning *them*.

## Quick start

```bash
npm install
ANTHROPIC_API_KEY=sk-... npm run example
```

`examples/quickstart.ts` runs a small team through all four behaviours: grouping a testing session into one topic, linking a related channel message by meaning, settling an old point from a later reply, and flagging a contradicted correction. It costs about a cent.

## Plug it into your app

### 1. Give it your messages

Implement `MessageSource` over your own database or API. Six read-only methods, all scoped to what the person may see:

```ts
import type { MessageSource } from "radar-memory";

const source: MessageSource = {
  places: (userId) => db.query("select id, kind, name from places where $1 = any(members)", [userId]),
  people: (userId) => db.query("select id, name from people where org = (select org from people where id = $1)", [userId]),
  messagesAfter: (placeId, after, limit) =>
    db.query("select * from messages where place_id = $1 and created_at > $2 order by created_at asc limit $3", [placeId, after, limit]),
  messagesBefore: async (placeId, before, since, limit) =>
    (await db.query("select * from messages where place_id = $1 and created_at < $2 and created_at > $3 order by created_at desc limit $4", [placeId, before, since, limit])).reverse(),
  messagesByIds: (ids) => db.query("select * from messages where id = any($1)", [ids]),
  latestAt: async (placeIds) => new Map((await db.query("select place_id, max(created_at) from messages where place_id = any($1) group by place_id", [placeIds])).map((r) => [r.place_id, r.max])),
};
```

Map your rows onto `Message`: `{ id, placeId, authorId, text, createdAt (ms), rootId?, parentId?, label? }`. Set `rootId` to the top message of a reply chain so a conversation is never split. `label` is optional: if you already classify messages (question, request, waiting on whom), pass it in and the reader uses it.

For a DM, `Place.name` is what the reader would call it (usually the other person's name).

### 2. Give it a store

- `InMemoryStore`: tests and demos.
- `JsonFileStore("memory.json")`: one process, prototypes, CLIs.
- Your database: implement `MemoryStore` (8 methods). Three tables are enough:
  - `topics`: id, user_id, last_at (index on user_id + last_at), plus the rest of `Topic` (store `items`, `log`, `related`, `excluded`, `unlinked`, `dismissed` as JSON).
  - `cursors`: (user_id, key) primary key, last_at, running_at.
  - `lessons`: id, user_id, text, created_at (index on user_id + created_at).

### 3. Create the engine

```ts
import { createMemory, anthropicModel } from "radar-memory";

const memory = createMemory({
  source,
  store,
  model: anthropicModel({
    // apiKey defaults to ANTHROPIC_API_KEY; model defaults to claude-haiku-5-5
    onUsage: (task, usage) => meter.add(task, usage), // budgets, billing, dashboards
  }),
  options: { timeZone: "Asia/Kolkata" },
});
```

`Model` is a one-method interface, so you can wrap the default (retries, budgets, caching) or swap in another provider.

### 4. Let it read

Call `tick(userId)` often; it's cheap when nothing is due. It reads every place where a burst has ended, closes topics untouched for a week, and runs the hourly sweep when due.

```ts
// on a timer for active users, on page views, or after new messages arrive
await memory.tick(userId);

// before building a summary: read everything up to now, ignoring the quiet wait
await memory.tick(userId, { quietMs: 0, maxPlaces: 10 });

// first run / backfill: the last 7 days of every place
await memory.tick(userId, { quietMs: 0, maxPlaces: 100, maxBatches: 50 });
```

Reads take a lock per place (`Cursor.runningAt`), so overlapping ticks are safe.

### 5. Show it

```ts
const topics = await memory.topics(userId, { since: Date.now() - 24 * 3600_000 }); // a daily catch-up
const todo = await memory.forYou(userId); // everything waiting on this person
const ctx = await memory.topicOf(userId, messageId); // for a notification: its topic and point
```

Per point, show `status`, `why` (the reason), `pinned` (the person set it) and `disagree` (memory read a later message differently). Per topic, `title`, `needs` (what the person still has to do), `related` and `log`.

### 6. Let people correct it

```ts
await memory.correctPoint(userId, topicId, itemId, "done");      // or "dismiss": not a point
await memory.removeMessage(userId, topicId, messageId);          // not part of this topic
await memory.setTopicState(userId, topicId, "closed");           // finished
await memory.unlinkTopics(userId, topicA, topicB);               // not related
```

Each returns the topic as it now stands. When a point has `disagree`, offer two choices: accept memory's status, or pick the person's status again to keep it (that clears the flag and teaches memory that this kind of message doesn't change their call).

## Options

| Option | Default | What it does |
|---|---|---|
| `quietMs` | 2 min | A place is read once it has been quiet this long |
| `staleMs` | 7 days | Topics untouched this long close; how far back a read looks |
| `batch` | 40 | New messages per model call |
| `lookBack` | 20 | Earlier messages shown for context (the reverse window) |
| `hereLimit` | 8 | Open topics of this place shown in full |
| `nearbyLimit` | 3 | Open topics elsewhere shown in full when they share people and words |
| `radarSize` | 40 | Other open topics on the radar (title and open points) |
| `sweepEveryMs` | 1 hour | How often the slow sweep runs per person |
| `lockMs` | 3 min | Longest a read or sweep holds its lock |
| `timeZone` | UTC | Times are written to the model in this zone |
| `lessonsShown` | 15 | Latest corrections shown to the reader as lessons |
| `logKept` | 40 | Log lines kept per topic |
| `maxMessagesPerTopic` | 500 | Message ids kept per topic |

## Cost

One Claude Haiku call per ended burst, per place, per person (a few thousand input tokens; more as the radar grows), plus one sweep call per person per hour when they have two or more open topics. In practice that's cents per person per day. Use `onUsage` to meter it and wrap `Model` to enforce a budget.

## Privacy

Memory is per person and built only from `source.places(userId)`, so nobody's memory contains messages they can't see. Message text (up to 500 characters each) and topic text are sent to Anthropic for every read. Store memory with the same care as the messages themselves.

## Limits

- **It's a reader, not an oracle.** It knows only what's written in the messages it reads: not calls, meetings or anything said elsewhere. The same messages can be judged slightly differently from run to run. That's what corrections and the `disagree` flag are for.
- **Cross-place joins are cautious.** A message in one place that answers a point in another is usually *linked*, not merged, and doesn't change the other point's status. A correction fixes it.
- **The sweep is conservative.** Code guards reject most splits and unsure merges; expect it to mostly close finished topics.
- **Scale.** `topicOf` scans a person's topics; in a database, index message ids to topics (or store a message → topic table) if you call it often.
- **Prompts are tuned for workplace chat.** `READER` and `SWEEPER` in `src/prompts.ts` are exported; adapt their examples to your domain, but keep the rules on statuses, promises, conversations and corrections.

## Layout

```
src/
  engine.ts      createMemory(): tick, read, sweep, queries, corrections
  reader.ts      the reverse window, the radar rings, the model call, applying its decisions
  radar.ts       the cheap first look: nearby topics by people and words
  sweep.ts       the hourly merge / split / close, with code guards
  judgment.ts    corrections and lessons
  prompts.ts     READER and SWEEPER instructions
  context.ts     options and defaults
  adapters.ts    MessageSource and MemoryStore: what you implement
  model.ts       the Model interface and the Claude implementation
  types.ts       Message, Place, Person, Topic, TopicItem, Cursor, Lesson
  stores/        InMemoryStore, JsonFileStore, ArraySource
examples/
  quickstart.ts  the tour above
```

Extracted from Sledge, where it powers Catch up, Activity, Conversations and Ask Sledge.
