/** The shapes the engine works with. Your app maps its own records onto Message, Place and Person;
 *  the engine owns Topic, Cursor and Lesson. */

/** Where a point stands. */
export type Status = "open" | "promised" | "answered" | "done" | "info";

export interface Person {
  id: string;
  name: string;
}

/** A DM or a channel. For a DM, `name` is how the reader would name it (the other person). */
export interface Place {
  id: string;
  kind: "dm" | "channel";
  name: string;
}

/** One chat message. `rootId` groups a message with the replies under it (a conversation); leave it
 *  out (or set it to the message's own id) for a message that isn't a reply. */
export interface Message {
  id: string;
  placeId: string;
  authorId: string;
  text: string;
  /** milliseconds since the epoch */
  createdAt: number;
  rootId?: string;
  parentId?: string | null;
  /** optional: what your own classifier already knows about the message */
  label?: { kind?: string; waitingOn?: string[] };
}

/** One point raised in a topic. `pinned` when a person set its status themselves: memory never
 *  changes it, and when later messages suggest otherwise it says so in `disagree`. */
export interface TopicItem {
  id: string;
  text: string;
  status: Status;
  /** the messages it comes from */
  refs: string[];
  /** the reader is the one asked to answer or act */
  forYou: boolean;
  /** why it has this status, in one sentence */
  why: string;
  changedAt: number;
  pinned?: boolean;
  disagree?: { status: Status; why: string; at: number };
}

/** One piece of work or purpose, for one reader, across however many places and days. */
export interface Topic {
  id: string;
  userId: string;
  title: string;
  state: "active" | "closed";
  placeIds: string[];
  messageIds: string[];
  people: string[];
  firstAt: number;
  lastAt: number;
  items: TopicItem[];
  /** what the reader still has to do here, one sentence, or "" */
  needs: string;
  /** every change, with its reason */
  log: { at: number; text: string }[];
  /** topics linked as related but separate */
  related: { id: string; why: string }[];
  /** messages a person took out of this topic: never put back */
  excluded: string[];
  /** topics a person said aren't related: never linked or merged again */
  unlinked: string[];
  /** points a person said aren't points: never added again */
  dismissed: TopicItem[];
  updatedAt: number;
}

/** How far the reader has read one place for one person (`key` is the place id), or when the
 *  sweep last ran (`key` "_sweep"). `runningAt` is a lock against two readers at once. */
export interface Cursor {
  userId: string;
  key: string;
  lastAt: number;
  runningAt: number;
}

/** A correction a person made, kept as a lesson the reader sees on every read. */
export interface Lesson {
  id: string;
  userId: string;
  text: string;
  createdAt: number;
}
