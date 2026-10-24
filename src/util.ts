import { randomUUID } from "node:crypto";

export const newId = (prefix = "") => `${prefix}${randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** Text cut to `max` characters at a word, with an ellipsis. */
export function excerpt(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "23 Oct, 16:11", in the given time zone: how the model sees every time. */
export const dateFor = (timeZone: string) => (ts: number) =>
  new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone });

/** Strips the brackets and spaces a model sometimes puts around references like [m4]. */
export const clean = (ref: string) => ref.replace(/[[\]\s]/g, "");
