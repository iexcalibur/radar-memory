import type { MemoryStore } from "../adapters.js";
import type { Cursor, Lesson, Topic } from "../types.js";

/** Memory held in this process: for tests, demos, and as the base of JsonFileStore. */
export class InMemoryStore implements MemoryStore {
  protected data: { topics: Record<string, Topic>; cursors: Record<string, Cursor>; lessons: Lesson[] } = { topics: {}, cursors: {}, lessons: [] };

  protected changed(): Promise<void> {
    return Promise.resolve();
  }

  async topics(userId: string, opts: { since?: number; state?: Topic["state"]; limit?: number } = {}): Promise<Topic[]> {
    return Object.values(this.data.topics)
      .filter((t) => t.userId === userId && t.lastAt > (opts.since ?? -Infinity) && (!opts.state || t.state === opts.state))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, opts.limit ?? Infinity)
      .map((t) => structuredClone(t));
  }
  async topic(id: string) {
    const t = this.data.topics[id];
    return t ? structuredClone(t) : null;
  }
  async saveTopic(topic: Topic) {
    this.data.topics[topic.id] = structuredClone(topic);
    await this.changed();
  }
  async deleteTopic(id: string) {
    delete this.data.topics[id];
    await this.changed();
  }
  async cursor(userId: string, key: string) {
    return this.data.cursors[`${userId}:${key}`] ?? null;
  }
  async saveCursor(cursor: Cursor) {
    this.data.cursors[`${cursor.userId}:${cursor.key}`] = { ...cursor };
    await this.changed();
  }
  async addLesson(lesson: Lesson) {
    this.data.lessons.push({ ...lesson });
    await this.changed();
  }
  async lessons(userId: string, limit: number) {
    return this.data.lessons
      .filter((l) => l.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}
