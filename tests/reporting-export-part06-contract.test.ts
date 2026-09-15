import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import { REPORTING_EXPORT_DATASETS } from '../src/modules/reporting-export/reporting-export.types';
import {
  REPORT_ARCHIVE_FORMATS,
  REPORT_ARCHIVE_STATUSES,
} from '../src/modules/reporting-archives/reporting-archive.types';

type OpenApiDocument = {
  paths: Record<string, any>;
  components: { schemas: Record<string, any> };
};

function openApi(): OpenApiDocument {
  return parseYaml(
    readFileSync(resolve(process.cwd(), 'docs/api/openapi.yaml'), 'utf8'),
  ) as OpenApiDocument;
}

test('documents exactly the runtime report archive paths and shared enums', () => {
  const spec = openApi();
  const expectedPaths = [
    '/reporting/exports',
    '/reporting/exports/{id}',
    '/reporting/archives',
    '/reporting/archives/{id}',
    '/reporting/archives/{id}/download',
  ];

  for (const path of expectedPaths) {
    assert.ok(spec.paths[path], `${path} must be documented`);
  }
  assert.equal(spec.paths['/reporting/exports'].post.operationId, 'createReportExport');
  assert.equal(spec.paths['/reporting/archives/{id}/download'].get.operationId, 'downloadReportArchive');

  assert.deepEqual(
    spec.components.schemas.ReportArchiveDataset.enum,
    [...REPORTING_EXPORT_DATASETS],
  );
  assert.deepEqual(
    spec.components.schemas.ReportArchiveFormat.enum,
    [...REPORT_ARCHIVE_FORMATS],
  );
  assert.deepEqual(
    spec.components.schemas.ReportArchiveStatus.enum,
    [...REPORT_ARCHIVE_STATUSES],
  );
});

test('keeps the documented dataset selector at exact 27/27 runtime parity', () => {
  const spec = openApi();
  const documented: string[] = spec.components.schemas.ReportArchiveDataset.enum;
  const runtime = [...REPORTING_EXPORT_DATASETS];

  // Count parity, derived from the runtime authority rather than repeated here.
  assert.equal(runtime.length, 27);
  assert.equal(documented.length, runtime.length);

  // No duplicate identifier, no extra non-runtime identifier.
  assert.equal(new Set(documented).size, documented.length);
  assert.deepEqual(
    documented.filter((dataset) => !runtime.includes(dataset as never)),
    [],
  );
  assert.deepEqual(
    runtime.filter((dataset) => !documented.includes(dataset)),
    [],
  );

  // The R12 pure adapters are documented, not silently absent.
  for (const dataset of [
    'ESG_METRIC_TREND',
    'ESG_WASTE_REGISTER',
    'UTILITY_CONSUMPTION_TREND',
    'PORTFOLIO_OPERATIONAL_COMPARISON',
  ]) {
    assert.ok(documented.includes(dataset), `${dataset} must be documented`);
  }

  // ONE shared enum authority: every selector references the same schema, so no
  // second copy of the 27 datasets can drift away from the runtime registry.
  const datasetSelectorRef = (parameters: any[] | undefined): unknown =>
    parameters?.find((parameter) => parameter.name === 'dataset')?.schema?.$ref;
  assert.equal(
    datasetSelectorRef(spec.paths['/reports/export'].get.parameters),
    '#/components/schemas/ReportArchiveDataset',
  );
  assert.equal(
    datasetSelectorRef(spec.paths['/reporting/archives'].get.parameters),
    '#/components/schemas/ReportArchiveDataset',
  );
  assert.equal(
    spec.components.schemas.CreateReportArchiveRequest.properties.dataset.$ref,
    '#/components/schemas/ReportArchiveDataset',
  );
  assert.equal(
    spec.components.schemas.ReportArchive.properties.dataset.$ref,
    '#/components/schemas/ReportArchiveDataset',
  );
});

test('aligns archive permissions, idempotency, response shape, and download media types', () => {
  const spec = openApi();
  const create = spec.paths['/reporting/exports'].post;
  const list = spec.paths['/reporting/archives'].get;
  const download = spec.paths['/reporting/archives/{id}/download'].get;

  assert.equal(create['x-required-permission'], 'report_export.generate');
  assert.equal(list['x-required-permission'], 'report_archive.read');
  assert.equal(download['x-required-permission'], 'report_archive.read');
  assert.ok(create.parameters.some((parameter: any) => parameter.name === 'Idempotency-Key'));

  const archive = spec.components.schemas.ReportArchive;
  assert.ok(archive.required.includes('filterSnapshot'));
  assert.ok(archive.required.includes('sourceProvenance'));
  assert.ok(archive.required.includes('artifact'));
  assert.ok(archive.properties.artifact);
  assert.equal(archive.properties.storageReference, undefined);

  assert.deepEqual(
    Object.keys(download.responses['200'].content).sort(),
    [
      'application/json',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
    ],
  );
  assert.ok(download.responses['200'].headers['Content-Disposition']);
  assert.ok(download.responses['200'].headers['Content-Length']);
  assert.equal(download.responses['404'].$ref, '#/components/responses/NotFound');
});

test('keeps route registration aligned with the documented five archive routes', () => {
  const routes = readFileSync(
    resolve(process.cwd(), 'src/modules/reporting-archives/reporting-archive.routes.ts'),
    'utf8',
  );
  for (const path of [
    "'/reporting/exports'",
    "'/reporting/exports/:id'",
    "'/reporting/archives'",
    "'/reporting/archives/:id'",
    "'/reporting/archives/:id/download'",
  ]) {
    assert.ok(routes.includes(path), `${path} must be registered`);
  }
});
