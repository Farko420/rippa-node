/**
 * DESKTOP STORAGE PROVIDER (better-sqlite3)
 *
 * This file is NOT imported by mobile builds. It lives separately so webpack/esbuild
 * can tree-shake it and avoid pulling in Node builtins when targeting the browser.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "../utils/paths";
import type { StorageProvider, StorageRecord } from "./storage-provider";

const DB_FILENAME = "satellite.db";

/**
 * Desktop implementation: SQLite via better-sqlite3.
 */
export class DesktopStorageProvider implements StorageProvider {
  private db: Database.Database | null = null;

  async init(): Promise<void> {
    const dir = ensureDataDir();
    const dbPath = path.join(dir, DB_FILENAME);

    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    } catch {
      /* dir may already exist */
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");

    // Create the key-value store table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async get(key: string): Promise<unknown> {
    if (!this.db) return undefined;
    const row = this.db.prepare("SELECT value FROM kv_store WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    if (!this.db) return;
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    this.db.prepare("INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)").run(key, serialized);
  }

  async deleteKey(key: string): Promise<void> {
    if (!this.db) return;
    this.db.prepare("DELETE FROM kv_store WHERE key = ?").run(key);
  }

  async getAll(tableName: string, limit?: number): Promise<StorageRecord[]> {
    if (!this.db) return [];
    let sql = `SELECT * FROM ${this.escapeName(tableName)}`;
    if (limit) sql += ` LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all() as StorageRecord[];
    return rows || [];
  }

  async insert(tableName: string, record: StorageRecord): Promise<number | string> {
    if (!this.db) return 0;
    this.ensureTableExists(tableName);
    const keys = Object.keys(record);
    const placeholders = keys.map(() => "?").join(", ");
    const values = keys.map((k) => record[k]);
    const sql = `INSERT INTO ${this.escapeName(tableName)} (${keys.map((k) => this.escapeName(k)).join(", ")}) VALUES (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...values) as { lastInsertRowid: number };
    return result.lastInsertRowid;
  }

  async update(tableName: string, id: number | string, record: Partial<StorageRecord>): Promise<void> {
    if (!this.db) return;
    const keys = Object.keys(record);
    const sets = keys.map((k) => `${this.escapeName(k)} = ?`).join(", ");
    const values = keys.map((k) => record[k]);
    const sql = `UPDATE ${this.escapeName(tableName)} SET ${sets} WHERE id = ?`;
    this.db.prepare(sql).run(...values, id);
  }

  async deleteRecord(tableName: string, id: number | string): Promise<void> {
    if (!this.db) return;
    const sql = `DELETE FROM ${this.escapeName(tableName)} WHERE id = ?`;
    this.db.prepare(sql).run(id);
  }

  async query(tableName: string, predicate: (record: StorageRecord) => boolean): Promise<StorageRecord[]> {
    const rows = await this.getAll(tableName);
    return rows.filter(predicate);
  }

  private escapeName(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private ensureTableExists(tableName: string): void {
    if (!this.db) return;
    // Simple: assume caller knows what columns they need. A real impl would track schema.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.escapeName(tableName)} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT
      )
    `);
  }
}
