import type { MessageSource } from "../adapters.js";
import type { Message, Person, Place } from "../types.js";

/** A MessageSource over plain arrays: for tests, demos, or replaying an export. Everyone can see
 *  every place; give `visible` to limit what each person sees. */
export class ArraySource implements MessageSource {
  constructor(
    public placesList: Place[],
    public peopleList: Person[],
    public messages: Message[] = [],
    private visible?: (userId: string, place: Place) => boolean,
  ) {}

  add(...messages: Message[]) {
    this.messages.push(...messages);
  }
  private inPlace(placeId: string) {
    return this.messages.filter((m) => m.placeId === placeId).sort((a, b) => a.createdAt - b.createdAt);
  }
  async places(userId: string) {
    return this.placesList.filter((p) => !this.visible || this.visible(userId, p));
  }
  async people() {
    return this.peopleList;
  }
  async messagesAfter(placeId: string, after: number, limit: number) {
    return this.inPlace(placeId)
      .filter((m) => m.createdAt > after)
      .slice(0, limit);
  }
  async messagesBefore(placeId: string, before: number, since: number, limit: number) {
    return this.inPlace(placeId)
      .filter((m) => m.createdAt < before && m.createdAt > since)
      .slice(-limit);
  }
  async messagesByIds(ids: string[]) {
    const want = new Set(ids);
    return this.messages.filter((m) => want.has(m.id));
  }
  async latestAt(placeIds: string[]) {
    const out = new Map<string, number>();
    for (const id of placeIds) {
      const list = this.inPlace(id);
      if (list.length) out.set(id, list[list.length - 1].createdAt);
    }
    return out;
  }
}
