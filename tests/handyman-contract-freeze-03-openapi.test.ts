import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FOUNDATION_PERMISSIONS } from '../src/database/seeds/foundation-access.seed';
import { HANDYMAN_SERVICE_REQUEST_STATUSES } from '../src/modules/handyman-requests/handyman-service-request.types';
import {
  extractAllRuntimeRoutes,
  extractOpenApiOperations,
  findBrokenLocalRefs,
  loadSpec,
  SPEC_PATH,
} from './helpers/openapi-census';

/**
 * CR-HM-BACKEND-CONTRACT-FREEZE-03 — OpenAPI reconciliation guards.
 *
 * Freeze-03 changed documentation/metadata/schema shape only (no runtime
 * semantics). These guards pin the reconciled contract to its runtime
 * sources so the drift freeze-03 removed cannot silently return:
 * the CANCELLED lifecycle exit in the status vocabulary, complete
 * permission/error/security annotation of the 269 Handyman operations,
 * PIC-personal tenant-decision documentation, the BE-02G exact-Building
 * access wording, and typed finance/warranty + Care projection payloads.
 */
const spec = loadSpec() as any;
const specText = readFileSync(SPEC_PATH, 'utf8');

type Op = { operationId: string; method: string; path: string; op: any };
const handymanOps: Op[] = [];
const allIds = new Map<string, number>();
for (const [p, item] of Object.entries<any>(spec.paths)) {
  for (const [m, op] of Object.entries<any>(item as any)) {
    if (!op || !op.operationId) continue;
    allIds.set(op.operationId, (allIds.get(op.operationId) ?? 0) + 1);
    if (p.includes('/handyman')) {
      handymanOps.push({ operationId: op.operationId, method: m, path: p, op });
    }
  }
}
const byId = new Map(handymanOps.map((o) => [o.operationId, o]));
function op(id: string): any {
  const found = byId.get(id);
  assert.ok(found, `operation ${id} must be documented`);
  return found.op;
}
function collectKeys(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === key) out.push(v);
    collectKeys(v, key, out);
  }
  return out;
}

describe('CR-HM-BACKEND-CONTRACT-FREEZE-03 OpenAPI reconciliation', () => {
  // The release-integration surface (269 at freeze-03) grows additively and
  // the two release lines add DISJOINT operations, so the merged count is the
  // sum of both deltas:
  //   CR-HM-WORKER-COMPETENCY-01 PART 03A  +2  (.../competency/eligibility,
  //                                            .../competency/candidates)
  //   CR-HM-WORKER-COMPETENCY-01 PART 03B1 +1  (.../competency/history)
  //   CR-HM-ASSIGNMENT-RESPONSE-01 /
  //   CR-HM-FIELD-EXPENSE-HELPER-01        +15 (Execution Scope assignment
  //                                            response + response-history,
  //                                            field expense/reimbursement and
  //                                            helper attendance surfaces)
  //   269 + 3 + 15 = 287.
  //   CR-HM-FIELD-OPS-ACK-01 PART 02            +1  (.../arrival-challenge,
  //                                             the missing issuer command)
  //   287 + 1 = 288.
  //   CR-HM-FIELD-OPERATIONS-01 PART 04 (G-2/G-3, approved gate §8)
  //                                            +6  (arrival-location-identifier
  //                                                 register/list/deactivate,
  //                                                 geofence-policy put/get/
  //                                                 history)
  //   288 + 6 = 294.
  //   CR-HM-SERVICE-CATALOG-01 PART 01              +7  (parameterized
  //                                                  catalogue admin: category,
  //                                                  attribute, commercial
  //                                                  profile, price rule,
  //                                                  mixed request items,
  //                                                  quotation preparation and
  //                                                  the post-inspection
  //                                                  revision lane)
  // Deployed baseline 4529 adds 17 documented/runtime operations after the
  // previous 301-operation freeze, CR-HM-CARE-INTERNAL-NOTES-01 adds 6
  // Internal Notes operations, and CR-HM-CARE-UNLISTED-INTAKE PART 01 adds 14
  // Unlisted Service Intake + Internal Notes operations,
  // CR-HM-MANUAL-QUOTATION-01 PART 01 adds 2 Operations Unlisted-Intake
  // Triage operations (record + history read) and PART 02 adds 1 Operations
  // conversion operation. The equality assertion below guards parity; this
  // constant pins the reviewed surface size at the release baseline.
  it('keeps the 341-operation Handyman surface at exact runtime parity', () => {
    assert.equal(handymanOps.length, 341);
    const runtime = extractAllRuntimeRoutes()
      .filter((r) => r.path.includes('/handyman'))
      .map((r) => `${r.method} ${r.canon}`);
    const documented = extractOpenApiOperations(spec)
      .filter((o: any) => o.path.includes('/handyman'))
      .map((o: any) => `${o.method} ${o.canon}`);
    assert.deepEqual([...new Set(documented)].sort(), [...new Set(runtime)].sort());
  });

  it('has globally unique operationIds and no broken local $refs', () => {
    const dupes = [...allIds.entries()].filter(([, n]) => n > 1);
    assert.deepEqual(dupes, []);
    assert.deepEqual(findBrokenLocalRefs(spec), []);
  });

  it('carries CANCELLED in the request-status vocabulary, bound to the runtime const', () => {
    const schema = spec.components.schemas.HandymanServiceRequestStatus;
    assert.deepEqual(
      [...schema.enum].sort(),
      [...HANDYMAN_SERVICE_REQUEST_STATUSES].sort(),
    );
    assert.ok(schema.enum.includes('CANCELLED'));
    // The cancellation fact's previousStatus is the pre-cancellation state
    // BY DESIGN (migration 0459 CHECK) and must never gain CANCELLED.
    const prev =
      spec.components.schemas.HandymanRequestCancellation.properties
        .previousStatus;
    assert.deepEqual([...prev.enum].sort(), [
      'DIAGNOSIS',
      'INSPECTION_REQUIRED',
      'INTAKE',
      'READY_FOR_NEXT_STEP',
      'TRIAGE',
    ]);
    // The Care workspace list filter and the operational projection reuse
    // the frozen vocabulary instead of inlining divergent copies.
    const listStatus = (op('listCareWorkspaceRequests').parameters as any[]).find(
      (p) => p.name === 'status',
    );
    assert.equal(
      listStatus.schema.$ref,
      '#/components/schemas/HandymanServiceRequestStatus',
    );
    const projection =
      spec.components.schemas.CareHandymanOperationalProjection;
    assert.equal(
      projection.properties.request.properties.status.$ref,
      '#/components/schemas/HandymanServiceRequestStatus',
    );
  });

  it('annotates every Handyman operation with error codes and a security decision', () => {
    const schemes = new Set(Object.keys(spec.components.securitySchemes));
    const anonymous: string[] = [];
    for (const { operationId, op: operation } of handymanOps) {
      const errors = operation['x-error-codes'];
      assert.ok(
        Array.isArray(errors) && errors.length > 0,
        `${operationId} must declare x-error-codes`,
      );
      // Every operation documents how malformed input is refused: the
      // generic VALIDATION_ERROR/BAD_REQUEST, or — for finance-read/warranty
      // families whose services validate through domain `*_VALIDATION`
      // factories — that domain code. The only input-free operation is the
      // caller's own worker profile read.
      assert.ok(
        errors.includes('VALIDATION_ERROR') || errors.includes('BAD_REQUEST') ||
          errors.some((c: string) => c.endsWith('_VALIDATION')) ||
          operationId === 'getMyHandymanWorkerProfile',
        `${operationId} must document its validation refusal code`,
      );
      assert.ok('security' in operation, `${operationId} must decide security`);
      if (Array.isArray(operation.security) && operation.security.length === 0) {
        anonymous.push(operationId);
      }
      for (const requirement of operation.security ?? []) {
        for (const name of Object.keys(requirement)) {
          assert.ok(schemes.has(name), `${operationId} references undefined scheme ${name}`);
        }
      }
    }
    // The standalone represented-context create is the one credential-free
    // exchange (the body token IS the credential).
    assert.deepEqual(anonymous, ['createCareHandymanServiceRequest']);
  });

  it('only ever names seeded permissions in x-required-permission', () => {
    const seeded = new Set(FOUNDATION_PERMISSIONS.map((p) => p.code));
    let annotated = 0;
    for (const { operationId, op: operation } of handymanOps) {
      const permission = operation['x-required-permission'];
      if (permission === undefined) continue;
      annotated++;
      assert.ok(
        seeded.has(permission),
        `${operationId} names unseeded permission ${permission}`,
      );
    }
    // 173 route guards + 1 dual-guard op (first guard named) + 11
    // unconditional service-enforced permissions; the remaining 91 ops
    // are composite-authority (Crew Lead / workspace session / HMAC)
    // and must stay unannotated rather than name a misleading permission.
    // Route-guarded operations, same additive arithmetic as the surface pin:
    //   PART 03A  +2 (`tenant_company.read`)
    //   PART 03B1 +1 (`tenant_company.read` on `.../competency/history`)
    //   assignment-response / field-expense / helper-attendance +8
    //   179 + 3 + 8 = 190.
    //   CR-HM-FIELD-OPERATIONS-01 PART 04 +6 (3 `building_configuration.manage`
    //   writes + 3 `building_configuration.read` reads)
    //   190 + 6 = 196.
    //   CR-HM-SERVICE-CATALOG-01 PART 01 +7 route-guarded operations
    //   (`tenant_company.read` / `tenant_company.manage`).
    //   196 + 7 = 203 (previous freeze), +13 route-guarded baseline ops = 216,
    //   +2 Building Care internal-notes route-guarded ops = 218,
    //   +5 Building Care unlisted-intake route-guarded ops = 223,
    //   CR-HM-MANUAL-QUOTATION-01 PART 01 +1 Operations triage-decision
    //   write (`tenant_company.manage`; the history read stays on the
    //   composite Operations/Care read authority and remains unannotated),
    //   PART 02 +1 Operations conversion write (`tenant_company.manage`).
    assert.equal(annotated, 225);
  });

  it('pins the 11 service-enforced permissions freeze-03 documented', () => {
    const expected: Record<string, string> = {
      publishHandymanQcChecklistVersion: 'handyman.qc.configure',
      listHandymanQcChecklistVersions: 'handyman.qc.configure',
      bindHandymanQcChecklistVersion: 'handyman.qc.configure',
      reviewHandymanVariationOperations: 'tenant_company.manage',
      issueHandymanVariationRevisedQuotation: 'tenant_company.manage',
      authorizeHandymanVariationScope: 'tenant_company.manage',
      recordHandymanVariationFinalChargeEligibility: 'tenant_company.manage',
      listOperationsHandymanVariations: 'tenant_company.read',
      approveHandymanMaterialPurchase: 'tenant_company.manage',
      reconcileHandymanMaterialPurchase: 'tenant_company.manage',
      listOperationsHandymanMaterialPurchases: 'tenant_company.read',
    };
    for (const [id, permission] of Object.entries(expected)) {
      assert.equal(op(id)['x-required-permission'], permission, id);
    }
  });

  it('documents tenant decisions as PIC-personal, never staff/Care recorded', () => {
    const variationDecision = op('recordHandymanVariationTenantDecision');
    assert.ok(variationDecision.description.includes(
      'HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN'));
    assert.ok(variationDecision.description.includes('PIC-personal'));
    assert.ok(!variationDecision.description.includes(
      'Operations/Manager recording of the tenant outcome'));
    assert.ok(op('decideHandymanQuotation').description.includes(
      'assertHandymanTenantDecisionActor'));
  });

  it('keeps BE-02G exact-Building wording (client-level wall only where runtime keeps it)', () => {
    // Verified in freeze-03 against each owning service: these four are
    // the only Handyman descriptions where a client-level check remains
    // part of the runtime wall (the request list's per-row predicates,
    // the client-basis ledger read, provider performance, and the
    // dual-path provider availability read).
    const allowed = new Set([
      'listHandymanServiceRequests',
      'getHandymanClientCustomerLedger',
      'getHandymanProviderPerformance',
      'listHandymanProviderAvailability',
    ]);
    for (const { operationId, op: operation } of handymanOps) {
      if (
        typeof operation.description === 'string' &&
        operation.description.includes('canAccessClient')
      ) {
        assert.ok(
          allowed.has(operationId),
          `${operationId} cites the retired client-level wall`,
        );
      }
    }
  });

  it('carries no phantom error codes in prose or annotations', () => {
    // HANDYMAN_VARIATION_FORBIDDEN never existed in the runtime; the role
    // denial is HANDYMAN_VARIATION_ROLE_FORBIDDEN.
    assert.ok(!specText.includes('HANDYMAN_VARIATION_FORBIDDEN'));
    assert.ok(specText.includes('HANDYMAN_VARIATION_ROLE_FORBIDDEN'));
    // Care communications deliberately have no domain not-found code.
    assert.ok(!op('listHandymanCareCommunications').description.includes(
      'HANDYMAN_SERVICE_REQUEST_NOT_FOUND'));
  });

  it('defines and uses the tenant slot-choice HMAC scheme for the S2S door only', () => {
    const scheme = spec.components.securitySchemes.tenantSlotAssertionSignature;
    assert.ok(scheme, 'tenantSlotAssertionSignature must be defined');
    assert.equal(scheme.type, 'apiKey');
    assert.equal(scheme.in, 'header');
    assert.equal(scheme.name, 'x-handyman-tenant-slot-signature');
    assert.deepEqual(op('acceptTenantSlotChoice').security, [
      { tenantSlotAssertionSignature: [] },
    ]);
    // The Care-workspace payment-proof upload answers to the workspace
    // session credential, not a local User session.
    assert.deepEqual(op('uploadCareWorkspaceRequestPaymentProof').security, [
      { careWorkspaceSession: [] },
    ]);
  });

  it('types the 32 finance/warranty response payloads instead of bare objects', () => {
    const expected: Record<string, string> = {
      postHandymanCommercialAgreement: 'HandymanCommercialAgreementCommandResult',
      postHandymanCommercialAgreementVersionActivate: 'HandymanCommercialAgreementCommandResult',
      postHandymanCommercialAgreementVersionSupersede: 'HandymanCommercialAgreementCommandResult',
      postHandymanLaborPricingBasis: 'HandymanLaborPricingBasisPrepareResult',
      postHandymanMaterialPricingBasis: 'HandymanMaterialPricingBasisPrepareResult',
      postHandymanBmFeeRule: 'HandymanBmFeeRulePrepareResult',
      postHandymanBmFeeTerm: 'HandymanBmFeeTermPrepareResult',
      postHandymanBmFeeBeneficiary: 'HandymanBmFeeBeneficiaryPrepareResult',
      getHandymanPricingContract: 'HandymanPricingContract',
      getHandymanBmFeeConfiguration: 'HandymanPricingContractBmFeeConfiguration',
      postHandymanCustomerTransactionOpen: 'HandymanCustomerTransactionCommandResult',
      postHandymanCustomerChargeLine: 'HandymanChargeLineCommandResult',
      postHandymanPaymentAllocation: 'HandymanPaymentAllocationCommandResult',
      postHandymanLedgerRefund: 'HandymanLedgerCorrectionCommandResult',
      postHandymanLedgerAllocationReversal: 'HandymanLedgerCorrectionCommandResult',
      postHandymanLedgerPaymentReversal: 'HandymanLedgerCorrectionCommandResult',
      postHandymanLedgerAdjustment: 'HandymanLedgerCorrectionCommandResult',
      postHandymanFinancialEntitlementsDerive: 'HandymanDerivedFinancialEntitlements',
      postHandymanSettlementPrepare: 'HandymanSettlementPrepareResult',
      postHandymanSettlementInclude: 'HandymanSettlementIncludeResult',
      postHandymanSettlementReconcile: 'HandymanSettlementReconcileResult',
      postHandymanSettlementSettle: 'HandymanSettlementSettleResult',
      postHandymanSettlementDispute: 'HandymanSettlementDisputeResult',
      postHandymanSettlementCorrection: 'HandymanSettlementCorrectionResult',
      getHandymanFinancialTransaction: 'HandymanFinancialTransactionRead',
      getHandymanFinancialTransactions: 'HandymanFinancialClientRead',
      postHandymanServiceWarrantyStart: 'HandymanServiceWarrantyCommandResult',
      postHandymanServiceWarrantyExpire: 'HandymanServiceWarrantyCommandResult',
      postHandymanServiceWarrantyReworkPropose: 'HandymanServiceWarrantyReworkCommandResult',
      postHandymanServiceWarrantyReworkStart: 'HandymanServiceWarrantyReworkCommandResult',
      postHandymanServiceWarrantyReworkComplete: 'HandymanServiceWarrantyReworkCommandResult',
      postHandymanServiceWarrantyReworkVerify: 'HandymanServiceWarrantyReworkCommandResult',
    };
    for (const [id, component] of Object.entries(expected)) {
      const data =
        op(id).responses['200'].content['application/json'].schema.allOf[1]
          .properties.data;
      assert.equal(data.$ref, `#/components/schemas/${component}`, id);
      const schema = spec.components.schemas[component];
      assert.ok(schema, `${component} must exist`);
      assert.equal(schema.type, 'object', component);
      assert.ok(
        schema.properties && Object.keys(schema.properties).length > 0,
        `${component} must declare properties`,
      );
    }
    // Settlement literal results: state/kind singletons from the service.
    assert.deepEqual(
      spec.components.schemas.HandymanSettlementPrepareResult.properties.state.enum,
      ['PAYABLE'],
    );
    assert.deepEqual(
      spec.components.schemas.HandymanSettlementDisputeResult.properties.kind.enum,
      ['DISPUTED'],
    );
  });

  it('fully types the Care operational projection (no open nested objects)', () => {
    const projection =
      spec.components.schemas.CareHandymanOperationalProjection;
    const openFlags = collectKeys(projection, 'additionalProperties');
    assert.ok(openFlags.length > 10, 'projection should declare closure widely');
    assert.ok(
      openFlags.every((v) => v === false),
      'every nested projection object must be closed',
    );
    assert.deepEqual(
      projection.properties.invoicePayment.properties.paymentStatus.properties
        .status.enum,
      ['CANCELLED', 'NOT_DERIVED', 'PAID', 'OVERDUE', 'PARTIALLY_PAID', 'UNPAID'],
    );
    const bastItem = projection.properties.bast.items;
    assert.deepEqual(Object.keys(bastItem.properties).sort(), [
      'acceptedAt',
      'createdAt',
      'events',
      'executionScopeId',
      'id',
      'issuedAt',
      'issuerUserId',
      'materialUsage',
      'qcRunId',
      'rejectedAt',
      'serviceRequestId',
      'signOffs',
      'status',
      'voidedAt',
      'workSessions',
    ]);
    assert.deepEqual(
      bastItem.properties.events.items.properties.eventType.enum,
      ['PREPARE', 'ISSUE', 'VOID', 'ACCEPT', 'REJECT'],
    );
  });

  it('closes the standalone list empty-meta branch to exactly {}', () => {
    const meta =
      op('listStandaloneCareRequests').responses['200'].content[
        'application/json'
      ].schema.allOf[1].properties.meta;
    assert.equal(meta.oneOf.length, 2);
    assert.equal(meta.oneOf[1].maxProperties, 0);
    assert.equal(meta.oneOf[1].additionalProperties, false);
  });
});
