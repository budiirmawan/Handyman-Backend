import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { api } from './helpers/http';

/**
 * CR-BE-MOB-01 PART 02 — Security OpenAPI contract.
 *
 * Documentation-only checks (no database):
 *  - every published Security operation exists in a BE-12 / BE-21 route file;
 *  - every operational route in the PART 02 surface is documented;
 *  - schemas expose the implemented DTO fields and authoritative enums;
 *  - reuse boundaries are preserved (patrol execution id = BE-07 task id,
 *    security finding workflow keyed by the BE-09 findingId, checkpoint
 *    confirmation by canonical pointId — never by an invented QR target);
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

/** BE-12 Security + BE-21A/B Incident modules in the PART 02 surface. */
const SECURITY_MODULES = [
  'security-posts',
  'patrol-routes',
  'patrol-schedule-bindings',
  'patrol-executions',
  'patrol-checklist-bindings',
  'security-daily-activity',
  'security-findings',
  'incidents',
  'operational-incidents',
];

/** PART 02 published surface — existing BE-12 / BE-21 routes only. */
const DOCUMENTED_SECURITY_PATHS: Record<string, string[]> = {
  // BE-12A Security Post
  '/buildings/{buildingId}/security-posts': ['get', 'post'],
  '/security/posts/{id}': ['get', 'patch'],
  // BE-12B Patrol Route + checkpoints
  '/buildings/{buildingId}/security/patrol-routes': ['get', 'post'],
  '/security/patrol-routes/{id}': ['get', 'patch'],
  '/security/patrol-routes/{id}/points': ['get', 'post'],
  '/security/patrol-route-points/{id}': ['patch'],
  // BE-12C Patrol Schedule Binding
  '/security/patrol-routes/{id}/schedule-bindings': ['get', 'post'],
  '/security/patrol-schedule-bindings/{id}': ['get', 'patch'],
  // BE-12D Patrol Execution + checkpoint confirmation
  '/buildings/{buildingId}/security/patrol-executions': ['get'],
  '/security/patrol-executions/{id}': ['get'],
  '/security/patrol-executions/{id}/start': ['post'],
  '/security/patrol-executions/{id}/points': ['get'],
  '/security/patrol-executions/{id}/points/{pointId}/visit': ['post'],
  '/security/patrol-executions/{id}/complete': ['post'],
  '/security/patrol-point-visits/{id}': ['patch'],
  // BE-12E Patrol Checklist Binding
  '/security/patrol-checklist-bindings': ['get', 'post'],
  '/security/patrol-checklist-bindings/{id}': ['get', 'patch'],
  '/security/patrol-checklist-bindings/{id}/start': ['post'],
  '/security/patrol-checklist-executions/{id}': ['get'],
  // BE-12F Security Daily Activity
  '/buildings/{buildingId}/security/daily-activity': ['get'],
  // BE-12H Security Finding linkage
  '/security/findings': ['get', 'post'],
  '/security/findings/{id}': ['get'],
  // BE-21A Incident foundation
  '/incidents': ['get', 'post'],
  '/incidents/{id}': ['get', 'patch'],
  '/incidents/{id}/cancel': ['post'],
  // BE-21B Operational Incident (Security field reporting)
  '/operational-incidents': ['get', 'post'],
  '/operational-incidents/{id}': ['get', 'patch'],
};

const EXPECTED_OPERATION_IDS = [
  'createSecurityPost',
  'listBuildingSecurityPosts',
  'getSecurityPost',
  'updateSecurityPost',
  'createPatrolRoute',
  'listBuildingPatrolRoutes',
  'getPatrolRoute',
  'updatePatrolRoute',
  'addPatrolRoutePoint',
  'listPatrolRoutePoints',
  'updatePatrolRoutePoint',
  'createPatrolScheduleBinding',
  'listPatrolRouteScheduleBindings',
  'getPatrolScheduleBinding',
  'updatePatrolScheduleBinding',
  'listBuildingPatrolExecutions',
  'getPatrolExecution',
  'startPatrolExecution',
  'listPatrolPointVisits',
  'recordPatrolPointVisit',
  'completePatrolExecution',
  'updatePatrolPointVisit',
  'createPatrolChecklistBinding',
  'listPatrolChecklistBindings',
  'getPatrolChecklistBinding',
  'updatePatrolChecklistBinding',
  'startPatrolChecklistExecution',
  'getPatrolChecklistExecutionContext',
  'getSecurityDailyActivity',
  'createSecurityFinding',
  'listSecurityFindings',
  'getSecurityFinding',
  'createIncident',
  'listIncidents',
  'getIncident',
  'updateIncident',
  'cancelIncident',
  'createOperationalIncident',
  'listOperationalIncidents',
  'getOperationalIncident',
  'updateOperationalIncident',
];

/** Exact permission enforced by the router, per documented operation. */
const EXPECTED_PERMISSIONS: Record<string, string> = {
  createSecurityPost: 'security_post.manage',
  listBuildingSecurityPosts: 'security_post.read',
  getSecurityPost: 'security_post.read',
  updateSecurityPost: 'security_post.manage',
  createPatrolRoute: 'patrol_route.manage',
  listBuildingPatrolRoutes: 'patrol_route.read',
  getPatrolRoute: 'patrol_route.read',
  updatePatrolRoute: 'patrol_route.manage',
  addPatrolRoutePoint: 'patrol_route.manage',
  listPatrolRoutePoints: 'patrol_route.read',
  updatePatrolRoutePoint: 'patrol_route.manage',
  createPatrolScheduleBinding: 'patrol_schedule.manage',
  listPatrolRouteScheduleBindings: 'patrol_schedule.read',
  getPatrolScheduleBinding: 'patrol_schedule.read',
  updatePatrolScheduleBinding: 'patrol_schedule.manage',
  listBuildingPatrolExecutions: 'patrol_execution.read',
  getPatrolExecution: 'patrol_execution.read',
  startPatrolExecution: 'patrol_execution.manage',
  listPatrolPointVisits: 'patrol_execution.read',
  recordPatrolPointVisit: 'patrol_execution.manage',
  completePatrolExecution: 'patrol_execution.manage',
  updatePatrolPointVisit: 'patrol_execution.manage',
  createPatrolChecklistBinding: 'patrol_checklist_binding.manage',
  listPatrolChecklistBindings: 'patrol_checklist_binding.read',
  getPatrolChecklistBinding: 'patrol_checklist_binding.read',
  updatePatrolChecklistBinding: 'patrol_checklist_binding.manage',
  startPatrolChecklistExecution: 'patrol_checklist_binding.manage',
  getPatrolChecklistExecutionContext: 'patrol_checklist_binding.read',
  getSecurityDailyActivity: 'security_daily_activity.read',
  createSecurityFinding: 'security_finding.manage',
  listSecurityFindings: 'security_finding.read',
  getSecurityFinding: 'security_finding.read',
  createIncident: 'incident.manage',
  listIncidents: 'incident.read',
  getIncident: 'incident.read',
  updateIncident: 'incident.manage',
  cancelIncident: 'incident.manage',
  createOperationalIncident: 'operational_incident.manage',
  listOperationalIncidents: 'operational_incident.read',
  getOperationalIncident: 'operational_incident.read',
  updateOperationalIncident: 'operational_incident.manage',
};

describe('CR-BE-MOB-01 PART 02 — Security OpenAPI contract', () => {
  it('declares the Security tag and every PART 02 path + method', () => {
    assert.ok(
      (spec.tags ?? []).some((t: { name: string }) => t.name === 'Security'),
      'Security tag required',
    );
    for (const [path, methods] of Object.entries(DOCUMENTED_SECURITY_PATHS)) {
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
          (op.tags ?? []).includes('Security'),
          `${method} ${path} must be tagged Security`,
        );
      }
    }
  });

  it('publishes the expected stable operationIds', () => {
    const found = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_SECURITY_PATHS)) {
      for (const method of methods) {
        found.add(spec.paths[path][method].operationId);
      }
    }
    assert.deepEqual([...found].sort(), [...EXPECTED_OPERATION_IDS].sort());
  });

  it('documents only routes that exist in BE-12 / BE-21 modules', () => {
    const registered = new Set<string>();
    for (const moduleDir of SECURITY_MODULES) {
      for (const route of registeredRoutes(moduleDir)) registered.add(route);
    }
    for (const [path, methods] of Object.entries(DOCUMENTED_SECURITY_PATHS)) {
      for (const method of methods) {
        assert.ok(
          registered.has(`${method} ${toExpress(path)}`),
          `documented ${method} ${path} is not a registered backend route`,
        );
      }
    }
  });

  it('leaves no PART 02 operational BE-12 / BE-21 route undocumented', () => {
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(DOCUMENTED_SECURITY_PATHS)) {
      for (const method of methods) {
        documented.add(`${method} ${toExpress(path)}`);
      }
    }
    for (const moduleDir of SECURITY_MODULES) {
      for (const route of registeredRoutes(moduleDir)) {
        assert.ok(documented.has(route), `undocumented route: ${route}`);
      }
    }
  });

  it('records the exact RBAC permission and Building scope per operation', () => {
    for (const [path, methods] of Object.entries(DOCUMENTED_SECURITY_PATHS)) {
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
          (op.security ?? []).some((s: Record<string, unknown>) => 'bearerAuth' in s),
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

describe('Security schemas match implemented DTOs', () => {
  const schemas = spec.components.schemas;

  it('exposes the Security schemas', () => {
    for (const name of [
      'SecurityPost',
      'SecurityPostStatus',
      'SecurityPostType',
      'CreateSecurityPostRequest',
      'UpdateSecurityPostRequest',
      'PatrolRoute',
      'PatrolRouteStatus',
      'CreatePatrolRouteRequest',
      'UpdatePatrolRouteRequest',
      'PatrolRoutePoint',
      'PatrolRoutePointStatus',
      'CreatePatrolRoutePointRequest',
      'UpdatePatrolRoutePointRequest',
      'PatrolScheduleBinding',
      'PatrolScheduleBindingStatus',
      'CreatePatrolScheduleBindingRequest',
      'UpdatePatrolScheduleBindingRequest',
      'PatrolExecution',
      'PatrolExecutionStatus',
      'PatrolPointVisit',
      'RecordPatrolPointVisitRequest',
      'UpdatePatrolPointVisitRequest',
      'CompletePatrolExecutionRequest',
      'PatrolChecklistBinding',
      'PatrolChecklistBindingStatus',
      'CreatePatrolChecklistBindingRequest',
      'UpdatePatrolChecklistBindingRequest',
      'PatrolChecklistExecution',
      'PatrolChecklistExecutionContext',
      'SecurityDailyActivity',
      'SecurityDailyActivitySummary',
      'SecurityFinding',
      'SecurityFindingSourceType',
      'CreateSecurityFindingRequest',
      'Incident',
      'IncidentType',
      'IncidentStatus',
      'IncidentSeverity',
      'IncidentPriority',
      'IncidentLocationType',
      'CreateIncidentRequest',
      'UpdateIncidentRequest',
      'OperationalIncident',
      'OperationalIncidentCategory',
      'OperationalIncidentStatus',
      'OperationalIncidentAction',
      'CreateOperationalIncidentRequest',
      'UpdateOperationalIncidentRequest',
    ]) {
      assert.ok(schemas[name], `missing schema ${name}`);
    }
  });

  it('preserves authoritative status / category enums', () => {
    assert.deepEqual(schemas.PatrolExecutionStatus.enum, [
      'OPEN',
      'ASSIGNED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ]);
    assert.deepEqual(schemas.PatrolRouteStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.PatrolRoutePointStatus.enum, ['ACTIVE', 'INACTIVE']);
    assert.deepEqual(schemas.SecurityPostType.enum, [
      'GENERAL',
      'LOBBY',
      'GATE',
      'PERIMETER',
      'PARKING',
      'CONTROL_ROOM',
      'PATROL',
      'STANDBY',
      'OTHER',
    ]);
    assert.deepEqual(schemas.SecurityFindingSourceType.enum, [
      'PATROL_EXECUTION',
      'PATROL_CHECKLIST',
      'SECURITY_DAILY_ACTIVITY',
      'SHIFT_HANDOVER',
      'SECURITY_POST',
    ]);
    assert.deepEqual(schemas.IncidentType.enum, [
      'OPERATIONAL',
      'ASSET_FAILURE',
      'FINDING_ESCALATION',
    ]);
    assert.deepEqual(schemas.IncidentStatus.enum, [
      'REPORTED',
      'CANCELLED',
      'CLOSED',
    ]);
    assert.deepEqual(schemas.IncidentLocationType.enum, [
      'FLOOR',
      'AREA',
      'ROOM',
      'SPACE',
      'FUNCTIONAL_LOCATION',
    ]);
    assert.deepEqual(schemas.OperationalIncidentStatus.enum, [
      'OPEN',
      'IN_PROGRESS',
      'RESOLVED',
    ]);
    assert.deepEqual(schemas.OperationalIncidentAction.enum, [
      'START_PROGRESS',
      'RESOLVE',
      'REOPEN',
      'UPDATE_DETAILS',
    ]);
    assert.deepEqual(schemas.OperationalIncidentCategory.enum, [
      'UTILITY_FAILURE',
      'ELECTRICAL',
      'PLUMBING',
      'HVAC',
      'LIFT_ESCALATOR',
      'FIRE_SAFETY',
      'WATER_LEAK',
      'STRUCTURAL',
      'ENVIRONMENTAL',
      'HOUSEKEEPING',
      'SECURITY',
      'SAFETY',
      'ACCESS',
      'OTHER',
    ]);
  });

  it('preserves the reuse boundaries instead of inventing authorities', () => {
    // Patrol Execution IS a BE-07 generated task.
    assert.ok(schemas.PatrolExecution.properties.taskId);
    assert.ok(schemas.PatrolExecution.properties.pointProgress);
    // Checkpoint confirmation is by canonical point id, not a QR identifier.
    assert.ok(schemas.PatrolPointVisit.properties.patrolRoutePointId);
    assert.deepEqual(
      Object.keys(schemas.RecordPatrolPointVisitRequest.properties),
      ['notes'],
    );
    // Security finding delegates workflow to BE-09.
    assert.ok(schemas.SecurityFinding.properties.findingId);
    assert.ok(schemas.SecurityFinding.properties.availableActions);
    assert.equal(
      schemas.SecurityFinding.properties.finding.$ref,
      '#/components/schemas/Finding',
    );
    // Patrol checklist execution is the shared BE-07 execution.
    assert.ok(schemas.PatrolChecklistExecution.properties.checklistTemplateId);
    assert.equal(
      schemas.PatrolChecklistExecutionContext.properties.execution.$ref,
      '#/components/schemas/PatrolChecklistExecution',
    );
    // Operational Incident specializes the BE-21A foundation.
    assert.deepEqual(schemas.OperationalIncident.properties.incidentType.enum, [
      'OPERATIONAL',
    ]);
    assert.ok(schemas.OperationalIncident.properties.availableActions);
  });

  it('does not invent a checkpoint, occurrence, or patrol-engine surface', () => {
    const invented = Object.keys(spec.paths).filter((p: string) =>
      /\/(checkpoints|occurrences|mobile\/(security|patrol))/.test(p),
    );
    assert.deepEqual(invented, []);
    const inventedSchemas = Object.keys(schemas).filter((n: string) =>
      /^(Checkpoint|Occurrence|MobilePatrol|MobileSecurity)/.test(n),
    );
    assert.deepEqual(inventedSchemas, []);
  });
});

describe('Security documented routes are registered (no invented endpoints)', () => {
  it('rejects unauthenticated requests with 401, never 404', async () => {
    const request = api();
    const id = '00000000-0000-4000-8000-000000000001';
    const samples: Array<{ method: 'get' | 'post' | 'patch'; path: string }> = [
      { method: 'get', path: `/buildings/${id}/security-posts` },
      { method: 'get', path: `/security/posts/${id}` },
      { method: 'get', path: `/buildings/${id}/security/patrol-routes` },
      { method: 'get', path: `/security/patrol-routes/${id}/points` },
      { method: 'patch', path: `/security/patrol-route-points/${id}` },
      { method: 'get', path: `/security/patrol-routes/${id}/schedule-bindings` },
      { method: 'get', path: `/buildings/${id}/security/patrol-executions` },
      { method: 'post', path: `/security/patrol-executions/${id}/start` },
      {
        method: 'post',
        path: `/security/patrol-executions/${id}/points/${id}/visit`,
      },
      { method: 'post', path: `/security/patrol-executions/${id}/complete` },
      { method: 'patch', path: `/security/patrol-point-visits/${id}` },
      { method: 'post', path: `/security/patrol-checklist-bindings/${id}/start` },
      { method: 'get', path: `/security/patrol-checklist-executions/${id}` },
      { method: 'get', path: `/buildings/${id}/security/daily-activity` },
      { method: 'get', path: '/security/findings' },
      { method: 'post', path: '/incidents' },
      { method: 'post', path: `/incidents/${id}/cancel` },
      { method: 'get', path: '/operational-incidents' },
    ];

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
