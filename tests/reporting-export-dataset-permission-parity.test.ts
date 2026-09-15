/**
 * R13 FIX 01 — JSON EXPORT DATASET PERMISSION PARITY.
 *
 * FOCUSED test for exactly one concern: `GET /reports/export` must require BOTH
 * `reporting_export.read` (the route delivery gate) AND the selected adapter's own
 * `requiredReadPermission` (the dataset capability), read from the Reporting adapter
 * registry rather than from any second dataset→permission map.
 *
 * METHOD — deliberately dependency-free and DATABASE-FREE. The real route, the real
 * `requirePermission` middleware closure and the real controller handler are exercised;
 * only the two outer boundaries are stubbed (`permissionService.resolvePermissionsForUser`
 * for the caller's permission set, `reportingExportService.getReportingExport` so no
 * dataset execution occurs). This keeps the file light: no PostgreSQL, no HTTP listener,
 * no migrations and no 27-dataset integration harness.
 *
 * The parity cases are REGISTRY-DRIVEN: the expected permission for each dataset is read
 * back off `REPORTING_EXPORT_DATASET_REGISTRY`, so the test proves the controller consults
 * the adapter declaration instead of hardcoding the 20 dataset permission codes. A leaked
 * execution counter also proves denial is fail-closed BEFORE dataset execution.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { permissionService } from '../src/modules/permissions';
import { reportingExportHandler } from '../src/modules/reporting-export/reporting-export.controller';
import { REPORTING_EXPORT_DATASET_REGISTRY } from '../src/modules/reporting-export/reporting-export.registry';
import { createReportingExportRouter } from '../src/modules/reporting-export/reporting-export.routes';
import { reportingExportService } from '../src/modules/reporting-export/reporting-export.service';
import type { PublicReportingExport } from '../src/modules/reporting-export/reporting-export.types';

const REPORTING_EXPORT_READ = 'reporting_export.read';
const MANAGEMENT_PERMISSION = 'management_read_model.read';
const PERMISSION_DENIED = 'PERMISSION_DENIED';
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const AUTHENTICATION_REQUIRED = 'AUTHENTICATION_REQUIRED';

type Registry = typeof REPORTING_EXPORT_DATASET_REGISTRY;
type Dataset = keyof Registry;

const DATASETS = Object.keys(REPORTING_EXPORT_DATASET_REGISTRY) as Dataset[];
const DATASET_PERMISSIONS = [...new Set(DATASETS.map(permissionFor))];

function permissionFor(dataset: Dataset): string {
  return REPORTING_EXPORT_DATASET_REGISTRY[dataset].requiredReadPermission;
}

/** Minimal canonical snapshot; dataset execution is stubbed, so this is never rendered. */
const SNAPSHOT: PublicReportingExport = {
  metadata: {
    dataset: 'WORKFORCE',
    datasetLabel: 'Workforce',
    buildingId: null,
    buildingScope: [],
    period: { dateFrom: null, dateTo: null },
    filters: {},
    asOf: '2026-09-14T00:00:00.000Z',
  },
  kpis: [],
  tables: [],
  generatedAt: '2026-09-14T00:00:01.000Z',
};

type CapturedError = { statusCode?: number; code?: string } | null;

type Outcome = {
  status: number;
  error: CapturedError;
  payload: { success?: boolean; data?: unknown } | undefined;
};

function fakeResponse(): Response & { statusCode: number; payload: unknown } {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.payload = body;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}

/** Drives the real controller handler with a fake request and no database. */
async function invokeHandler(
  query: Record<string, unknown>,
  authenticated = true,
): Promise<Outcome> {
  const req = {
    auth: authenticated ? { userId: 'parity-user' } : undefined,
    query,
  } as unknown as Request;
  const res = fakeResponse();
  let error: unknown = null;
  const next = ((err?: unknown) => {
    error = err ?? null;
  }) as unknown as NextFunction;

  await reportingExportHandler(req, res, next);

  const appError = error as CapturedError;
  return {
    status: appError ? (appError.statusCode ?? 0) : res.statusCode,
    error: appError,
    payload: res.payload as Outcome['payload'],
  };
}

/** Drives one real route middleware with a fake request and no database. */
async function invokeMiddleware(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
  authenticated: boolean,
): Promise<{ allowed: boolean; error: CapturedError }> {
  const req = {
    auth: authenticated ? { userId: 'parity-user' } : undefined,
    query: {},
  } as unknown as Request;
  const res = fakeResponse();
  let error: unknown = null;
  let allowed = false;
  const next = ((err?: unknown) => {
    if (err) error = err;
    else allowed = true;
  }) as unknown as NextFunction;

  await handler(req, res, next);
  return { allowed, error: error as CapturedError };
}

test('denies every registered dataset when the caller holds only reporting_export.read', async (t) => {
  let executions = 0;
  t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => [REPORTING_EXPORT_READ],
  );
  t.mock.method(reportingExportService, 'getReportingExport', async () => {
    executions += 1;
    return SNAPSHOT;
  });

  assert.equal(DATASETS.length, 27);

  for (const dataset of DATASETS) {
    const outcome = await invokeHandler({ dataset });
    assert.equal(outcome.status, 403, `${dataset} must be denied`);
    assert.equal(outcome.error?.code, PERMISSION_DENIED, `${dataset}`);
    assert.equal(outcome.payload, undefined, `${dataset} must not respond`);
  }

  assert.equal(
    executions,
    0,
    'a denied caller must never reach dataset execution',
  );
});

test('allows every registered dataset when the caller also holds that adapter requiredReadPermission', async (t) => {
  let executions = 0;
  let granted: string[] = [];
  t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => granted,
  );
  t.mock.method(reportingExportService, 'getReportingExport', async () => {
    executions += 1;
    return SNAPSHOT;
  });

  for (const dataset of DATASETS) {
    granted = [REPORTING_EXPORT_READ, permissionFor(dataset)];
    const outcome = await invokeHandler({ dataset });
    assert.equal(outcome.status, 200, `${dataset} must be allowed`);
    assert.equal(outcome.error, null, `${dataset}`);
    assert.equal(outcome.payload?.success, true, `${dataset}`);
    assert.deepEqual(outcome.payload?.data, SNAPSHOT, `${dataset}`);
  }

  assert.equal(executions, 27, 'each authorised dataset executes exactly once');
});

test('a different dataset permission never substitutes for the required one', async (t) => {
  let granted: string[] = [];
  t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => granted,
  );

  // ESG_METRIC_TREND declares `esg.read`; WORK_ORDER_REGISTER declares `work_order.read`.
  // Each is granted the OTHER dataset's permission and must still be denied, which is what
  // distinguishes a registry-driven check from a blanket allow.
  const crossCases: readonly [Dataset, string][] = [
    ['ESG_METRIC_TREND', 'work_order.read'],
    ['WORK_ORDER_REGISTER', 'esg.read'],
    ['RECEIVING_REGISTER', 'inventory_stock.read'],
    ['STOCK_MOVEMENT_REGISTER', 'receiving.read'],
  ];

  for (const [dataset, substituted] of crossCases) {
    assert.notEqual(
      permissionFor(dataset),
      substituted,
      `${dataset} substitution must be a different permission`,
    );
    granted = [REPORTING_EXPORT_READ, substituted];
    const outcome = await invokeHandler({ dataset });
    assert.equal(outcome.status, 403, `${dataset} must ignore ${substituted}`);
    assert.equal(outcome.error?.code, PERMISSION_DENIED, `${dataset}`);
  }
});

test('MANAGEMENT keeps management_read_model.read through the same registry-driven rule', async (t) => {
  let granted: string[] = [];
  let executions = 0;
  t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => granted,
  );
  t.mock.method(reportingExportService, 'getReportingExport', async () => {
    executions += 1;
    return SNAPSHOT;
  });

  const dataset: Dataset = 'MANAGEMENT_OPERATIONS_COMMAND_CENTER';
  assert.equal(permissionFor(dataset), MANAGEMENT_PERMISSION);

  granted = [REPORTING_EXPORT_READ];
  const denied = await invokeHandler({ dataset });
  assert.equal(denied.status, 403);
  assert.equal(denied.error?.code, PERMISSION_DENIED);

  // No other dataset permission stands in for the Management requirement.
  granted = [REPORTING_EXPORT_READ, 'work_order.read'];
  const stillDenied = await invokeHandler({ dataset });
  assert.equal(stillDenied.status, 403);

  granted = [REPORTING_EXPORT_READ, MANAGEMENT_PERMISSION];
  const allowed = await invokeHandler({ dataset });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.payload?.success, true);

  assert.equal(executions, 1, 'only the authorised call executes');
});

test('unknown and missing datasets still fail 400 before any permission resolution', async (t) => {
  const resolve = t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => [REPORTING_EXPORT_READ],
  );

  for (const query of [{ dataset: 'NOT_A_DATASET' }, {}, { dataset: '' }]) {
    const outcome = await invokeHandler(query);
    assert.equal(outcome.status, 400, JSON.stringify(query));
    assert.equal(outcome.error?.code, VALIDATION_ERROR, JSON.stringify(query));
  }

  assert.equal(
    resolve.mock.callCount(),
    0,
    'dataset validation precedes permission resolution',
  );
});

test('an unauthenticated request still fails 401', async () => {
  const outcome = await invokeHandler({ dataset: 'WORKFORCE' }, false);
  assert.equal(outcome.status, 401);
  assert.equal(outcome.error?.code, AUTHENTICATION_REQUIRED);
});

test('the route keeps authentication, the reporting_export.read gate and the handler in order', async (t) => {
  const router = createReportingExportRouter() as unknown as {
    stack: {
      route?: {
        path: string;
        methods: Record<string, boolean>;
        stack: { handle: { name: string } }[];
      };
    }[];
  };
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === '/reports/export' &&
      candidate.route.methods.get === true,
  );
  assert.ok(layer?.route, 'GET /reports/export remains mounted');

  const handles = layer.route.stack.map((entry) => entry.handle);
  const last = handles[handles.length - 1];
  assert.equal(handles.length, 3);
  assert.equal(handles[0]?.name, 'authenticationMiddleware');
  assert.equal(handles[1]?.name, 'rbacMiddleware');
  assert.equal(last, reportingExportHandler);

  const gate = handles[1] as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => unknown;

  let granted: string[] = [];
  t.mock.method(
    permissionService,
    'resolvePermissionsForUser',
    async () => granted,
  );

  // The delivery gate itself is unchanged: it is the `reporting_export.read` check.
  granted = [];
  const withoutDeliveryPermission = await invokeMiddleware(gate, true);
  assert.equal(withoutDeliveryPermission.allowed, false);
  assert.equal(withoutDeliveryPermission.error?.statusCode, 403);
  assert.equal(withoutDeliveryPermission.error?.code, PERMISSION_DENIED);

  granted = ['esg.read'];
  const wrongPermission = await invokeMiddleware(gate, true);
  assert.equal(wrongPermission.allowed, false);

  granted = [REPORTING_EXPORT_READ];
  const allowed = await invokeMiddleware(gate, true);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.error, null);

  const unauthenticated = await invokeMiddleware(gate, false);
  assert.equal(unauthenticated.allowed, false);
  assert.equal(unauthenticated.error?.code, AUTHENTICATION_REQUIRED);
});

test('the controller carries no hardcoded dataset permission map', () => {
  const source = readFileSync(
    resolve(__dirname, '../src/modules/reporting-export/reporting-export.controller.ts'),
    'utf8',
  );

  assert.match(source, /requiredReadPermission/u);

  for (const permission of DATASET_PERMISSIONS) {
    assert.equal(
      source.includes(`'${permission}'`),
      false,
      `${permission} must not be hardcoded in the controller`,
    );
    assert.equal(
      source.includes(`"${permission}"`),
      false,
      `${permission} must not be hardcoded in the controller`,
    );
  }

  // No dataset identity may appear either: no dataset-name inference, no special case.
  for (const dataset of DATASETS) {
    assert.equal(
      source.includes(dataset),
      false,
      `${dataset} must not appear in the controller`,
    );
  }
});
