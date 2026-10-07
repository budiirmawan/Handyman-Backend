import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-01 PART 01 — Housekeeping OpenAPI contract.
 *
 * Documentation-only checks (no database):
 *  - every published Housekeeping operation exists in a BE-11 route file;
 *  - every operational BE-11 route in the PART 01 surface is documented;
 *  - schemas expose the implemented DTO fields and status enums;
 *  - unauthenticated calls are rejected by auth middleware (401), proving
 *    the path is registered and does not invent a new endpoint.
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

const HK_MODULES = [
  'daily-cleaning',
  'cleaning-assignments',
  'toilet-inspections',
  'public-area-inspections',
  'supervisor-inspections',
  'quality-audits',
  'housekeeping-findings',
  'housekeeping-evidence',
];

/** PART 01 published surface — existing BE-11 operational routes only. */
const DOCUMENTED_HK_PATHS: Record<string, string[]> = {
  '/buildings/{buildingId}/housekeeping/daily-cleaning': ['get'],
  '/housekeeping/daily-cleaning/{id}': ['get'],
  '/housekeeping/cleaning-areas/{id}/daily-cleaning': ['get'],
  '/housekeeping/daily-cleaning/{id}/assignments': ['get', 'post'],
  '/workforce/{workforceId}/housekeeping/daily-cleaning': ['get'],
  '/teams/{teamId}/housekeeping/daily-cleaning': ['get'],
  '/housekeeping/toilet-inspection-bindings': ['get', 'post'],
  '/housekeeping/toilet-inspection-bindings/{id}': ['get', 'patch'],
  '/housekeeping/toilet-inspection-bindings/{id}/start': ['post'],
  '/housekeeping/toilet-inspection-executions/{id}': ['get'],
  '/housekeeping/public-area-inspection-bindings': ['get', 'post'],
  '/housekeeping/public-area-inspection-bindings/{id}': ['get', 'patch'],
  '/housekeeping/public-area-inspection-bindings/{id}/start': ['post'],
  '/housekeeping/public-area-inspection-executions/{id}': ['get'],
  '/housekeeping/supervisor-inspections': ['get', 'post'],
  '/housekeeping/supervisor-inspections/{id}': ['get'],
  '/housekeeping/supervisor-inspections/{id}/decision': ['post'],
  '/housekeeping/quality-audits': ['get', 'post'],
  '/housekeeping/quality-audits/{id}': ['get', 'patch'],
  '/housekeeping/quality-audits/{id}/complete': ['post'],
  '/housekeeping/findings': ['get', 'post'],
  '/housekeeping/findings/{id}': ['get'],
  '/housekeeping/{sourceType}/{sourceId}/evidence-requirements': ['get'],
  '/housekeeping/{sourceType}/{sourceId}/evidence': ['get', 'post'],
};

const EXPECTED_OPERATION_IDS = [
  'listBuildingDailyCleaning',
  'getDailyCleaning',
  'listCleaningAreaDailyCleaning',
  'listDailyCleaningAssignments',
  'assignDailyCleaning',
  'listWorkforceDailyCleaning',
  'listTeamDailyCleaning',
  'listToiletInspectionBindings',
  'createToiletInspectionBinding',
  'getToiletInspectionBinding',
  'updateToiletInspectionBinding',
  'startToiletInspectionExecution',
  'getToiletInspectionExecution',
  'listPublicAreaInspectionBindings',
  'createPublicAreaInspectionBinding',
  'getPublicAreaInspectionBinding',
  'updatePublicAreaInspectionBinding',
  'startPublicAreaInspectionExecution',
  'getPublicAreaInspectionExecution',
  'listSupervisorInspections',
  'createSupervisorInspection',
  'getSupervisorInspection',
  'submitSupervisorInspectionDecision',
  'listQualityAudits',
  'createQualityAudit',
  'getQualityAudit',
  'updateQualityAudit',
  'completeQualityAudit',
  'listHousekeepingFindings',
  'createHousekeepingFinding',
  'getHousekeepingFinding',
  'listHousekeepingEvidenceRequirements',
  'listHousekeepingEvidence',
  'submitHousekeepingEvidence',
];

describe('CR-BE-MOB-01 PART 01 — Housekeeping OpenAPI contract', () => {
  it('declares the Housekeeping tag and every PART 01 path + method', () => {
    assert.ok(
      (spec.tags ?? []).some((t: { name: string }) => t.name === 'Housekeeping'),
      'Housekeeping tag required',
    );
    for (const [path, methods] of Object.entries(DOCUMENTED_HK_PATHS)) {
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
          (op.tags ?? []).includes('Housekeeping'),
          `${method} ${path} must be tagged Housekeeping`,
        );
      }
    }
  });

  it('publishes the expected stable operationIds', () => {
    const found = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_HK_PATHS)) {
      for (const method of methods) {
        found.add(spec.paths[path][method].operationId);
      }
    }
    assert.deepEqual(
      [...found].sort(),
      [...EXPECTED_OPERATION_IDS].sort(),
    );
  });

  it('documents only routes that exist in BE-11 operational modules', () => {
    const registered = new Set<string>();
    for (const moduleDir of HK_MODULES) {
      for (const route of registeredRoutes(moduleDir)) registered.add(route);
    }
    for (const [path, methods] of Object.entries(DOCUMENTED_HK_PATHS)) {
      for (const method of methods) {
        assert.ok(
          registered.has(`${method} ${toExpress(path)}`),
          `documented ${method} ${path} is not a registered backend route`,
        );
      }
    }
  });

  it('leaves no PART 01 operational BE-11 route undocumented', () => {
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_HK_PATHS)) {
      for (const method of methods) documented.add(`${method} ${toExpress(path)}`);
    }
    for (const moduleDir of HK_MODULES) {
      for (const route of registeredRoutes(moduleDir)) {
        assert.ok(documented.has(route), `undocumented route: ${route}`);
      }
    }
  });
});

describe('Housekeeping schemas match implemented DTOs', () => {
  const schemas = spec.components.schemas;

  it('exposes the Housekeeping schemas', () => {
    for (const name of [
      'DailyCleaning',
      'DailyCleaningStatus',
      'CleaningAssignment',
      'CreateCleaningAssignmentRequest',
      'ToiletInspectionBinding',
      'CreateToiletInspectionBindingRequest',
      'ToiletInspectionExecutionContext',
      'PublicAreaInspectionBinding',
      'CreatePublicAreaInspectionBindingRequest',
      'PublicAreaInspectionExecutionContext',
      'SupervisorInspection',
      'SupervisorInspectionDecision',
      'CreateSupervisorInspectionRequest',
      'SubmitSupervisorInspectionDecisionRequest',
      'QualityAudit',
      'QualityAuditResult',
      'CompleteQualityAuditRequest',
      'HousekeepingFinding',
      'HousekeepingFindingSourceType',
      'CreateHousekeepingFindingRequest',
      'HousekeepingEvidenceRequirement',
      'HousekeepingEvidenceSubmission',
      'SubmitHousekeepingEvidenceRequest',
      'HousekeepingEvidenceSourceType',
    ]) {
      assert.ok(schemas[name], `missing schema ${name}`);
    }
  });

  it('preserves authoritative status / decision enums', () => {
    assert.deepEqual(schemas.DailyCleaningStatus.enum, [
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ]);
    assert.deepEqual(schemas.SupervisorInspectionDecision.enum, [
      'APPROVED',
      'REJECTED',
      'REWORK_REQUIRED',
    ]);
    assert.deepEqual(schemas.QualityAuditResult.enum, [
      'PASS',
      'FAIL',
      'REWORK_REQUIRED',
    ]);
    assert.deepEqual(schemas.HousekeepingFindingSourceType.enum, [
      'DAILY_CLEANING',
      'TOILET_INSPECTION',
      'PUBLIC_AREA_INSPECTION',
      'SUPERVISOR_INSPECTION',
    ]);
    assert.deepEqual(schemas.HousekeepingEvidenceSourceType.enum, [
      'daily-cleaning',
      'toilet-inspections',
      'public-area-inspections',
      'supervisor-inspections',
      'findings',
    ]);
  });

  it('exposes daily-cleaning taskId and HK finding findingId', () => {
    assert.ok(schemas.DailyCleaning.properties.taskId);
    assert.ok(schemas.DailyCleaning.properties.id);
    assert.ok(schemas.HousekeepingFinding.properties.findingId);
    assert.ok(schemas.HousekeepingFinding.properties.availableActions);
  });
});

describe('Housekeeping documented routes are registered (no invented endpoints)', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const samples: Array<{ method: 'get' | 'post' | 'patch'; path: string }> = [
      { method: 'get', path: '/buildings/00000000-0000-4000-8000-000000000001/housekeeping/daily-cleaning' },
      { method: 'get', path: '/housekeeping/daily-cleaning/00000000-0000-4000-8000-000000000001' },
      { method: 'post', path: '/housekeeping/toilet-inspection-bindings' },
      { method: 'post', path: '/housekeeping/supervisor-inspections/00000000-0000-4000-8000-000000000001/decision' },
      { method: 'post', path: '/housekeeping/quality-audits/00000000-0000-4000-8000-000000000001/complete' },
      { method: 'get', path: '/housekeeping/findings' },
      { method: 'get', path: '/housekeeping/daily-cleaning/evidence-requirements'.replace(
        'daily-cleaning/evidence-requirements',
        'daily-cleaning/00000000-0000-4000-8000-000000000001/evidence-requirements',
      ) },
    ];
    // last sample rewritten clearly:
    samples[samples.length - 1] = {
      method: 'get',
      path: '/housekeeping/daily-cleaning/00000000-0000-4000-8000-000000000001/evidence-requirements',
    };

    for (const { method, path } of samples) {
      const response =
        method === 'get'
          ? await request.get(`${API_PREFIX}${path}`)
          : method === 'post'
            ? await request.post(`${API_PREFIX}${path}`).send({})
            : await request.patch(`${API_PREFIX}${path}`).send({});
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
