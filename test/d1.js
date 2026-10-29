// Test helper (no tests in here): an in-memory database with every migration
// applied, plus just enough of the D1 API (prepare/bind/first/run/batch) on top
// of node:sqlite to run the Worker code against it.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationsDir = new URL('../migrations/', import.meta.url);

export function migratedDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrationsDir), 'utf8'));
  }
  return sqlite;
}

export function d1(sqlite) {
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...params) ?? null,
    run: async () => statement(sql, params).execute(),
    execute: () =>
      /\bRETURNING\b/i.test(sql)
        ? { results: sqlite.prepare(sql).all(...params) }
        : (sqlite.prepare(sql).run(...params), { results: [] }),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((s) => s.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
