// Postgres (Bun's built-in client). Optional: without DATABASE_URL the agent
// runs and call logs go to stdout only.

import fs from 'node:fs';
import path from 'node:path';
import { SQL } from 'bun';

export const db: SQL | null = process.env.DATABASE_URL
    ? new SQL({ url: process.env.DATABASE_URL, max: 5, connectionTimeout: 10 })
    : null;

const MIGRATIONS = path.join(import.meta.dir, 'migrations');

/** Apply every migrations/*.sql not yet applied, in name order, each in its own transaction. */
export async function migrate(): Promise<void> {
    if (!db) return;
    await db`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const applied = new Set((await db`SELECT name FROM schema_migrations`).map((r: { name: string }) => r.name));
    for (const name of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
        if (applied.has(name)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
        await db.begin(async (tx) => {
            await tx.unsafe(sql);
            await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
        });
        console.log(`[db] applied ${name}`);
    }
}
