import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import {
  PURCHASE_ORDER_ACTIONS,
  PURCHASE_ORDER_CURRENCIES,
  canTransitionPurchaseOrderStatus,
  PURCHASE_ORDER_ISSUE_BLOCKERS,
  PURCHASE_ORDER_REQUEST_TYPES,
  PURCHASE_ORDER_STATUSES,
  PO_LINE_REQUEST_TYPES,
} from '../src/modules/purchase-orders';
import {
  isValidVendorPaymentAmount,
  R2P_TRACE_DOCUMENT_TYPES,
  R2P_TRACE_RELATIONSHIPS,
  VENDOR_INVOICE_ELIGIBLE_PURCHASE_ORDER_STATUSES,
  VENDOR_INVOICE_ACTIONS,
  VENDOR_INVOICE_DISCREPANCY_CODES,
  VENDOR_INVOICE_ELIGIBLE_WORK_CONTRACT_STATUSES,
  VENDOR_INVOICE_MATCHING_STATUSES,
  VENDOR_PAYMENT_STATUSES,
  VENDOR_SETTLEMENT_ACTIONS,
  VENDOR_SETTLEMENT_READINESS,
  VENDOR_SETTLEMENT_REASONS,
} from '../src/modules/vendor-invoices';
import {
  WORK_CONTRACT_ACTIONS,
  WORK_CONTRACT_STATUSES,
} from '../src/modules/work-contracts';
import { WO_PROCUREMENT_STATUSES } from '../src/modules/work-order-procurement-bindings';

/**
 * CR-BE-R2P-01 PART 07 — R2P contract completion.
 *
 * Pins that docs/api/openapi.yaml documents the Request-to-Pay chain built in
 * PART 01–06 and that the documented contract stays in step with the
 * implementation: lifecycle enums are compared against their TypeScript
 * source of truth, and every documented R2P operation must carry the
 * envelope, security and error contract the runtime actually produces.
 *
 * The companion suite tests/openapi-contract.test.ts already proves that every
 * documented path is registered in the router; this suite proves the SHAPE is
 * right, not merely that the path exists.
 */

const SPEC_PATH = resolve(__dirname, '../docs/api/openapi.yaml');

type Operation = {
  operationId?: string;
  description?: string;
  tags?: string[];
  security?: Record<string, unknown>[];
  responses?: Record<string, unknown>;
  requestBody?: unknown;
  'x-required-permission'?: string;
  'x-building-scoped'?: boolean;
};
type PathItem = Record<string, Operation>;

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  paths: Record<string, PathItem>;
  tags: { name: string }[];
  components: {
    schemas: Record<string, Record<string, unknown>>;
    parameters: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
};

const METHODS = ['get', 'post', 'patch', 'delete', 'put'];

/** Every operation the R2P chain owns, as actually registered. */
const R2P_OPERATIONS: [string, string][] = [
  ['post', '/purchase-orders'],
  ['get', '/purchase-orders'],
  ['get', '/purchase-orders/{id}'],
  ['get', '/purchase-orders/{id}/available-actions'],
  ['patch', '/purchase-orders/{id}'],
  ['post', '/purchase-orders/{id}/cancel'],
  ['post', '/purchase-orders/{id}/issue'],
  ['get', '/purchase-orders/{id}/issue-readiness'],
  ['post', '/purchase-orders/{id}/lines'],
  ['get', '/purchase-orders/{id}/lines'],
  ['get', '/purchase-order-lines/{lineId}'],
  ['patch', '/purchase-order-lines/{lineId}'],
  ['delete', '/purchase-order-lines/{lineId}'],
  ['post', '/work-contracts'],
  ['get', '/work-contracts'],
  ['get', '/work-contracts/{id}'],
  ['get', '/work-contracts/{id}/available-actions'],
  ['patch', '/work-contracts/{id}'],
  ['post', '/work-contracts/{id}/activate'],
  ['post', '/work-contracts/{id}/complete'],
  ['post', '/work-contracts/{id}/cancel'],
  ['post', '/work-order-procurement-bindings'],
  ['get', '/work-order-procurement-bindings/{id}'],
  ['post', '/work-order-procurement-bindings/{id}/resolve-readiness'],
  ['post', '/work-order-procurement-bindings/{id}/link-receiving'],
  ['post', '/work-order-procurement-bindings/{id}/bind-work-contract'],
  ['get', '/work-orders/{workOrderId}/procurement-bindings'],
  ['post', '/vendors/{vendorId}/invoices'],
  ['get', '/vendor-invoices'],
  ['get', '/vendor-invoices/{id}'],
  ['get', '/vendor-invoices/{id}/available-actions'],
  ['patch', '/vendor-invoices/{id}'],
  ['post', '/vendor-invoices/{id}/finalize'],
  ['post', '/vendor-invoices/{id}/cancel'],
  ['post', '/vendor-invoices/{id}/verify'],
  ['get', '/vendor-invoices/{id}/matching'],
  ['post', '/vendor-invoices/{id}/payment'],
  ['get', '/vendor-invoices/{id}/settlement-readiness'],
  ['get', '/vendor-invoices/{id}/consistency'],
  ['get', '/vendor-invoices/{id}/trace'],
];

function operation(method: string, path: string): Operation {
  const item = spec.paths[path];
  assert.ok(item, `path ${path} is not documented`);
  const op = item[method];
  assert.ok(op, `${method.toUpperCase()} ${path} is not documented`);
  return op;
}

describe('CR-BE-R2P-01 PART 07 — R2P OpenAPI contract completion', () => {
  it('documents every implemented R2P operation', () => {
    for (const [method, path] of R2P_OPERATIONS) {
      const op = operation(method, path);
      assert.ok(op.operationId, `${method} ${path} needs an operationId`);
      assert.ok(op.tags?.length, `${method} ${path} needs a tag`);
    }
  });

  it('requires bearer authentication on every R2P operation', () => {
    for (const [method, path] of R2P_OPERATIONS) {
      const op = operation(method, path);
      assert.ok(
        op.security?.some((scheme) => 'bearerAuth' in scheme),
        `${method.toUpperCase()} ${path} must require bearerAuth`,
      );
      // Protected endpoints always expose the authentication/authorization
      // failures the RBAC + BE-02G middleware actually produces.
      const responses = op.responses ?? {};
      assert.ok(responses['401'], `${method} ${path} must document 401`);
      assert.ok(responses['403'], `${method} ${path} must document 403`);
    }
  });

  it('publishes exact permissions and Building isolation for every R2P operation', () => {
    const expectedPermissions: Record<string, string> = {
      'POST /purchase-orders': 'purchase_order.manage',
      'GET /purchase-orders': 'purchase_order.read',
      'GET /purchase-orders/{id}': 'purchase_order.read',
      'GET /purchase-orders/{id}/available-actions': 'purchase_order.read',
      'PATCH /purchase-orders/{id}': 'purchase_order.manage',
      'POST /purchase-orders/{id}/cancel': 'purchase_order.manage',
      'POST /purchase-orders/{id}/issue': 'purchase_order.manage',
      'GET /purchase-orders/{id}/issue-readiness': 'purchase_order.read',
      'POST /purchase-orders/{id}/lines': 'purchase_order.manage',
      'GET /purchase-orders/{id}/lines': 'purchase_order.read',
      'GET /purchase-order-lines/{lineId}': 'purchase_order.read',
      'PATCH /purchase-order-lines/{lineId}': 'purchase_order.manage',
      'DELETE /purchase-order-lines/{lineId}': 'purchase_order.manage',
      'POST /work-contracts': 'work_contract.manage',
      'GET /work-contracts': 'work_contract.read',
      'GET /work-contracts/{id}': 'work_contract.read',
      'GET /work-contracts/{id}/available-actions': 'work_contract.read',
      'PATCH /work-contracts/{id}': 'work_contract.manage',
      'POST /work-contracts/{id}/activate': 'work_contract.manage',
      'POST /work-contracts/{id}/complete': 'work_contract.manage',
      'POST /work-contracts/{id}/cancel': 'work_contract.manage',
      'POST /work-order-procurement-bindings': 'wo_procurement.manage',
      'GET /work-order-procurement-bindings/{id}': 'wo_procurement.read',
      'POST /work-order-procurement-bindings/{id}/resolve-readiness':
        'wo_procurement.manage',
      'POST /work-order-procurement-bindings/{id}/link-receiving':
        'wo_procurement.manage',
      'POST /work-order-procurement-bindings/{id}/bind-work-contract':
        'wo_procurement.manage',
      'GET /work-orders/{workOrderId}/procurement-bindings':
        'wo_procurement.read',
      'POST /vendors/{vendorId}/invoices': 'vendor_invoice.manage',
      'GET /vendor-invoices': 'vendor_invoice.read',
      'GET /vendor-invoices/{id}': 'vendor_invoice.read',
      'GET /vendor-invoices/{id}/available-actions': 'vendor_invoice.read',
      'PATCH /vendor-invoices/{id}': 'vendor_invoice.manage',
      'POST /vendor-invoices/{id}/finalize': 'vendor_invoice.manage',
      'POST /vendor-invoices/{id}/cancel': 'vendor_invoice.manage',
      'POST /vendor-invoices/{id}/verify': 'vendor_invoice.manage',
      'GET /vendor-invoices/{id}/matching': 'vendor_invoice.read',
      'POST /vendor-invoices/{id}/payment': 'vendor_invoice.manage',
      'GET /vendor-invoices/{id}/settlement-readiness':
        'vendor_invoice.read',
      'GET /vendor-invoices/{id}/consistency': 'vendor_invoice.read',
      'GET /vendor-invoices/{id}/trace': 'vendor_invoice.read',
    };

    for (const [method, path] of R2P_OPERATIONS) {
      const op = operation(method, path);
      const key = `${method.toUpperCase()} ${path}`;
      assert.equal(
        op['x-required-permission'],
        expectedPermissions[key],
        `${key} permission metadata`,
      );
      assert.equal(op['x-building-scoped'], true, `${key} Building scope`);
    }
  });

  it('documents the shared available-actions DTO shape and action enums', () => {
    const cases: [string, string, readonly string[]][] = [
      [
        'PurchaseOrderAvailableActions',
        'PurchaseOrderAction',
        PURCHASE_ORDER_ACTIONS,
      ],
      [
        'WorkContractAvailableActions',
        'WorkContractAction',
        WORK_CONTRACT_ACTIONS,
      ],
    ];

    for (const [dtoName, actionName, values] of cases) {
      const dto = spec.components.schemas[dtoName];
      assert.ok(dto, `${dtoName} schema`);
      assert.deepEqual(dto.required, [
        dtoName.startsWith('PurchaseOrder')
          ? 'purchaseOrderId'
          : 'workContractId',
        'state',
        'availableActions',
      ]);
      const action = spec.components.schemas[actionName];
      assert.deepEqual(action.enum, [...values]);
      for (const value of values) {
        assert.match(value, /^[A-Z][A-Z0-9_]*$/);
      }
    }

    const issueReadiness = spec.components.schemas.PurchaseOrderIssueReadiness;
    const properties = issueReadiness.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(properties.availableActions.items, {
      $ref: '#/components/schemas/PurchaseOrderAction',
    });
  });

  it('normalizes the reusable 403 contract for permission and Building scope', () => {
    const forbidden = JSON.stringify(spec.components.responses.Forbidden);
    assert.match(forbidden, /PERMISSION_DENIED/);
    assert.match(forbidden, /BUILDING_ACCESS_DENIED/);
  });

  it('documents the conflict responses the lifecycle commands can return', () => {
    // Every command whose deterministic transition rules can reject with 409.
    for (const [method, path] of [
      ['post', '/purchase-orders'],
      ['post', '/purchase-orders/{id}/issue'],
      ['post', '/work-contracts'],
      ['post', '/work-contracts/{id}/activate'],
      ['post', '/work-contracts/{id}/complete'],
      ['post', '/work-contracts/{id}/cancel'],
      ['post', '/work-order-procurement-bindings'],
      ['post', '/work-order-procurement-bindings/{id}/bind-work-contract'],
    ] as [string, string][]) {
      const op = operation(method, path);
      assert.ok(
        op.responses?.['409'],
        `${method.toUpperCase()} ${path} must document 409`,
      );
    }
  });

  it('keeps lifecycle enums in step with the TypeScript source of truth', () => {
    const cases: [string, readonly string[]][] = [
      ['PurchaseOrderStatus', PURCHASE_ORDER_STATUSES],
      ['PurchaseOrderRequestType', PURCHASE_ORDER_REQUEST_TYPES],
      ['PurchaseOrderCurrency', PURCHASE_ORDER_CURRENCIES],
      ['PurchaseOrderIssueBlocker', PURCHASE_ORDER_ISSUE_BLOCKERS],
      ['PurchaseOrderLineRequestType', PO_LINE_REQUEST_TYPES],
      ['WorkContractStatus', WORK_CONTRACT_STATUSES],
      ['WOProcurementStatus', WO_PROCUREMENT_STATUSES],
    ];
    for (const [schemaName, values] of cases) {
      const schema = spec.components.schemas[schemaName];
      assert.ok(schema, `schema ${schemaName} is missing`);
      assert.deepEqual(
        schema.enum,
        [...values],
        `${schemaName} must match its TypeScript enum exactly`,
      );
    }
  });

  it('keeps the PO lifecycle contract consistent with the commands', () => {
    assert.equal(canTransitionPurchaseOrderStatus('DRAFT', 'ISSUED'), true);
    assert.equal(canTransitionPurchaseOrderStatus('DRAFT', 'CANCELLED'), true);
    assert.equal(canTransitionPurchaseOrderStatus('ISSUED', 'CANCELLED'), false);
    assert.equal(canTransitionPurchaseOrderStatus('CANCELLED', 'ISSUED'), false);

    const statusDescription = String(
      spec.components.schemas.PurchaseOrderStatus.description,
    );
    assert.match(statusDescription, /DRAFT → ISSUED/);
    assert.match(statusDescription, /DRAFT → CANCELLED/);
    assert.match(statusDescription, /ISSUED and CANCELLED.*terminal/);
    assert.doesNotMatch(statusDescription, /DRAFT\|ISSUED → CANCELLED/);

    const cancel = operation('post', '/purchase-orders/{id}/cancel');
    assert.match(cancel.description ?? '', /DRAFT → CANCELLED only/);
    assert.match(
      JSON.stringify(cancel.responses?.['400']),
      /PURCHASE_ORDER_CANCEL_NOT_ALLOWED/,
    );
  });

  it('marks every always-present R2P response field as required, including nullable fields', () => {
    for (const schemaName of [
      'PurchaseOrder',
      'PurchaseOrderLine',
      'WorkContract',
      'VendorInvoice',
    ]) {
      const schema = spec.components.schemas[schemaName];
      assert.deepEqual(
        [...(schema.required as string[])].sort(),
        Object.keys(schema.properties ?? {}).sort(),
        `${schemaName} required fields must match its runtime DTO`,
      );
    }
  });

  it('documents the actual compact PO Line DELETE result and errors', () => {
    const remove = operation('delete', '/purchase-order-lines/{lineId}');
    const response = remove.responses?.['200'] as {
      content?: {
        'application/json'?: {
          schema?: { allOf?: Record<string, unknown>[] };
        };
      };
    };
    const allOf =
      response.content?.['application/json']?.schema?.allOf ?? [];
    assert.match(JSON.stringify(allOf), /RemovePurchaseOrderLineResult/);
    assert.doesNotMatch(JSON.stringify(allOf), /PurchaseOrderLine\"/);

    const result = spec.components.schemas.RemovePurchaseOrderLineResult;
    assert.deepEqual(result.required, [
      'removed',
      'purchaseOrderId',
      'lineNumber',
    ]);
    const properties = result.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(properties.removed.enum, [true]);
    assert.equal(properties.lineNumber.minimum, 1);

    const responses = JSON.stringify(remove.responses);
    for (const code of [
      'PURCHASE_ORDER_LINE_NOT_DRAFT',
      'VALIDATION_ERROR',
      'PURCHASE_ORDER_LINE_NOT_FOUND',
    ]) {
      assert.match(responses, new RegExp(code));
    }
  });

  it('documents the PO/SPK linkage on the Vendor Invoice read model', () => {
    const props = (name: string): Record<string, unknown> =>
      (spec.components.schemas[name]?.properties ?? {}) as Record<
        string,
        unknown
      >;

    const invoiceRequired = spec.components.schemas.VendorInvoice
      .required as string[];
    for (const field of ['purchaseOrderId', 'workContractId']) {
      assert.ok(props('VendorInvoice')[field], `VendorInvoice.${field}`);
      assert.ok(invoiceRequired.includes(field), `VendorInvoice requires ${field}`);
      assert.ok(
        props('CreateVendorInvoiceRequest')[field],
        `CreateVendorInvoiceRequest.${field}`,
      );
    }
    assert.deepEqual(
      spec.components.schemas.VendorInvoiceEligiblePurchaseOrderStatus.enum,
      [...VENDOR_INVOICE_ELIGIBLE_PURCHASE_ORDER_STATUSES],
    );
    assert.deepEqual(
      spec.components.schemas.VendorInvoiceEligibleWorkContractStatus.enum,
      [...VENDOR_INVOICE_ELIGIBLE_WORK_CONTRACT_STATUSES],
    );

    const create = operation('post', '/vendors/{vendorId}/invoices');
    const createResponses = JSON.stringify(create.responses);
    for (const code of [
      'VENDOR_INVOICE_PURCHASE_ORDER_INVALID',
      'VENDOR_INVOICE_WORK_CONTRACT_INVALID',
      'VENDOR_INVOICE_WORK_CONTRACT_PO_MISMATCH',
      'VENDOR_INVOICE_PROCUREMENT_VENDOR_MISMATCH',
      'VENDOR_INVOICE_PROCUREMENT_SCOPE_MISMATCH',
      'VENDOR_INVOICE_CONTEXT_INVALID',
      'VENDOR_INVOICE_PURCHASE_ORDER_NOT_ISSUED',
      'VENDOR_INVOICE_WORK_CONTRACT_NOT_ELIGIBLE',
      'VENDOR_INVOICE_NUMBER_ALREADY_EXISTS',
    ]) {
      assert.match(createResponses, new RegExp(code));
    }

    // The linkage must be traceable, with the upstream statuses reported.
    for (const field of [
      'purchaseOrderId',
      'workContractId',
      'purchaseOrderStatus',
      'purchaseOrderNumber',
      'workContractStatus',
      'workContractSpkNumber',
    ]) {
      assert.ok(props('VendorInvoiceTrace')[field], `VendorInvoiceTrace.${field}`);
    }
  });

  it('publishes the runtime request bounds used by R2P validators', () => {
    const schemas = spec.components.schemas;
    const createPo = schemas.CreatePurchaseOrderRequest.properties as Record<
      string,
      Record<string, unknown>
    >;
    const addPoLine = schemas.AddPurchaseOrderLineRequest.properties as Record<
      string,
      Record<string, unknown>
    >;
    const createSpk = schemas.CreateWorkContractRequest.properties as Record<
      string,
      Record<string, unknown>
    >;
    const createInvoice = schemas.CreateVendorInvoiceRequest
      .properties as Record<string, Record<string, unknown>>;

    assert.equal(createPo.poNumber.maxLength, 64);
    assert.equal(createPo.vendorReference.maxLength, 255);
    assert.equal(createPo.notes.maxLength, 2000);
    assert.equal(addPoLine.description.maxLength, 500);
    assert.equal(addPoLine.notes.maxLength, 2000);
    assert.equal(createSpk.spkNumber.maxLength, 64);
    assert.equal(createInvoice.invoiceNumber.maxLength, 64);
    assert.equal(createInvoice.invoiceAmount.minimum, 0);
    assert.equal(createInvoice.vendorReference.maxLength, 255);
    assert.equal(createInvoice.notes.maxLength, 2000);

    const verify = operation('post', '/vendor-invoices/{id}/verify');
    const verifyBody = verify.requestBody as {
      content?: {
        'application/json'?: {
          schema?: { properties?: Record<string, Record<string, unknown>> };
        };
      };
    };
    const verifyRequest =
      verifyBody.content?.['application/json']?.schema ?? {};
    assert.equal(verifyRequest.properties?.notes.maxLength, 2000);
    assert.equal(verifyRequest.properties?.notes.nullable, true);
  });

  it('documents the canonical matching result consumed by verification', () => {
    assert.deepEqual(
      spec.components.schemas.VendorInvoiceMatchingStatus.enum,
      [...VENDOR_INVOICE_MATCHING_STATUSES],
    );
    assert.deepEqual(
      spec.components.schemas.VendorInvoiceMatchingReason.enum,
      [...VENDOR_INVOICE_DISCREPANCY_CODES],
    );

    const result = spec.components.schemas.InvoiceMatchingResult;
    const required = result.required as string[];
    for (const field of [
      'invoiceId',
      'status',
      'verificationEligible',
      'purchaseOrderMatch',
      'workContractMatch',
      'amountMatch',
      'receivingMatch',
      'mismatchCodes',
      'notReadyCodes',
      'discrepancyCodes',
    ]) {
      assert.ok(required.includes(field), `InvoiceMatchingResult.${field}`);
    }

    const verify = operation('post', '/vendor-invoices/{id}/verify');
    assert.match(verify.description ?? '', /MATCHED/);
    assert.match(verify.description ?? '', /MISMATCH/);
    assert.match(verify.description ?? '', /NOT_READY/);
    assert.match(
      JSON.stringify(verify.responses?.['409']),
      /VENDOR_INVOICE_MATCHING_NOT_READY/,
    );
  });

  it('documents the canonical read-only R2P trace graph', () => {
    assert.deepEqual(
      spec.components.schemas.R2PTraceDocumentType.enum,
      [...R2P_TRACE_DOCUMENT_TYPES],
    );
    assert.deepEqual(
      spec.components.schemas.R2PTraceRelationshipType.enum,
      [...R2P_TRACE_RELATIONSHIPS],
    );
    const trace = spec.components.schemas.VendorInvoiceTrace;
    const required = trace.required as string[];
    for (const field of [
      'documents',
      'relationships',
      'matching',
      'settlementReadiness',
      'generatedAt',
    ]) {
      assert.ok(required.includes(field), `VendorInvoiceTrace.${field}`);
    }
    const operationContract = operation('get', '/vendor-invoices/{id}/trace');
    assert.match(operationContract.description ?? '', /foreign keys/);
    assert.match(operationContract.description ?? '', /no cross-Building/i);
    assert.match(
      JSON.stringify(operationContract.responses?.['404']),
      /VENDOR_INVOICE_NOT_FOUND/,
    );
  });

  it('publishes the existing DRAFT-only Vendor Invoice PATCH contract', () => {
    const patch = operation('patch', '/vendor-invoices/{id}');
    assert.equal(patch['x-required-permission'], 'vendor_invoice.manage');
    assert.equal(patch['x-building-scoped'], true);
    assert.match(JSON.stringify(patch.requestBody), /UpdateVendorInvoiceRequest/);

    const update = spec.components.schemas.UpdateVendorInvoiceRequest;
    assert.equal(update.minProperties, 1);
    assert.deepEqual(
      Object.keys(update.properties as Record<string, unknown>).sort(),
      [
        'currency',
        'invoiceAmount',
        'invoiceDate',
        'notes',
        'receivedDate',
        'vendorReference',
      ],
    );
    const contract = JSON.stringify(update);
    for (const immutable of [
      'purchaseOrderId',
      'workContractId',
      'vendorId',
      'buildingId',
    ]) {
      assert.doesNotMatch(contract, new RegExp(`"${immutable}":`));
    }

    const responses = JSON.stringify(patch.responses);
    for (const code of [
      'VALIDATION_ERROR',
      'VENDOR_INVOICE_FINALIZED_PROTECTED',
      'VENDOR_INVOICE_NOT_DRAFT',
      'VENDOR_INVOICE_NOT_FOUND',
    ]) {
      assert.match(responses, new RegExp(code));
    }
  });

  it('documents the SPK chain on the Work Order procurement binding', () => {
    const binding = (spec.components.schemas.WorkOrderProcurementBinding
      ?.properties ?? {}) as Record<string, unknown>;
    for (const field of [
      'workContractId',
      'purchaseOrderId',
      'vendorId',
      // The pre-existing request linkage must remain documented.
      'purchaseRequestId',
      'materialRequestId',
      'serviceRequestId',
      'receivingId',
    ]) {
      assert.ok(binding[field], `WorkOrderProcurementBinding.${field}`);
    }
  });

  it('covers the authoritative chain end to end', () => {
    // Request → Vendor → PO Readiness → ISSUED PO → SPK → Work Order → BAST
    // → Vendor Invoice → Verification → Payment → Settlement.
    const chain: [string, string][] = [
      ['post', '/purchase-requests/{purchaseRequestId}/material-requests'],
      ['post', '/purchase-requests/{purchaseRequestId}/service-requests'],
      ['post', '/procurement-approvals'],
      ['post', '/vendor-selections'],
      ['post', '/po-readiness'],
      ['post', '/purchase-orders'],
      ['post', '/purchase-orders/{id}/lines'],
      ['get', '/purchase-orders/{id}/issue-readiness'],
      ['post', '/purchase-orders/{id}/issue'],
      ['post', '/work-contracts'],
      ['post', '/work-contracts/{id}/activate'],
      ['post', '/work-order-procurement-bindings/{id}/bind-work-contract'],
      ['post', '/bast-documents'],
      ['post', '/bast-documents/{id}/decisions'],
      ['post', '/vendors/{vendorId}/invoices'],
      ['post', '/vendor-invoices/{id}/finalize'],
      ['post', '/vendor-invoices/{id}/verify'],
      ['post', '/vendor-invoices/{id}/payment'],
      ['get', '/vendor-invoices/{id}/settlement-readiness'],
      ['get', '/vendor-invoices/{id}/trace'],
    ];
    for (const [method, path] of chain) {
      operation(method, path);
    }
  });

  it('resolves every $ref and declares every tag it uses', () => {
    const refs: string[] = [];
    (function walk(node: unknown): void {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.push(value);
          else walk(value);
        }
      }
    })(spec);
    assert.ok(refs.length > 0);

    for (const ref of refs) {
      const resolved = ref
        .replace(/^#\//, '')
        .split('/')
        .reduce<unknown>(
          (acc, segment) =>
            acc == null
              ? acc
              : (acc as Record<string, unknown>)[
                  segment.replace(/~1/g, '/').replace(/~0/g, '~')
                ],
          spec,
        );
      assert.notEqual(resolved, undefined, `dangling $ref: ${ref}`);
    }

    const declared = new Set(spec.tags.map((tag) => tag.name));
    for (const item of Object.values(spec.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        for (const tag of op.tags ?? []) {
          assert.ok(declared.has(tag), `tag "${tag}" is used but not declared`);
        }
      }
    }
  });

  it('keeps operationIds unique across the whole contract', () => {
    const ids = Object.values(spec.paths).flatMap((item) =>
      Object.entries(item)
        .filter(([method]) => METHODS.includes(method))
        .map(([, op]) => op.operationId),
    );
    assert.equal(
      new Set(ids).size,
      ids.length,
      'duplicate operationId in the contract',
    );
  });

  it('documents caller-specific Vendor Invoice actions', () => {
    assert.deepEqual(spec.components.schemas.VendorInvoiceAction.enum, [
      ...VENDOR_INVOICE_ACTIONS,
    ]);
    const actions = spec.components.schemas.VendorInvoiceAvailableActions;
    assert.deepEqual(actions.required, [
      'vendorInvoiceId',
      'state',
      'verificationStatus',
      'matchingStatus',
      'settlementReadiness',
      'availableActions',
    ]);
    const operationContract = operation(
      'get',
      '/vendor-invoices/{id}/available-actions',
    );
    assert.match(operationContract.description ?? '', /must not infer/i);
  });

  it('documents canonical settlement readiness and payment integration', () => {
    assert.deepEqual(
      spec.components.schemas.VendorSettlementReadinessStatus.enum,
      [...VENDOR_SETTLEMENT_READINESS],
    );
    assert.deepEqual(
      spec.components.schemas.VendorSettlementReason.enum,
      [...VENDOR_SETTLEMENT_REASONS],
    );
    assert.deepEqual(
      spec.components.schemas.VendorSettlementAction.enum,
      [...VENDOR_SETTLEMENT_ACTIONS],
    );

    const readiness = spec.components.schemas.VendorSettlementReadinessResult;
    const required = readiness.required as string[];
    for (const field of [
      'invoiceStatus',
      'verificationStatus',
      'matchingStatus',
      'currency',
      'invoiceAmount',
      'paidAmount',
      'outstandingAmount',
      'reasons',
      'matchingReasons',
      'availableActions',
    ]) {
      assert.ok(required.includes(field), `readiness.${field}`);
    }

    const payment = operation('post', '/vendor-invoices/{id}/payment');
    assert.match(payment.description ?? '', /settlement[\s-]+readiness/);
    assert.match(
      JSON.stringify(payment.responses?.['409']),
      /VENDOR_INVOICE_PAYMENT_NOT_READY/,
    );
  });

  it('documents the corrected Vendor Invoice payment contract', () => {
    const payment = operation('post', '/vendor-invoices/{id}/payment');
    const description = payment.description ?? '';
    for (const expected of [
      /FINALIZED/,
      /VERIFIED/,
      /NUMERIC\(18,2\)/,
      /PARTIALLY_PAID/,
      /PAID/,
      /overpayment/i,
      /paymentDate/,
      /notes/,
    ]) {
      assert.match(description, expected);
    }
    assert.doesNotMatch(description, /returns 500|updated to DEFAULT/i);

    const request = spec.components.schemas.RecordVendorPaymentRequest;
    assert.deepEqual(request.required, ['amount']);
    const properties = request.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(properties.amount.type, 'number');
    assert.equal(properties.amount.minimum, 0);
    assert.equal(properties.amount.exclusiveMinimum, true);
    assert.equal(properties.amount.maximum, 10_000_000_000_000_000);
    assert.equal(properties.amount.exclusiveMaximum, true);
    assert.equal(properties.amount.multipleOf, 0.01);
    assert.match(String(properties.amount.description), /two decimal/i);
    assert.equal(isValidVendorPaymentAmount(0.01), true);
    assert.equal(isValidVendorPaymentAmount(0), false);
    assert.equal(isValidVendorPaymentAmount(0.001), false);
    assert.equal(
      isValidVendorPaymentAmount(properties.amount.maximum),
      false,
    );

    assert.equal(properties.paymentDate.format, 'date');
    assert.match(
      String(properties.paymentDate.description),
      /existing lastPaymentDate is preserved/,
    );
    assert.equal(properties.notes.maxLength, 2000);
    assert.equal(properties.notes.nullable, true);
    assert.match(String(properties.notes.description), /payment event/i);

    const invoiceProperties = spec.components.schemas.VendorInvoice
      .properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(invoiceProperties.paymentStatus.enum, [
      ...VENDOR_PAYMENT_STATUSES,
    ]);
    assert.ok(!invoiceProperties.paymentStatus.enum.includes('SETTLED'));
    assert.match(
      String(invoiceProperties.outstandingAmount.description),
      /Database-generated/,
    );

    const responses = payment.responses ?? {};
    for (const status of ['400', '401', '403', '404', '409', '422']) {
      assert.ok(responses[status], `payment response ${status} is required`);
    }
    const responseContract = JSON.stringify(responses);
    for (const code of [
      'VALIDATION_ERROR',
      'VENDOR_INVOICE_NOT_VERIFIED_FOR_PAYMENT',
      'VENDOR_INVOICE_PAYMENT_NOT_ALLOWED',
      'PERMISSION_DENIED',
      'BUILDING_ACCESS_DENIED',
      'VENDOR_INVOICE_NOT_FOUND',
      'VENDOR_INVOICE_PAYMENT_NOT_READY',
      'VENDOR_INVOICE_OVERPAYMENT',
    ]) {
      assert.match(responseContract, new RegExp(code));
    }
    // HTTP validation runs before the service-level defensive amount guard.
    assert.doesNotMatch(
      responseContract,
      /VENDOR_INVOICE_PAYMENT_AMOUNT_INVALID/,
    );
  });

  it('records KI-001 as resolved while preserving open KI-002', () => {
    const knownIssues = readFileSync(
      resolve(__dirname, '../docs/known-issues.md'),
      'utf8',
    );
    const ki001 = knownIssues.match(/## KI-001[\s\S]*?(?=\n---\n)/)?.[0] ?? '';
    assert.match(ki001, /Status:\*\* (?:closed|resolved)/i);
    assert.doesNotMatch(ki001, /Status:\*\* open/i);
    assert.match(ki001, /GENERATED ALWAYS/);
    assert.match(ki001, /transaction[\s\S]*row lock/i);
    assert.match(ki001, /no parallel payment or settlement architecture/i);

    const ki002 = knownIssues.match(/## KI-002[\s\S]*/)?.[0] ?? '';
    assert.match(ki002, /Status:\*\* open/i);
  });
});
