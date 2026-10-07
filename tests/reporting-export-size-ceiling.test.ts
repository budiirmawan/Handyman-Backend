/**
 * R13 FIX 02 — REPORTING EXPORT SHARED CELL CEILING.
 *
 * FOCUSED, DB-FREE test for exactly one concern: the governed
 * `MAX_REPORT_EXPORT_CELLS` ceiling asserted by `getReportingExport` between
 * `adapter.load(...)` and snapshot return.
 *
 * METHOD — the real service and the real JSON controller handler are exercised;
 * the only substitution is the selected dataset adapter, installed by swapping
 * the WORKFORCE entry in `REPORTING_EXPORT_DATASET_REGISTRY` and always restored
 * afterwards. Synthetic tables are compact: the frozen formula reads only
 * `.length`, so shapes are ~500 rows / ~500 columns (a few hundred objects at
 * most) and never 250000 physical cells. Boundaries are derived from the
 * governed constant rather than duplicated as literals.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { permissionService } from '../src/modules/permissions';
import { reportingExportHandler } from '../src/modules/reporting-export/reporting-export.controller';
import { REPORTING_EXPORT_DATASET_REGISTRY } from '../src/modules/reporting-export/reporting-export.registry';
import {
  MAX_REPORT_EXPORT_CELLS,
  getReportingExport,
} from '../src/modules/reporting-export/reporting-export.service';
import type {
  PublicReportingExport,
  ReportingExportTable,
} from '../src/modules/reporting-export/reporting-export.types';

type CapturedError = { statusCode?: number; code?: string; message?: string; details?: unknown };

const REGISTRY = REPORTING_EXPORT_DATASET_REGISTRY as unknown as Record<
  string,
  unknown
>;

function table(
  rowCount: number,
  columnCount: number,
  key = 'stubTable',
): ReportingExportTable {
  return {
    key,
    label: key,
    columns: Array.from({ length: columnCount }, (_, index) => ({
      key: `c${index}`,
      label: `C${index}`,
      type: 'STRING' as const,
    })),
    rows: Array.from({ length: rowCount }, () => ({})),
    rowCount,
  };
}

function cells(tables: readonly ReportingExportTable[]): number {
  return tables.reduce(
    (total, entry) => total + entry.rows.length * entry.columns.length,
    0,
  );
}

/** Installs a controlled WORKFORCE adapter and returns its restore function. */
function installStubAdapter(tables: unknown): () => void {
  const original = REGISTRY.WORKFORCE;
  REGISTRY.WORKFORCE = {
    dataset: 'WORKFORCE',
    datasetLabel: 'Workforce',
    sourceAuthority: 'R13 FIX 02 test stub',
    requiredReadPermission: 'workforce_kpi.read',
    async load() {
      return {
        common: {
          buildingId: null,
          buildingScope: [],
          dateFrom: null,
          dateTo: null,
          asOf: '2026-09-14T00:00:00.000Z',
        },
        projected: { kpis: [], tables },
        appliedFilters: {},
      };
    },
  };
  return () => {
    REGISTRY.WORKFORCE = original;
  };
}

async function exportWith(tables: unknown): Promise<PublicReportingExport> {
  const restore = installStubAdapter(tables);
  try {
    return await getReportingExport(
      { dataset: 'WORKFORCE', passThrough: {} },
      'ceiling-user',
    );
  } finally {
    restore();
  }
}

async function exportError(tables: unknown): Promise<CapturedError> {
  try {
    await exportWith(tables);
  } catch (error) {
    return error as CapturedError;
  }
  throw new Error('expected the export ceiling to reject this snapshot');
}

test('allows one cell below the governed ceiling', async () => {
  const tables = [table(499, 501)];
  assert.equal(cells(tables), MAX_REPORT_EXPORT_CELLS - 1);

  const snapshot = await exportWith(tables);
  assert.equal(snapshot.tables.length, 1);
  assert.equal(snapshot.tables[0]!.rows.length, 499);
});

test('allows exactly the governed ceiling (inclusive boundary)', async () => {
  const tables = [table(500, 500)];
  assert.equal(cells(tables), MAX_REPORT_EXPORT_CELLS);

  const snapshot = await exportWith(tables);
  assert.equal(snapshot.tables.length, 1);
  assert.equal(snapshot.tables[0]!.columns.length, 500);
});

test('rejects one cell above the governed ceiling as VALIDATION_ERROR', async () => {
  const tables = [table(500, 500, 'wide'), table(1, 1, 'extra')];
  assert.equal(cells(tables), MAX_REPORT_EXPORT_CELLS + 1);

  const error = await exportError(tables);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'VALIDATION_ERROR');
  assert.match(
    String(error.message),
    new RegExp(`exceeds the maximum export size of ${MAX_REPORT_EXPORT_CELLS} cells`, 'u'),
  );
  assert.match(String(error.message), /narrow the filters and\/or date range/iu);
  assert.ok(Array.isArray(error.details) && error.details.length === 1);
});

test('sums cells across tables instead of applying a per-table ceiling', async () => {
  // Five tables, each individually far below the ceiling, together above it.
  const tables = [10, 20, 30, 40, 50].map((n) => table(10, 5001, `t${n}`));
  for (const entry of tables) {
    assert.ok(
      entry.rows.length * entry.columns.length < MAX_REPORT_EXPORT_CELLS,
      'each single table stays under the ceiling',
    );
  }
  assert.ok(cells(tables) > MAX_REPORT_EXPORT_CELLS);

  const error = await exportError(tables);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'VALIDATION_ERROR');
});

test('empty tables contribute zero cells', async () => {
  const tables = [table(500, 500, 'full'), table(0, 10, 'empty')];
  assert.equal(cells(tables), MAX_REPORT_EXPORT_CELLS);

  const snapshot = await exportWith(tables);
  assert.equal(snapshot.tables.length, 2);
  assert.equal(snapshot.tables[1]!.rows.length, 0);
});

test('an oversized export never reaches JSON delivery', async (t) => {
  t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => ['reporting_export.read', 'workforce_kpi.read'],
  );
  const restore = installStubAdapter([table(500, 500, 'wide'), table(1, 1, 'extra')]);
  assert.equal(cells([table(500, 500), table(1, 1)]), MAX_REPORT_EXPORT_CELLS + 1);

  let payload: unknown;
  const captured: { error: CapturedError | null } = { error: null };
  const res = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      payload = body;
      return res;
    },
  };
  const req = {
    auth: { userId: 'ceiling-user' },
    query: { dataset: 'WORKFORCE' },
  } as unknown as Request;

  try {
    await reportingExportHandler(
      req,
      res as unknown as Response,
      ((err?: unknown) => {
        captured.error = (err ?? null) as CapturedError | null;
      }) as unknown as NextFunction,
    );
  } finally {
    restore();
  }

  assert.equal(captured.error?.statusCode, 400);
  assert.equal(captured.error?.code, 'VALIDATION_ERROR');
  assert.equal(payload, undefined, 'no reporting payload may be delivered');
  assert.equal(res.statusCode, 200, 'no success status was written');
});

test('a small valid snapshot keeps the existing envelope shape', async () => {
  const tables = [table(2, 2, 'rows')];
  const snapshot = await exportWith(tables);

  assert.deepEqual(Object.keys(snapshot).sort(), [
    'generatedAt',
    'kpis',
    'metadata',
    'tables',
  ]);
  assert.equal(snapshot.metadata.dataset, 'WORKFORCE');
  assert.equal(snapshot.metadata.buildingId, null);
  assert.equal(snapshot.metadata.csvDefaultTableKey, undefined);
  assert.deepEqual(snapshot.kpis, []);
  assert.equal(snapshot.tables.length, 1);
  assert.deepEqual(snapshot.tables[0], tables[0]);
  assert.match(snapshot.generatedAt, /^\d{4}-\d{2}-\d{2}T/u);
});

test('an unmeasurable snapshot fails closed without leaking internals', async () => {
  // A malformed adapter result (non-array `rows`) makes the product non-finite.
  // The frozen rule is fail closed, and the refusal must stay client-safe.
  const malformed = [
    {
      key: 'broken',
      label: 'Broken',
      columns: table(0, 2).columns,
      rows: undefined,
      rowCount: 0,
    },
  ];
  assert.equal(Number.isSafeInteger(undefined as unknown as number), false);

  const error = await exportError(malformed);
  assert.equal(error.statusCode, 500);
  assert.equal(error.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(error.details, undefined);
  assert.doesNotMatch(
    String(error.message),
    /nan|sql|storage|memory|stack|postgres|byteLength/iu,
  );
});

test('the ceiling is a single shared constant with no dataset or format override', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const source = readFileSync(
    resolve(__dirname, '../src/modules/reporting-export/reporting-export.service.ts'),
    'utf8',
  );

  assert.equal(MAX_REPORT_EXPORT_CELLS, 250_000);
  assert.match(source, /MAX_REPORT_EXPORT_CELLS = 250_000/u);
  // The governed value is a backend authority, not configuration or input.
  assert.doesNotMatch(source, /process\.env|getAppConfig|config\./u);
  // No truncation/partial-delivery escape hatch in the bounded layer.
  assert.doesNotMatch(source, /\.slice\(|\.splice\(/u);
});
