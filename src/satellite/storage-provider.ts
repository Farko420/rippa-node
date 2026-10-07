/**
 * STORAGE PROVIDER ABSTRACTION
 *
 * Decouples persistence from the runtime. Desktop uses better-sqlite3 + fs;
 * Mobile uses IndexedDB / localStorage (or in-memory fallback for testing).
 */

export interface StorageRecord {
  id?: string | number;
  [key: string]: unknown;
}

export interface StorageProvider {
  // -- Initialization --
  init(): Promise<void>;
  close(): Promise<void>;

  // -- Key-value store (satellite state, configuration) --
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  deleteKey(key: string): Promise<void>;

  // -- Simple table operations --
  getAll(tableName: string, limit?: number): Promise<StorageRecord[]>;
  insert(tableName: string, record: StorageRecord): Promise<number | string>;
  update(tableName: string, id: number | string, record: Partial<StorageRecord>): Promise<void>;
  deleteRecord(tableName: string, id: number | string): Promise<void>;

  // -- Queries (simplified: no complex WHERE clauses) --
  query(tableName: string, predicate: (record: StorageRecord) => boolean): Promise<StorageRecord[]>;
}

/**
 * IN-MEMORY STORAGE (fallback, for testing and lightweight mobile builds).
 */
export class InMemoryStorage implements StorageProvider {
  private kvStore = new Map<string, unknown>();
  private tableStore = new Map<string, Map<string | number, StorageRecord>>();
  private nextId = new Map<string, number>();

  async init(): Promise<void> {
    // No-op
  }

  async close(): Promise<void> {
    // No-op
  }

  async get(key: string): Promise<unknown> {
    return this.kvStore.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.kvStore.set(key, value);
  }

  async deleteKey(key: string): Promise<void> {
    this.kvStore.delete(key);
  }

  async getAll(tableName: string, limit?: number): Promise<StorageRecord[]> {
    const table = this.tableStore.get(tableName);
    if (!table) return [];
    let result = Array.from(table.values());
    if (limit) result = result.slice(0, limit);
    return result;
  }

  async insert(tableName: string, record: StorageRecord): Promise<number | string> {
    if (!this.tableStore.has(tableName)) {
      this.tableStore.set(tableName, new Map());
      this.nextId.set(tableName, 1);
    }
    const table = this.tableStore.get(tableName)!;
    const id = record.id ?? (this.nextId.get(tableName) || 1);
    const nextIdVal = typeof id === "number" ? (id as number) + 1 : (id as string);
    this.nextId.set(tableName, typeof nextIdVal === "number" ? nextIdVal : 1);
    table.set(id, { ...record, id });
    return id;
  }

  async update(tableName: string, id: number | string, record: Partial<StorageRecord>): Promise<void> {
    const table = this.tableStore.get(tableName);
    if (!table) return;
    const existing = table.get(id);
    if (!existing) return;
    table.set(id, { ...existing, ...record, id });
  }

  async deleteRecord(tableName: string, id: number | string): Promise<void> {
    const table = this.tableStore.get(tableName);
    if (!table) return;
    table.delete(id);
  }

  async query(tableName: string, predicate: (record: StorageRecord) => boolean): Promise<StorageRecord[]> {
    const table = this.tableStore.get(tableName);
    if (!table) return [];
    return Array.from(table.values()).filter(predicate);
  }
}

/**
 * DESKTOP PROVIDER (uses better-sqlite3 + fs)
 * Implemented in a separate module to avoid importing Node builtins in mobile builds.
 *
 * NOTE: loaded via bundler-safe `require()` (not `import()`) so the `pkg`
 * snapshot can resolve it. Mobile builds never call this function, so the
 * desktop-only dependency is never loaded there.
 */
export async function createDesktopProvider(): Promise<StorageProvider> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DesktopStorageProvider } = require("./storage-desktop") as typeof import("./storage-desktop");
  return new DesktopStorageProvider();
}

/**
 * AUTO-DETECT PROVIDER
 * On mobile (Capacitor), returns in-memory; on desktop, returns SQLite.
 */
export async function createStorageProvider(): Promise<StorageProvider> {
  // Check if we're in a browser/Capacitor environment
  if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
    // Mobile: use in-memory for now (can be upgraded to IndexedDB later)
    return new InMemoryStorage();
  }

  // Desktop: use SQLite
  return createDesktopProvider();
}
