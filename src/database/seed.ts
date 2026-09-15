import type { Pool } from 'pg';
import { seeds } from './seeds';

/**
 * Runs all registered seeds. Seeds are idempotent (upsert-style), so this is
 * safe to run repeatedly.
 */
export async function runSeeds(pool: Pool): Promise<string[]> {
  const applied: string[] = [];

  for (const seed of seeds) {
    await seed.run(pool);
    applied.push(seed.id);
  }

  return applied;
}
