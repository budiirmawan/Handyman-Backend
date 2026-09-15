import type { Pool } from 'pg';

export type Seed = {
  id: string;
  run: (pool: Pool) => Promise<void>;
};
