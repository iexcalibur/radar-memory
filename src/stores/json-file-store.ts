import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { InMemoryStore } from "./memory-store.js";

/** Memory kept in one JSON file: good for a single process, a prototype or a CLI. For a real
 *  multi-user app, implement MemoryStore over your database instead. */
export class JsonFileStore extends InMemoryStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, "utf8"));
  }
  protected override async changed() {
    // write to a temporary file, then swap it in, so a crash never leaves half a file
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
