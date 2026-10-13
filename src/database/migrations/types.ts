import type { PoolClient } from 'pg';

export type Migration = {
  id: string;
  /**
   * CR-HM-DB-OPT-01 — when `false`, `up`/`down` run OUTSIDE a transaction
   * block on a dedicated pooled client. Required for statements that
   * PostgreSQL forbids inside a transaction (e.g. CREATE/DROP INDEX
   * CONCURRENTLY). Defaults to `true`; every historical migration is
   * transactional and keeps its exact behavior. A non-transactional
   * migration must be idempotent-safe (IF NOT EXISTS / IF EXISTS) because a
   * mid-run failure is not rolled back by the framework.
   */
  transactional?: boolean;
  up: (client: PoolClient) => Promise<void>;
  down: (client: PoolClient) => Promise<void>;
};
