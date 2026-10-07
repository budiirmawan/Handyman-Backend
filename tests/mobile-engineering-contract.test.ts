import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-01 PART 03 — Engineering field / reading OpenAPI contract.
 *
 * Documentation-only checks (no database):
 *  - every published Engineering operation exists in a BE-10 route file;
 *  - every operational route in the PART 03 surface is documented;
 *  - schemas expose the implemented DTO fields and authoritative enums;
 *  - reuse boundaries are preserved (executions are BE-07 checklist
 *    executions / form instances, PM & corrective work are BE-07 tasks and
 *    BE-08 Work Orders, finding workflow is BE-09 keyed by findingId) and no
 *    diagnosis / test-result / per-reading-review domain is invented;
 *  - unauthenticated calls are rejected by auth middleware (401, never 404),
 *    proving the path is registered and no endpoint was invented.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');
const API_PREFIX = '/api/v1';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as any;

function toExpress(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

function registeredRoutes(moduleDir: string): Set<string> {
  const dir = resolve(__dirname, '../src/modules', moduleDir);
  const routes = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.routes.ts')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    const pattern = /router\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      routes.add(`${match[1]} ${match[2]}`);
    }
  }
  return routes;
}

/** BE-10 Engineering modules in the PART 03 surface (published in full). */
const ENGINEERING_MODULES = [
  'inspection-bindings',
  'meter-reading-bindings',
  'log-sheet-bindings',
  'engineering-checklist-bindings',
  'breakdown-bindings',
  'maintenance-bindings',
  'engineering-findings',
  'engineering-daily-operations',
  'engineering-overview',
  'shift-handovers',
];

/** PART 03 published surface — existing BE-10 routes only. */
const DOCUMENTED_ENGINEERING_PATHS: Record<string, string[]> = {
  // BE-10B equipment inspection
  '/assets/{assetId}/inspection-bindings': ['get', 'post'],
  '/buildings/{buildingId}/engineering/inspection-bindings': ['get'],
  '/engineering/inspection-bindings/{id}': ['get', 'patch'],
  '/engineering/inspection-bindings/{id}/start': ['post'],
  '/engineering/inspection-executions/{id}': ['get'],
  // BE-10C technical meter reading
  '/assets/{assetId}/meter-reading-bindings': ['get', 'post'],
  '/buildings/{buildingId}/engineering/meter-reading-bindings': ['get'],
  '/engineering/meter-reading-bindings/{id}': ['get', 'patch'],
  '/engineering/meter-reading-bindings/{id}/start': ['post'],
  '/engineering/meter-reading-executions/{id}': ['get'],
  '/engineering/meter-reading-executions/{id}/reading': ['put'],
  // BE-10D equipment log sheet
  '/assets/{assetId}/log-sheet-bindings': ['get', 'post'],
  '/buildings/{buildingId}/engineering/log-sheet-bindings': ['get'],
  '/engineering/log-sheet-bindings/{id}': ['get', 'patch'],
  '/engineering/log-sheet-bindings/{id}/start': ['post'],
  '/engineering/log-sheet-bindings/{id}/executions': ['get'],
  '/engineering/log-sheet-executions/{id}': ['get'],
  // BE-10E engineering checklist
  '/engineering/checklist-bindings': ['get', 'post'],
  '/engineering/checklist-bindings/{id}': ['get', 'patch'],
  '/engineering/checklist-bindings/{id}/start': ['post'],
  '/engineering/checklist-executions/{id}': ['get'],
  // BE-10F breakdown / corrective
  '/assets/{assetId}/breakdowns': ['get', 'post'],
  '/buildings/{buildingId}/engineering/breakdowns': ['get'],
  '/engineering/breakdowns/{id}': ['get', 'patch'],
  '/engineering/breakdowns/{id}/work-order': ['post'],
  // BE-10G planned maintenance
  '/assets/{assetId}/maintenance-bindings': ['get', 'post'],
  '/buildings/{buildingId}/engineering/maintenance-bindings': ['get'],
  '/engineering/maintenance-bindings/{id}': ['get', 'patch'],
  '/engineering/maintenance-bindings/{id}/schedule': ['post'],
  '/engineering/maintenance-bindings/{id}/task': ['post'],
  '/engineering/maintenance-bindings/{id}/work-order': ['post'],
  // BE-10H engineering finding linkage
  '/engineering/findings': ['get', 'post'],
  '/engineering/findings/{id}': ['get'],
  // BE-10A / BE-10K / BE-10J supervisor-relevant records
  '/buildings/{buildingId}/engineering/daily-operations': ['get'],
  '/buildings/{buildingId}/engineering/overview': ['get'],
  '/buildings/{buildingId}/engineering/shift-handovers': ['get', 'post'],
  '/engineering/shift-handovers/{id}': ['get', 'patch'],
  '/engineering/shift-handovers/{id}/ready': ['post'],
  '/engineering/shift-handovers/{id}/acknowledge': ['post'],
};

/** Exact permission enforced by the router, per documented operation. */
const EXPECTED_PERMISSIONS: Record<string, string> = {
  createInspectionBinding: 'inspection_binding.manage',
  listAssetInspectionBindings: 'inspection_binding.read',
  listBuildingInspectionBindings: 'inspection_binding.read',
  getInspectionBinding: 'inspection_binding.read',
  updateInspectionBinding: 'inspection_binding.manage',
  startInspectionExecution: 'inspection_binding.manage',
  getInspectionExecutionContext: 'inspection_binding.read',
  createMeterReadingBinding: 'meter_reading_binding.manage',
  listAssetMeterReadingBindings: 'meter_reading_binding.read',
  listBuildingMeterReadingBindings: 'meter_reading_binding.read',
  getMeterReadingBinding: 'meter_reading_binding.read',
  updateMeterReadingBinding: 'meter_reading_binding.manage',
  startMeterReadingExecution: 'meter_reading_binding.manage',
  submitMeterReading: 'meter_reading_binding.manage',
  getMeterReadingContext: 'meter_reading_binding.read',
  createLogSheetBinding: 'log_sheet_binding.manage',
  listAssetLogSheetBindings: 'log_sheet_binding.read',
  listBuildingLogSheetBindings: 'log_sheet_binding.read',
  getLogSheetBinding: 'log_sheet_binding.read',
  updateLogSheetBinding: 'log_sheet_binding.manage',
  startLogSheetExecution: 'log_sheet_binding.manage',
  listLogSheetExecutions: 'log_sheet_binding.read',
  getLogSheetExecutionContext: 'log_sheet_binding.read',
  createEngineeringChecklistBinding: 'engineering_checklist_binding.manage',
  listEngineeringChecklistBindings: 'engineering_checklist_binding.read',
  getEngineeringChecklistBinding: 'engineering_checklist_binding.read',
  updateEngineeringChecklistBinding: 'engineering_checklist_binding.manage',
  startEngineeringChecklistExecution: 'engineering_checklist_binding.manage',
  getEngineeringChecklistExecutionContext:
    'engineering_checklist_binding.read',
  createBreakdown: 'breakdown.manage',
  listAssetBreakdowns: 'breakdown.read',
  listBuildingBreakdowns: 'breakdown.read',
  getBreakdown: 'breakdown.read',
  closeBreakdown: 'breakdown.manage',
  linkBreakdownCorrectiveWorkOrder: 'breakdown.manage',
  createMaintenanceBinding: 'maintenance_binding.manage',
  listAssetMaintenanceBindings: 'maintenance_binding.read',
  listBuildingMaintenanceBindings: 'maintenance_binding.read',
  getMaintenanceBinding: 'maintenance_binding.read',
  updateMaintenanceBinding: 'maintenance_binding.manage',
  linkMaintenanceSchedule: 'maintenance_binding.manage',
  linkMaintenanceTask: 'maintenance_binding.manage',
  linkMaintenanceWorkOrder: 'maintenance_binding.manage',
  createEngineeringFinding: 'engineering_finding.manage',
  listEngineeringFindings: 'engineering_finding.read',
  getEngineeringFinding: 'engineering_finding.read',
  getEngineeringDailyOperations: 'engineering.read',
  getEngineeringOverview: 'engineering_overview.read',
  createEngineeringShiftHandover: 'shift_handover.manage',
  listEngineeringShiftHandovers: 'shift_handover.read',
  getEngineeringShiftHandover: 'shift_handover.read',
  updateEngineeringShiftHandover: 'shift_handover.manage',
  markEngineeringShiftHandoverReady: 'shift_handover.manage',
  acknowledgeEngineeringShiftHandover: 'shift_handover.manage',
};

describe('CR-BE-MOB-01 PART 03 — Engineering OpenAPI contract', () => {
  it('declares the Engineering tag and every PART 03 path + method', () => {
    assert.ok(
      (spec.tags ?? []).some(
        (t: { name: string }) => t.name === 'Engineering',
      ),
      'Engineering tag required',
    );
    for (const [path, methods] of Object.entries(
      DOCUMENTED_ENGINEERING_PATHS,
    )) {
      assert.ok(spec.paths[path], `missing path ${path}`);
      for (const method of methods) {
        const op = spec.paths[path][method];
        assert.ok(op, `missing ${method} ${path}`);
        assert.ok(op.operationId, `missing operationId on ${method} ${path}`);
        assert.ok(op.security, `missing security on ${method} ${path}`);
        assert.match(
          String(op.description ?? op.summary),
          /./,
          `missing description on ${method} ${path}`,
        );
        assert.ok(
          (op.tags ?? []).includes('Engineering'),
          `${method} ${path} must be tagged Engineering`,
        );
      }
    }
  });

  it('publishes the expected stable operationIds', () => {
    const found = new Set<string>();
    for (const [path, methods] of Object.entries(
      DOCUMENTED_ENGINEERING_PATHS,
    )) {
      for (const method of methods) {
        found.add(spec.paths[path][method].operationId);
      }
    }
    assert.deepEqual(
      [...found].sort(),
      Object.keys(EXPECTED_PERMISSIONS).sort(),
    );
  });

  it('documents only routes that exist in BE-10 modules', () => {
    const registered = new Set<string>();
    for (const moduleDir of ENGINEERING_MODULES) {
      for (const route of registeredRoutes(moduleDir)) registered.add(route);
    }
    for (const [path, methods] of Object.entries(
      DOCUMENTED_ENGINEERING_PATHS,
    )) {
      for (const method of methods) {
        assert.ok(
          registered.has(`${method} ${toExpress(path)}`),
          `documented ${method} ${path} is not a registered backend route`,
        );
      }
    }
  });

  it('leaves no PART 03 operational BE-10 route undocumented', () => {
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(
      DOCUMENTED_ENGINEERING_PATHS,
    )) {
      for (const method of methods) {
        documented.add(`${method} ${toExpress(path)}`);
      }
    }
    for (const moduleDir of ENGINEERING_MODULES) {
      for (const route of registeredRoutes(moduleDir)) {
        assert.ok(documented.has(route), `undocumented route: ${route}`);
      }
    }
  });

  it('records the exact RBAC permission and Building scope per operation', () => {
    for (const [path, methods] of Object.entries(
      DOCUMENTED_ENGINEERING_PATHS,
    )) {
      for (const method of methods) {
        const op = spec.paths[path][method];
        assert.equal(
          op['x-required-permission'],
          EXPECTED_PERMISSIONS[op.operationId],
          `wrong x-required-permission on ${op.operationId}`,
        );
        assert.equal(
          op['x-building-scoped'],
          true,
          `${op.operationId} must record Building isolation`,
        );
        assert.ok(
          (op.security ?? []).some(
            (s: Record<string, unknown>) => 'bearerAuth' in s,
          ),
          `${op.operationId} must require bearer auth`,
        );
        assert.ok(
          op.responses?.['401'] && op.responses?.['403'],
          `${op.operationId} must document 401 + 403`,
        );
      }
    }
  });
});

describe('Engineering schemas match implemented DTOs', () => {
  const schemas = spec.components.schemas;

  it('exposes the Engineering schemas', () => {
    for (const name of [
      'EngineeringBindingStatus',
      'EngineeringAssetRef',
      'EngineeringBuildingRef',
      'EngineeringFunctionalLocationRef',
      'InspectionBinding',
      'CreateInspectionBindingRequest',
      'UpdateInspectionBindingRequest',
      'InspectionExecution',
      'InspectionExecutionContext',
      'MeterReadingBinding',
      'CreateMeterReadingBindingRequest',
      'UpdateMeterReadingBindingRequest',
      'MeterReadingExecution',
      'SubmitMeterReadingRequest',
      'MeterReading',
      'MeterReadingContext',
      'LogSheetBinding',
      'CreateLogSheetBindingRequest',
      'UpdateLogSheetBindingRequest',
      'LogSheetExecution',
      'LogSheetExecutionContext',
      'EngineeringChecklistBinding',
      'CreateEngineeringChecklistBindingRequest',
      'UpdateEngineeringChecklistBindingRequest',
      'EngineeringChecklistExecution',
      'EngineeringChecklistExecutionContext',
      'BreakdownStatus',
      'BreakdownBinding',
      'CreateBreakdownRequest',
      'CloseBreakdownRequest',
      'LinkCorrectiveWorkOrderRequest',
      'MaintenanceType',
      'MaintenanceBinding',
      'CreateMaintenanceBindingRequest',
      'UpdateMaintenanceBindingRequest',
      'LinkMaintenanceScheduleRequest',
      'LinkMaintenanceTaskRequest',
      'LinkMaintenanceWorkOrderRequest',
      'EngineeringFinding',
      'EngineeringFindingOperationType',
      'CreateEngineeringFindingRequest',
      'EngineeringDailyOperations',
      'EngineeringDailyOperation',
      'EngineeringDailyOperationKind',
      'EngineeringDailyOperationsSummary',
      'EngineeringOverview',
      'EngineeringShiftContext',
      'EngineeringShiftHandover',
      'EngineeringShiftHandoverStatus',
      'EngineeringHandoverItem',
      'EngineeringHandoverDataset',
      'CreateEngineeringShiftHandoverRequest',
      'UpdateEngineeringShiftHandoverRequest',
    ]) {
      assert.ok(schemas[name], `missing schema ${name}`);
    }
  });

  it('preserves authoritative status / type enums', () => {
    assert.deepEqual(schemas.EngineeringBindingStatus.enum, [
      'ACTIVE',
      'INACTIVE',
    ]);
    assert.deepEqual(schemas.BreakdownStatus.enum, ['OPEN', 'CLOSED']);
    assert.deepEqual(schemas.CloseBreakdownRequest.properties.status.enum, [
      'CLOSED',
    ]);
    assert.deepEqual(schemas.MaintenanceType.enum, [
      'PREVENTIVE',
      'PREDICTIVE',
      'CONDITION_BASED',
      'CALIBRATION',
    ]);
    assert.deepEqual(schemas.EngineeringFindingOperationType.enum, [
      'EQUIPMENT_INSPECTION',
      'METER_READING',
      'EQUIPMENT_LOG_SHEET',
      'ENGINEERING_CHECKLIST',
      'BREAKDOWN',
      'MAINTENANCE',
    ]);
    assert.deepEqual(schemas.EngineeringShiftHandoverStatus.enum, [
      'DRAFT',
      'READY',
      'ACKNOWLEDGED',
    ]);
    assert.deepEqual(schemas.EngineeringDailyOperationKind.enum, [
      'TASK',
      'WORK_ORDER',
      'FINDING',
    ]);
    assert.deepEqual(schemas.EngineeringHandoverItem.properties.kind.enum, [
      'WORK_ORDER',
      'BREAKDOWN',
      'FINDING',
      'INSPECTION',
      'CHECKLIST',
      'METER_READING',
      'EQUIPMENT_LOG',
      'MAINTENANCE',
      'TASK',
    ]);
  });

  it('keeps executions on the shared BE-07 stores (authoritative ids)', () => {
    assert.ok(schemas.InspectionExecution.properties.checklistTemplateId);
    assert.ok(schemas.InspectionExecution.properties.inspectionBindingId);
    assert.ok(schemas.MeterReadingExecution.properties.formTemplateVersionId);
    assert.ok(schemas.LogSheetExecution.properties.formTemplateVersionId);
    assert.ok(
      schemas.EngineeringChecklistExecution.properties
        .engineeringChecklistBindingId,
    );
    // A reading is a BE-07 form_responses row, not a second measurement store.
    assert.ok(schemas.MeterReading.properties.formInstanceId);
    assert.ok(schemas.MeterReading.properties.versionFieldId);
    assert.ok(schemas.MeterReading.properties.uom);
    // The submit body carries the value only — range/UOM stay backend-owned.
    assert.deepEqual(
      Object.keys(schemas.SubmitMeterReadingRequest.properties).sort(),
      ['notes', 'value'],
    );
  });

  it('delegates PM / corrective execution and finding workflow', () => {
    // BE-10G references BE-07 schedule/tasks and a BE-08 Work Order.
    assert.ok(schemas.MaintenanceBinding.properties.schedule);
    assert.ok(schemas.MaintenanceBinding.properties.tasks);
    assert.ok(schemas.MaintenanceBinding.properties.workOrder);
    assert.ok(schemas.LinkMaintenanceTaskRequest.properties.taskId);
    // BE-10F projects the linked BE-08 corrective Work Order.
    assert.ok(schemas.BreakdownBinding.properties.corrective);
    // BE-10H delegates the whole finding workflow to BE-09.
    assert.ok(schemas.EngineeringFinding.properties.findingId);
    assert.ok(schemas.EngineeringFinding.properties.availableActions);
    assert.equal(
      schemas.EngineeringFinding.properties.finding.$ref,
      '#/components/schemas/Finding',
    );
    // BE-10A exposes availableActions for FINDING rows only (optional field).
    assert.ok(schemas.EngineeringDailyOperation.properties.availableActions);
    assert.ok(
      !schemas.EngineeringDailyOperation.required.includes('availableActions'),
      'availableActions must stay optional on daily operations',
    );
  });

  it('does not invent a diagnosis, test-result or reading-review surface', () => {
    const invented = Object.keys(spec.paths).filter((p: string) =>
      /\/(diagnoses|diagnosis|test-results|reading-reviews|mobile\/engineering)/.test(
        p,
      ),
    );
    assert.deepEqual(invented, []);
    const inventedSchemas = Object.keys(schemas).filter((n: string) =>
      /^(Diagnosis|TestResult|ReadingReview|MobileEngineering)/.test(n),
    );
    assert.deepEqual(inventedSchemas, []);
  });
});

describe('Engineering documented routes are registered (no invented endpoints)', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const id = '00000000-0000-4000-8000-000000000001';
    const samples: Array<{
      method: 'get' | 'post' | 'patch' | 'put';
      path: string;
    }> = [
      { method: 'get', path: `/assets/${id}/inspection-bindings` },
      { method: 'post', path: `/engineering/inspection-bindings/${id}/start` },
      { method: 'get', path: `/engineering/inspection-executions/${id}` },
      { method: 'get', path: `/assets/${id}/meter-reading-bindings` },
      { method: 'post', path: `/engineering/meter-reading-bindings/${id}/start` },
      { method: 'put', path: `/engineering/meter-reading-executions/${id}/reading` },
      { method: 'get', path: `/engineering/meter-reading-executions/${id}` },
      { method: 'get', path: `/engineering/log-sheet-bindings/${id}/executions` },
      { method: 'get', path: '/engineering/checklist-bindings' },
      { method: 'post', path: `/engineering/checklist-bindings/${id}/start` },
      { method: 'get', path: `/buildings/${id}/engineering/breakdowns` },
      { method: 'post', path: `/engineering/breakdowns/${id}/work-order` },
      { method: 'post', path: `/engineering/maintenance-bindings/${id}/task` },
      { method: 'get', path: '/engineering/findings' },
      { method: 'get', path: `/buildings/${id}/engineering/daily-operations` },
      { method: 'get', path: `/buildings/${id}/engineering/overview` },
      { method: 'get', path: `/buildings/${id}/engineering/shift-handovers` },
      { method: 'post', path: `/engineering/shift-handovers/${id}/acknowledge` },
    ];

    for (const { method, path } of samples) {
      const url = `${API_PREFIX}${path}`;
      const response =
        method === 'get'
          ? await request.get(url)
          : method === 'post'
            ? await request.post(url).send({})
            : method === 'put'
              ? await request.put(url).send({})
              : await request.patch(url).send({});
      assert.notEqual(
        response.status,
        404,
        `${method.toUpperCase()} ${path} is documented but not registered (got 404)`,
      );
      assert.equal(response.status, 401, `${path} must require authentication`);
      assert.equal(response.body.error.code, 'AUTHENTICATION_REQUIRED');
    }
  });
});
