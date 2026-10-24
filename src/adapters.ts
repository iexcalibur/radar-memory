import type { Cursor, Lesson, Message, Person, Place, Topic } from "./types.js";

/** Your messages, read-only. Implement this over your own database or API. Everything is per
 *  reader: only return what `userId` is allowed to see. */
export interface MessageSource {
  /** The DMs and channels the person can read. */
  places(userId: string): Promise<Place[]>;
  /** The people whose names may appear (including the reader). */
  people(userId: string): Promise<Person[]>;
  /** Messages in a place created strictly after `after`, oldest first, at most `limit`. */
  messagesAfter(placeId: string, after: number, limit: number): Promise<Message[]>;
  /** The last `limit` messages in a place created before `before` and after `since`, oldest first. */
  messagesBefore(placeId: string, before: number, since: number, limit: number): Promise<Message[]>;
  /** Messages by id, any order; missing ones are left out. */
  messagesByIds(ids: string[]): Promise<Message[]>;
  /** The newest message time in each place (places with no messages may be left out). */
  latestAt(placeIds: string[]): Promise<Map<string, number>>;
}

/** Where memory lives. Use InMemoryStore or JsonFileStore, or implement this over your database
 *  (one table each for topics, cursors and lessons is enough). */
export interface MemoryStore {
  /** A person's topics with `lastAt` after `since` (default all), newest first. */
  topics(userId: string, opts?: { since?: number; state?: Topic["state"]; limit?: number }): Promise<Topic[]>;
  topic(id: string): Promise<Topic | null>;
  /** Create or replace. */
  saveTopic(topic: Topic): Promise<void>;
  deleteTopic(id: string): Promise<void>;
  cursor(userId: string, key: string): Promise<Cursor | null>;
  saveCursor(cursor: Cursor): Promise<void>;
  addLesson(lesson: Lesson): Promise<void>;
  /** A person's lessons, newest first. */
  lessons(userId: string, limit: number): Promise<Lesson[]>;
}
