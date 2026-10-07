/**
 * R13 — FINAL CLOSURE GUARD.
 *
 * HISTORICAL EVIDENCE FOR R13 ONLY. Pins the authoritative R13 end-state at HEAD so the wave
 * ("Reporting coverage, contract & delivery completion") closes as a coherent whole: one
 * governed 27-dataset vocabulary across runtime, registry and OpenAPI; the two-layer
 * fail-closed JSON permission authority; and the single shared 250k-cell export ceiling
 * flowing through one funnel to all four delivery formats.
 *
 * Deliberately NOT a permanent global invariant: later Reporting work may legitimately make
 * this guard stale — adding a dataset, moving the ceiling or changing the delivery
 * architecture is permitted future change, and the correct response is to retire or re-pin
 * this file, never to hold a newer wave to R13's frozen shape.
 *
 * METHOD — DB-free and lightweight. Only dependency-free surfaces are imported (dataset types,
 * the registry, the governed constant, the real router for its stack order); everything else is
 * pinned from whitespace-normalized source text plus explicit ordering checks. Detailed
 * behavioural coverage stays with the FIX 01/02/03 focused tests — this file pins ARCHITECTURE
 * AND AUTHORITY, re-running only the two boundary values needed to prove the ceiling is live.
 *
 * RECORDED NON-BLOCKING LIMITATIONS — deliberately NOT asserted, and they must not fail R13:
 * stale internal delivery docblocks; absent `x-required-permission` on `GET /reports/export`;
 * non-exhaustive OpenAPI per-dataset parameter schemas; no byte budget; no generation time
 * budget; R13 tests not yet CI-wired.
 *
 * OUT OF SCOPE — no background worker, queue, object storage, email or scheduled delivery is
 * required, introduced, or asserted as present.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { createReportingExportRouter } from '../src/modules/reporting-export/reporting-export.routes';
import { REPORTING_EXPORT_DATASET_REGISTRY } from '../src/modules/reporting-export/reporting-export.registry';
import {
  MAX_REPORT_EXPORT_CELLS,
  getReportingExport,
} from '../src/modules/reporting-export/reporting-export.service';
import { REPORTING_EXPORT_DATASETS } from '../src/modules/reporting-export/reporting-export.types';

const RE = 'src/modules/reporting-export';
const RA = 'src/modules/reporting-archives';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\s+/gu, ' ');
}

function openApi(): any {
  return parseYaml(readFileSync(resolve(process.cwd(), 'docs/api/openapi.yaml'), 'utf8'));
}

/** Asserts each anchor appears after the previous one, tolerating any formatting. */
function assertSourceOrder(text: string, anchors: readonly string[], label: string): void {
  let cursor = -1;
  for (const anchor of anchors) {
    const at = text.indexOf(anchor, cursor + 1);
    assert.ok(at > cursor, `${label}: "${anchor}" must appear in order`);
    cursor = at;
  }
}

test('pins the one governed 27-dataset vocabulary across runtime, registry and OpenAPI', () => {
  const runtime = [...REPORTING_EXPORT_DATASETS];
  const registry = Object.keys(REPORTING_EXPORT_DATASET_REGISTRY);
  const documented: string[] = openApi().components.schemas.ReportArchiveDataset.enum;

  assert.equal(runtime.length, 27);
  assert.equal(registry.length, 27);
  assert.equal(documented.length, 27);

  assert.deepEqual([...runtime].sort(), [...registry].sort());
  assert.deepEqual([...runtime].sort(), [...documented].sort());

  // Every adapter self-identifies with its own key and declares a dataset read permission.
  for (const dataset of runtime) {
    const adapter = REPORTING_EXPORT_DATASET_REGISTRY[dataset];
    assert.equal(adapter.dataset, dataset);
    assert.equal(typeof adapter.requiredReadPermission, 'string');
    assert.ok(adapter.requiredReadPermission.length > 0);
  }

  // The four R12 datasets are present in all three authorities.
  for (const dataset of [
    'ESG_METRIC_TREND',
    'ESG_WASTE_REGISTER',
    'UTILITY_CONSUMPTION_TREND',
    'PORTFOLIO_OPERATIONAL_COMPARISON',
  ]) {
    assert.ok(runtime.includes(dataset as never), `${dataset} in runtime authority`);
    assert.ok(registry.includes(dataset), `${dataset} in registry`);
    assert.ok(documented.includes(dataset), `${dataset} in OpenAPI`);
  }
});

test('keeps exactly one OpenAPI Reporting dataset enum', () => {
  const spec = openApi();
  const holders: string[] = [];
  (function walk(value: any, path: string): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value) && value.includes('SECURITY_PATROL')) holders.push(path);
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  })(spec, 'spec');

  assert.deepEqual(holders, ['spec.components.schemas.ReportArchiveDataset.enum']);
});

test('wires GET /reports/export as authentication → reporting_export.read → handler', () => {
  const router = createReportingExportRouter() as unknown as {
    stack: {
      route?: { path: string; methods: Record<string, boolean>; stack: { handle: { name: string } }[] };
    }[];
  };
  const layer = router.stack.find(
    (candidate) =>
      candidate.route?.path === '/reports/export' && candidate.route.methods.get === true,
  );
  assert.ok(layer?.route, 'GET /reports/export remains mounted');

  const handles = layer.route.stack.map((entry) => entry.handle);
  assert.equal(handles.length, 3, 'auth → route permission → handler');
  assert.equal(handles[0]?.name, 'authenticationMiddleware');
  assert.equal(handles[1]?.name, 'rbacMiddleware');
  assert.equal(handles[2]?.name, 'reportingExportHandler');

  const routes = source(`${RE}/reporting-export.routes.ts`);
  assert.ok(routes.includes("requirePermission('reporting_export.read')"));
  assert.ok(routes.includes('authenticationMiddleware'));
});

test('enforces the registry-declared dataset permission with no hardcoded dataset map', () => {
  const controller = source(`${RE}/reporting-export.controller.ts`);

  // Adapter comes from the registry and the assertion reads its own declaration.
  assert.ok(controller.includes('getReportingExportDatasetAdapter(filters.dataset)'));
  assert.ok(controller.includes('permissions.includes(adapter.requiredReadPermission)'));
  assert.ok(controller.includes('throw permissionDeniedError()'));

  // Ordering: adapter → permissions → assertion → execution.
  assertSourceOrder(
    controller,
    [
      'getReportingExportDatasetAdapter(filters.dataset)',
      'resolvePermissionsForUser',
      'adapter.requiredReadPermission',
      'permissionDeniedError()',
      'getReportingExport(filters, req.auth.userId)',
    ],
    'controller authority order',
  );

  // No second dataset→permission map and no dataset identity in controller logic.
  for (const dataset of REPORTING_EXPORT_DATASETS) {
    assert.equal(controller.includes(dataset), false, `${dataset} must not appear`);
  }
  const permissionLiterals = controller.match(/'[a-z_]+\.[a-z_]+'/gu) ?? [];
  assert.deepEqual(permissionLiterals, []);
});

test('pins the governed export ceiling constant', () => {
  assert.equal(MAX_REPORT_EXPORT_CELLS, 250_000);
  const service = source(`${RE}/reporting-export.service.ts`);
  assert.ok(service.includes('MAX_REPORT_EXPORT_CELLS = 250_000'));
  // A backend authority, never configuration or request input.
  assert.equal(service.includes('process.env'), false);
  assert.equal(service.includes('getAppConfig'), false);
});

test('keeps the shared cell counting authority over rows and columns', () => {
  const service = source(`${RE}/reporting-export.service.ts`);

  assert.ok(service.includes('rows.length * columns.length'));
  assert.ok(service.includes('totalCells += tableCells'));
  // The derived `rowCount` metadata field is never read as the authority (the prose in the
  // docblock may name it; the counting code must not dereference it), and nothing truncates.
  assert.equal(service.includes('.rowCount'), false);
  assert.equal(service.includes('.slice('), false);
  assert.equal(service.includes('.splice('), false);
  // Unsafe arithmetic fails closed rather than clamping.
  assert.ok(service.includes('Number.isSafeInteger(tableCells)'));
  assert.ok(service.includes('Number.isSafeInteger(totalCells)'));
});

test('enforces the shared ceiling after adapter.load and before the snapshot returns', () => {
  const service = source(`${RE}/reporting-export.service.ts`);

  assertSourceOrder(
    service,
    [
      'const result = await adapter.load(filters.passThrough, userId)',
      'assertReportingExportWithinCeiling(result.projected.tables)',
      'return { metadata: {',
    ],
    'service ceiling placement',
  );

  // Fail-closed direction: strict `>` rejects above the ceiling and allows exactly it.
  assert.ok(service.includes('totalCells > MAX_REPORT_EXPORT_CELLS'));
  assert.equal(service.includes('totalCells >= MAX_REPORT_EXPORT_CELLS'), false);
});

test('keeps the ceiling live and inclusive at the governed boundary', async () => {
  const registry = REPORTING_EXPORT_DATASET_REGISTRY as unknown as Record<string, unknown>;
  const original = registry.WORKFORCE;

  const stub = (shapes: readonly (readonly [number, number])[]) => ({
    dataset: 'WORKFORCE',
    datasetLabel: 'Workforce',
    sourceAuthority: 'R13 closure guard stub',
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
        projected: {
          kpis: [],
          tables: shapes.map(([rows, columns], index) => ({
            key: `t${index}`,
            label: `T${index}`,
            columns: Array.from({ length: columns }, (_, column) => ({
              key: `c${column}`,
              label: `C${column}`,
              type: 'STRING' as const,
            })),
            rows: Array.from({ length: rows }, () => ({})),
            rowCount: rows,
          })),
        },
        appliedFilters: {},
      };
    },
  });

  const invoke = () =>
    getReportingExport({ dataset: 'WORKFORCE', passThrough: {} }, 'closure-user');

  try {
    // Exactly 250000 cells is allowed; 250001 cells (500×500 + 1×1, summed) is rejected.
    registry.WORKFORCE = stub([[500, 500]]);
    assert.equal((await invoke()).tables.length, 1);

    registry.WORKFORCE = stub([
      [500, 500],
      [1, 1],
    ]);
    await assert.rejects(
      invoke,
      (error: any) => error?.statusCode === 400 && error?.code === 'VALIDATION_ERROR',
    );
  } finally {
    registry.WORKFORCE = original;
  }
});

test('routes archive generation through the shared funnel before renderer and storage', () => {
  const generation = source(`${RA}/reporting-archive-generation.service.ts`);

  assertSourceOrder(
    generation,
    [
      'const snapshot = await getReportingExport(',
      'renderReportArchiveArtifact(',
      'await storageBackend.put(storageKey',
    ],
    'archive funnel order',
  );

  // The archive keeps its own authority: generate + adapter read permission, and the
  // generic safe-failure path is unchanged by R13.
  assert.ok(generation.includes("const required = ['report_export.generate', adapter.requiredReadPermission]"));
  assert.ok(generation.includes("failureCode: 'REPORT_EXPORT_GENERATION_FAILED'"));
  assert.ok(generation.includes("failureMessage: 'Report export generation failed.'"));

  const archiveService = source(`${RA}/reporting-archive.service.ts`);
  assert.ok(archiveService.includes('assertDatasetReadPermission(input.dataset, userId)'));
  assert.ok(
    archiveService.includes('getReportingExportDatasetAdapter(dataset).requiredReadPermission'),
  );
});

test('preserves PDF additional limits alongside the shared ceiling', () => {
  const pdf = source(`${RE}/pdf-renderer.ts`);
  for (const limit of [
    'const MAX_PDF_PAGES = 200;',
    'const MAX_TABLES = 100;',
    'const MAX_COLUMNS = 50;',
    'const MAX_CELL_LINES = 3;',
  ]) {
    assert.ok(pdf.includes(limit), `${limit} must remain`);
  }
});

test('points every Reporting dataset selector at the one shared schema', () => {
  const spec = openApi();
  const ref = '#/components/schemas/ReportArchiveDataset';
  const selectorRef = (parameters: any[] | undefined): unknown =>
    parameters?.find((parameter) => parameter.name === 'dataset')?.schema?.$ref;

  assert.equal(selectorRef(spec.paths['/reports/export'].get.parameters), ref);
  assert.equal(selectorRef(spec.paths['/reporting/archives'].get.parameters), ref);
  assert.equal(spec.components.schemas.CreateReportArchiveRequest.properties.dataset.$ref, ref);
  assert.equal(spec.components.schemas.ReportArchive.properties.dataset.$ref, ref);
});

test('introduces no background, queue, email or object-storage execution in the R13 surface', () => {
  const files = [
    `${RE}/reporting-export.routes.ts`,
    `${RE}/reporting-export.controller.ts`,
    `${RE}/reporting-export.service.ts`,
  ];
  const tokens = [
    'setInterval', 'setTimeout', 'node-cron', 'bull', 'amqp', 'kafka',
    'nodemailer', 'sendEmail', 'aws-sdk', 'minio', 'S3Client',
  ];
  for (const file of files) {
    const text = source(file);
    for (const token of tokens) {
      assert.equal(text.includes(token), false, `${file}: no ${token}`);
    }
  }
});

test('records the non-blocking metadata gap without treating it as a closure failure', () => {
  // The frozen R13 decision is that missing `x-required-permission` on GET /reports/export is
  // NON-BLOCKING because the permission requirement is stated in the operation itself. This
  // asserts the substantive requirement is documented; it deliberately does NOT assert the
  // extension is present, so closing R13 does not depend on future metadata cleanup.
  const operation = openApi().paths['/reports/export'].get;
  assert.match(String(operation.description), /reporting_export\.read/u);
  assert.ok(operation.security?.some((entry: any) => 'bearerAuth' in entry));
});
