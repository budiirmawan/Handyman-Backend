/**
 * W03 test-harness shim (scope item 12).
 *
 * `embedded-postgres@18.x` publishes its types through an `exports` map with no
 * `main`/`types` field, and this repo compiles with
 * `"moduleResolution": "Node"` — which ignores `exports`. The consequence is a
 * TS2307 on `import EmbeddedPostgres from 'embedded-postgres'` in every suite
 * that boots an embedded cluster, i.e. in 03B's, 03C's and 03D's tests alike.
 *
 * This declaration is included by `tsconfig.tests.json` only. `tsconfig.json`
 * keeps excluding `tests/`, so production compilation is untouched: the fix is
 * applied to the harness, not by loosening the shipped build.
 */
declare module 'embedded-postgres' {
  import type { Client } from 'pg';

  interface EmbeddedPostgresOptions {
    databaseDir: string;
    user?: string;
    password?: string;
    port?: number;
    persistent?: boolean;
    initdb?: unknown[];
    start?: unknown[];
    authMethod?: 'trust' | 'md5' | 'password' | 'scram-sha-256';
    [option: string]: unknown;
  }

  export default class EmbeddedPostgres {
    constructor(options?: EmbeddedPostgresOptions);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    restart(): Promise<void>;
    destroy(): Promise<void>;
    getPgClient(database?: string, host?: string, port?: number): Client;
  }
}
