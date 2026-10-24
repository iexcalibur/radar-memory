import type { Deps } from "./context.js";
import type { Status, Topic } from "./types.js";
import { excerpt, newId } from "./util.js";

/** The judgment layer: a person's corrections to their memory. Each one is kept (the reader and the
 *  sweep never undo it) and remembered as a lesson the reader sees on every read, so memory learns
 *  how this person judges. Every function returns the topic as it now stands. */

const WORD: Record<Status, string> = { open: "open", promised: "promised", answered: "answered", done: "done", info: "just FYI" };

async function yours(deps: Deps, userId: string, topicId: string): Promise<Topic> {
  const t = await deps.store.topic(topicId);
  if (!t || t.userId !== userId) throw new Error("Topic not found");
  return t;
}

const learn = (deps: Deps, userId: string, text: string) => deps.store.addLesson({ id: newId("ls_"), userId, text: text.slice(0, 800), createdAt: Date.now() });
const keepLog = (deps: Deps, t: Topic, text: string) => [...t.log, { at: Date.now(), text }].slice(-deps.options.logKept);
/** Nothing left for the reader here: the to-do line goes. */
const needsAfter = (t: Topic) => (t.items.some((i) => i.forYou && (i.status === "open" || i.status === "promised")) ? t.needs : "");

/** Sets a point's status yourself, or says it isn't a point at all ("dismiss"). Picking the status
 *  you already set again, after memory flagged a disagreement, keeps yours and clears the flag. */
export async function correctPoint(deps: Deps, userId: string, topicId: string, itemId: string, status: Status | "dismiss"): Promise<Topic> {
  const t = await yours(deps, userId, topicId);
  const it = t.items.find((i) => i.id === itemId);
  if (!it) throw new Error("Point not found");
  const now = Date.now();
  let next: Topic;
  if (status === "dismiss") {
    next = { ...t, items: t.items.filter((i) => i.id !== itemId), dismissed: [...t.dismissed, it], log: keepLog(deps, t, `You said "${it.text}" isn't a point`) };
    await learn(deps, userId, `In "${t.title}": "${it.text}" is not something to track as a point (memory had it as ${it.status}).`);
  } else {
    if (it.status === status && it.pinned && !it.disagree) return t;
    const doubt = it.disagree;
    const kept = !!doubt && it.status === status;
    const items = t.items.map((i) => (i.id === itemId ? { ...i, status, pinned: true, why: "You set this", changedAt: now, disagree: undefined } : i));
    next = { ...t, items, log: keepLog(deps, t, kept ? `You kept "${it.text}" as ${status}` : `You set "${it.text}" to ${status} (memory had ${doubt?.status ?? it.status})`) };
    const reasoned = doubt?.why || (it.why && it.why !== "You set this" ? it.why : "");
    await learn(
      deps,
      userId,
      kept
        ? `In "${t.title}": "${it.text}" stays ${WORD[status]} even though memory read a later message as ${WORD[doubt!.status]} (${doubt!.why}).`
        : `In "${t.title}": "${it.text}" is ${WORD[status]}, not ${WORD[doubt?.status ?? it.status]}${reasoned ? `; memory had reasoned: ${reasoned}` : ""}.`,
    );
  }
  next = { ...next, needs: needsAfter(next), updatedAt: now };
  await deps.store.saveTopic(next);
  return next;
}

/** Takes a message out of a topic; it is never put back. `messageText` makes a better lesson. */
export async function removeMessage(deps: Deps, userId: string, topicId: string, messageId: string, messageText?: string): Promise<Topic> {
  const t = await yours(deps, userId, topicId);
  const text = messageText ?? (await deps.source.messagesByIds([messageId]))[0]?.text ?? "";
  const next: Topic = {
    ...t,
    messageIds: t.messageIds.filter((x) => x !== messageId),
    excluded: [...new Set([...t.excluded, messageId])],
    items: t.items.map((i) => ({ ...i, refs: i.refs.filter((r) => r !== messageId) })),
    log: keepLog(deps, t, "You took a message out of this topic"),
    updatedAt: Date.now(),
  };
  await deps.store.saveTopic(next);
  await learn(deps, userId, `The message "${excerpt(text, 160)}" does not belong to "${t.title}".`);
  return next;
}

/** Closes a topic as finished, or opens it again. New messages in it reopen it on their own. */
export async function setTopicState(deps: Deps, userId: string, topicId: string, state: Topic["state"]): Promise<Topic> {
  const t = await yours(deps, userId, topicId);
  if (t.state === state) return t;
  const next: Topic = { ...t, state, log: keepLog(deps, t, state === "closed" ? "You closed this topic" : "You reopened this topic"), updatedAt: Date.now() };
  await deps.store.saveTopic(next);
  await learn(deps, userId, state === "closed" ? `"${t.title}" is finished: nothing more to track.` : `"${t.title}" is not finished yet.`);
  return next;
}

/** Two topics memory linked aren't related; they are never linked or merged again. */
export async function unlinkTopics(deps: Deps, userId: string, a: string, b: string): Promise<[Topic, Topic]> {
  const [ta, tb] = await Promise.all([yours(deps, userId, a), yours(deps, userId, b)]);
  const cut = (t: Topic, other: Topic): Topic => ({ ...t, related: t.related.filter((r) => r.id !== other.id), unlinked: [...new Set([...t.unlinked, other.id])], updatedAt: Date.now() });
  const na = cut(ta, tb);
  const nb = cut(tb, ta);
  await Promise.all([deps.store.saveTopic(na), deps.store.saveTopic(nb)]);
  await learn(deps, userId, `"${ta.title}" and "${tb.title}" are not related.`);
  return [na, nb];
}
