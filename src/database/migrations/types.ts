import type { PoolClient } from 'pg';

export type Migration = {
  id: string;
  up: (client: PoolClient) => Promise<void>;
  down: (client: PoolClient) => Promise<void>;
};
