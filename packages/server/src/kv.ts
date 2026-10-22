import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "@netlify/blobs";

// Key-value storage behind every runtime store (no database). Netlify Blobs in production,
// JSON files under .openbrain/store/ for `openbrain serve`, memory for tests. JSON values only.

export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys starting with the prefix, sorted. */
  list(prefix: string): Promise<string[]>;
}

export type StoreName = "reports" | "conversations" | "usage" | "settings" | "ratelimit";

export type KVFactory = (name: StoreName) => KV;

export class MemoryKV implements KV {
  private readonly data = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.data.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

export function memoryKVFactory(): KVFactory {
  const stores = new Map<StoreName, MemoryKV>();
  return (name) => {
    let store = stores.get(name);
    if (!store) {
      store = new MemoryKV();
      stores.set(name, store);
    }
    return store;
  };
}

/** Keys are "a/b/c" paths: each segment is URI-encoded so any character is safe on disk. */
function encodeKey(key: string): string {
  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new Error(`invalid store key "${key}"`);
  return segments.map((s) => encodeURIComponent(s)).join("/");
}

function decodeKey(file: string): string {
  return file
    .split("/")
    .map((s) => decodeURIComponent(s))
    .join("/");
}

export class FileKV implements KV {
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    return path.join(this.dir, `${encodeKey(key)}.json`);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.file(key), "utf8")) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), "utf8");
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (entry.name.endsWith(".json")) keys.push(decodeKey(childRel.slice(0, -5)));
      }
    };
    await walk(this.dir, "");
    return keys.filter((k) => k.startsWith(prefix)).sort();
  }
}

export function fileKVFactory(root: string): KVFactory {
  return (name) => new FileKV(path.join(root, ".openbrain", "store", name));
}

/** Netlify Blobs, one store per domain. Strong consistency: a report written now is listed by the admin now. */
export class BlobsKV implements KV {
  private handle: ReturnType<typeof getStore> | null = null;

  constructor(private readonly name: StoreName) {}

  /** Created on first use: the Blobs context only exists inside a Netlify request. */
  private get store(): ReturnType<typeof getStore> {
    this.handle ??= getStore({ name: `openbrain-${this.name}`, consistency: "strong" });
    return this.handle;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = (await this.store.get(key, { type: "json" })) as unknown;
    return value === null || value === undefined ? null : (value as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.store.setJSON(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.store.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const page of this.store.list({ prefix, paginate: true })) {
      for (const blob of page.blobs) keys.push(blob.key);
    }
    return keys.sort();
  }
}

export function blobsKVFactory(): KVFactory {
  const cache = new Map<StoreName, BlobsKV>();
  return (name) => {
    let kv = cache.get(name);
    if (!kv) {
      kv = new BlobsKV(name);
      cache.set(name, kv);
    }
    return kv;
  };
}
