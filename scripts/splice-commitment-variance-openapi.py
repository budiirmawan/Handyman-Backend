#!/usr/bin/env python3
"""CR-BE-COMM-VAR-01 PART 06 — splice the commitment/variance contract into the
canonical OpenAPI document.

Follows the existing repository convention (scripts/splice-*.py): the spec is
edited by an idempotent, anchored splice rather than by hand, so the runtime and
the contract cannot drift apart silently.

It documents ONLY what PART 01-05 implemented:
  - the operational budget overspend policy attribute and its narrow transition,
  - the commitment ledger create/read/adjust/release/cancel surfaces,
  - PO-line commitment creation,
  - the derived variance and traceability read model.

It adds no capability, no source authority and no accounting concept.
"""

from pathlib import Path

SPEC = Path(__file__).resolve().parent.parent / "docs" / "api" / "openapi.yaml"

PATHS_ANCHOR = "  /management/buildings/{buildingId}/operational-finance-summary:\n"

PATHS = """  # ── CR-BE-COMM-VAR-01 — Operational commitment ledger & variance ──────────
  /operational-budgets/{id}/overspend-policy:
    post:
      operationId: changeOperationalBudgetOverspendPolicy
      summary: Change Operational Budget Overspend Policy
      description: >
        Narrow, separately authorised overspend-policy transition for a DRAFT or
        ACTIVE budget. It requires BOTH operational_budget.manage and
        operational_budget.override, plus a mandatory reason, and is audited
        through the existing OPERATIONAL_BUDGET_OVERSPEND_POLICY_CHANGED event.
        The generic budget PATCH remains DRAFT-only. Administering a budget must
        never imply the authority to exceed approved spending.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.override
      x-building-scoped: true
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ChangeOperationalBudgetOverspendPolicyRequest" }
      responses:
        "200": { $ref: "#/components/responses/OperationalBudgetOverspendPolicySuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /operational-budgets/{budgetId}/commitments:
    post:
      operationId: createOperationalCommitment
      summary: Create Manual Operational Commitment
      description: >
        Creates a manual/estimated commitment against an ACTIVE budget. The
        decision runs in one transaction opened with a budget-row lock, and
        available budget is re-read inside that lock, so two concurrent
        approvals can never consume the same remainder. Overspend is rejected
        (409 OPERATIONAL_BUDGET_OVERSPEND_REJECTED) unless the budget policy is
        ALLOW_WITH_OVERRIDE, the caller holds operational_budget.override, and
        an explicit overspendOverrideReason is supplied. Creation is idempotent
        per (budget, idempotencyKey).
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: budgetId
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.manage
      x-building-scoped: true
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreateOperationalCommitmentRequest" }
      responses:
        "201": { $ref: "#/components/responses/OperationalCommitmentSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }
    get:
      operationId: listOperationalCommitments
      summary: List Operational Commitments
      description: Commitment ledger headers for one budget.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: budgetId
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
        - name: budgetCategoryId
          in: query
          required: false
          schema: { $ref: "#/components/schemas/Uuid" }
        - name: status
          in: query
          required: false
          schema: { $ref: "#/components/schemas/OperationalCommitmentStatus" }
        - name: origin
          in: query
          required: false
          schema: { $ref: "#/components/schemas/OperationalCommitmentOrigin" }
        - name: workOrderId
          in: query
          required: false
          schema: { $ref: "#/components/schemas/Uuid" }
        - name: vendorId
          in: query
          required: false
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.read
      x-building-scoped: true
      responses:
        "200": { $ref: "#/components/responses/OperationalCommitmentListSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }

  /operational-budgets/{budgetId}/commitments/from-purchase-order-line:
    post:
      operationId: createPurchaseOrderLineCommitment
      summary: Create Commitment From An Issued Purchase Order Line
      description: >
        Raises the commitment for one priced, ISSUED Purchase Order line — the
        only automatic commitment authority in the repository. Amount, currency,
        Client, Building, vendor and Material Request lineage are DERIVED from
        the line and must not be supplied. The caller provides only the explicit
        cost category and an idempotency key. A Purchase Order already
        represented by a CR-BE-FIN-01 source binding, or already carrying a live
        commitment, is refused so one obligation is never counted twice.
        Approved Material Requests, reservations and receivings carry no price
        and never create a commitment.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: budgetId
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.manage
      x-building-scoped: true
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CreatePurchaseOrderLineCommitmentRequest" }
      responses:
        "201": { $ref: "#/components/responses/OperationalCommitmentSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /operational-commitments/{id}:
    get:
      operationId: getOperationalCommitment
      summary: Get Operational Commitment With Its Ledger Entries
      description: >
        The commitment header plus its append-only ledger entries. signedAmount
        is the effect on the open amount, so the entries always sum to
        openAmount.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.read
      x-building-scoped: true
      responses:
        "200": { $ref: "#/components/responses/OperationalCommitmentDetailSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }

  /operational-commitments/{id}/adjust:
    post:
      operationId: adjustOperationalCommitment
      summary: Adjust An Open Operational Commitment
      description: >
        Appends a signed adjustment entry: a positive amount increases the
        obligation (subject to the same overspend control as creation), a
        negative amount decreases it. A decrease below the already-actualized
        amount is rejected. Amounts are never edited in place.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.manage
      x-building-scoped: true
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/AdjustOperationalCommitmentRequest" }
      responses:
        "200": { $ref: "#/components/responses/OperationalCommitmentSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /operational-commitments/{id}/release:
    post:
      operationId: releaseOperationalCommitment
      summary: Release The Remainder Of An Operational Commitment
      description: >
        Releases exactly the remaining open amount and closes the commitment.
        This is the correct path for a partially actualized obligation that will
        not complete.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.manage
      x-building-scoped: true
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CloseOperationalCommitmentRequest" }
      responses:
        "200": { $ref: "#/components/responses/OperationalCommitmentSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /operational-commitments/{id}/cancel:
    post:
      operationId: cancelOperationalCommitment
      summary: Cancel An Operational Commitment
      description: >
        Withdraws an obligation that never became actual. Rejected once anything
        has been actualized (409) — release the remainder instead.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: id
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.manage
      x-building-scoped: true
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/CloseOperationalCommitmentRequest" }
      responses:
        "200": { $ref: "#/components/responses/OperationalCommitmentSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }
        "409": { $ref: "#/components/responses/Conflict" }

  /operational-budgets/{budgetId}/variance:
    get:
      operationId: getOperationalBudgetVariance
      summary: Get Operational Budget Variance
      description: >
        Derived at read time; nothing is persisted or cached. Ledger and legacy
        contributions are reported separately as well as combined. A legacy
        source binding contributes only while no ledger commitment represents
        the same Purchase Order. Unallocated actual (costed material usages and
        verified vendor invoices with no commitment) is a BUDGET-scope figure
        only, because an unmatched source carries no cost category. Currency and
        period mismatches fail closed and are listed in controls.exclusions.
        Recorded gaps (B-02, B-03) are described in gaps and never valued.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: budgetId
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.read
      x-building-scoped: true
      responses:
        "200": { $ref: "#/components/responses/OperationalBudgetVarianceSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }

  /operational-budget-variance:
    get:
      operationId: listOperationalBudgetVariance
      summary: List Operational Budget Variance By Building And Period
      description: >
        Portfolio breakdown: one variance summary per accessible budget. Building
        and period are the budget's own dimensions, so no new aggregation axis is
        introduced.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: buildingId
          in: query
          required: false
          schema: { $ref: "#/components/schemas/Uuid" }
        - name: status
          in: query
          required: false
          schema: { $ref: "#/components/schemas/OperationalBudgetStatus" }
        - name: periodFrom
          in: query
          required: false
          schema: { type: string, format: date }
        - name: periodTo
          in: query
          required: false
          schema: { type: string, format: date }
      x-required-permission: operational_budget.read
      x-building-scoped: true
      responses:
        "200": { $ref: "#/components/responses/OperationalBudgetVarianceListSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }

  /buildings/{buildingId}/operational-budget-variance:
    get:
      operationId: listBuildingOperationalBudgetVariance
      summary: List Operational Budget Variance For One Building
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: buildingId
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
        - name: status
          in: query
          required: false
          schema: { $ref: "#/components/schemas/OperationalBudgetStatus" }
        - name: periodFrom
          in: query
          required: false
          schema: { type: string, format: date }
        - name: periodTo
          in: query
          required: false
          schema: { type: string, format: date }
      x-required-permission: operational_budget.read
      x-building-scoped: true
      responses:
        "200": { $ref: "#/components/responses/OperationalBudgetVarianceListSuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }

  /operational-budgets/{budgetId}/traceability:
    get:
      operationId: getOperationalBudgetTraceability
      summary: Get Operational Budget Source Traceability
      description: >
        Flat source-transaction rows behind the variance figures, each with its
        classification, commitment/binding identity and lineage keys (purchase
        order, purchase order line, vendor, work order, material request, vendor
        invoice, material usage) and an exclusion reason when it does not count.
      tags: [Operational Finance]
      security:
        - bearerAuth: []
      parameters:
        - name: budgetId
          in: path
          required: true
          schema: { $ref: "#/components/schemas/Uuid" }
      x-required-permission: operational_budget.read
      x-building-scoped: true
      responses:
        "200": { $ref: "#/components/responses/OperationalBudgetTraceabilitySuccess" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "403": { $ref: "#/components/responses/Forbidden" }
        "404": { $ref: "#/components/responses/NotFound" }

"""

RESPONSES_ANCHOR = """    OperationalBudgetAggregationSuccess:
      description: Read-time Operational Budget aggregation response.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalBudgetAggregationEnvelope" } } }
"""

RESPONSES = """    OperationalBudgetOverspendPolicySuccess:
      description: Operational Budget overspend policy transition response.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicyEnvelope" } } }
    OperationalCommitmentSuccess:
      description: Operational Commitment response.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalCommitmentEnvelope" } } }
    OperationalCommitmentListSuccess:
      description: Operational Commitment list response.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalCommitmentListEnvelope" } } }
    OperationalCommitmentDetailSuccess:
      description: Operational Commitment with its append-only ledger entries.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalCommitmentDetailEnvelope" } } }
    OperationalBudgetVarianceSuccess:
      description: Derived Operational Budget variance response.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalBudgetVarianceEnvelope" } } }
    OperationalBudgetVarianceListSuccess:
      description: Derived Operational Budget variance summaries.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalBudgetVarianceListEnvelope" } } }
    OperationalBudgetTraceabilitySuccess:
      description: Operational Budget source traceability response.
      content: { application/json: { schema: { $ref: "#/components/schemas/OperationalBudgetTraceabilityEnvelope" } } }
"""

SCHEMAS_ANCHOR = """    OperationalBudget:
      type: object
      required:
        [id, budgetName, clientId, buildingId, budgetPeriod, currency,
         plannedAmount, status, createdAt, updatedAt]
"""

SCHEMAS_REPLACEMENT = """    OperationalBudgetOverspendPolicy:
      type: string
      description: >
        STRICT prohibits any commitment beyond available budget.
        ALLOW_WITH_OVERRIDE permits it ONLY through the separate
        operational_budget.override authority plus an explicit recorded reason.
        Overspend is never silently permitted.
      enum: [STRICT, ALLOW_WITH_OVERRIDE]

    OperationalBudget:
      type: object
      required:
        [id, budgetName, clientId, buildingId, budgetPeriod, currency,
         plannedAmount, status, overspendPolicy, createdAt, updatedAt]
"""

BUDGET_PROPERTY_ANCHOR = """        status: { $ref: "#/components/schemas/OperationalBudgetStatus" }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    CreateOperationalBudgetRequest:
      type: object
      required: [budgetPeriod, currency, plannedAmount]
      properties:
        budgetName: { type: string, maxLength: 160 }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        plannedAmount: { type: number, minimum: 0 }

    UpdateOperationalBudgetRequest:
      type: object
      minProperties: 1
      properties:
        budgetName: { type: string, maxLength: 160 }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        plannedAmount: { type: number, minimum: 0 }
"""

BUDGET_PROPERTY_REPLACEMENT = """        status: { $ref: "#/components/schemas/OperationalBudgetStatus" }
        overspendPolicy: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicy" }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    CreateOperationalBudgetRequest:
      type: object
      required: [budgetPeriod, currency, plannedAmount]
      properties:
        budgetName: { type: string, maxLength: 160 }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        plannedAmount: { type: number, minimum: 0 }
        overspendPolicy: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicy" }

    UpdateOperationalBudgetRequest:
      type: object
      minProperties: 1
      description: >
        DRAFT-only. Changing the overspend policy of an ACTIVE budget uses the
        separately authorised POST /operational-budgets/{id}/overspend-policy.
      properties:
        budgetName: { type: string, maxLength: 160 }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        plannedAmount: { type: number, minimum: 0 }
        overspendPolicy: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicy" }
"""

COMPONENT_SCHEMAS_ANCHOR = """    OperationalBudgetAggregationEnvelope:
"""

COMPONENT_SCHEMAS = """    OperationalCommitmentStatus:
      type: string
      description: >
        Derived from the ledger amounts. RELEASED and CANCELLED are terminal;
        a commitment is never cancellable once anything is actualized.
      enum: [COMMITTED, PARTIALLY_ACTUALIZED, ACTUALIZED, RELEASED, CANCELLED]

    OperationalCommitmentOrigin:
      type: string
      description: >
        MANUAL is an explicitly reasoned estimate; PO_LINE and PO_HEADER are
        derived from an ISSUED Purchase Order, the only priced obligation
        authority in the repository.
      enum: [MANUAL, PO_LINE, PO_HEADER]

    OperationalCommitmentEntryType:
      type: string
      enum:
        [CREATE, ADJUST_INCREASE, ADJUST_DECREASE, ACTUALIZE,
         ACTUALIZE_REVERSAL, RELEASE, CANCEL, OVERRIDE]

    OperationalCommitmentOverride:
      type: object
      nullable: true
      required: [reason, byUserId, at]
      properties:
        reason: { type: string }
        byUserId: { $ref: "#/components/schemas/Uuid" }
        at: { type: string, format: date-time }

    OperationalCommitment:
      type: object
      required:
        [id, clientId, buildingId, budgetId, budgetCategoryId, origin, currency,
         committedAmount, actualizedAmount, releasedAmount, openAmount, status,
         title, idempotencyKey, createdByUserId, createdAt, updatedAt]
      properties:
        id: { $ref: "#/components/schemas/Uuid" }
        clientId: { $ref: "#/components/schemas/Uuid" }
        buildingId: { $ref: "#/components/schemas/Uuid" }
        budgetId: { $ref: "#/components/schemas/Uuid" }
        budgetCategoryId: { $ref: "#/components/schemas/Uuid" }
        origin: { $ref: "#/components/schemas/OperationalCommitmentOrigin" }
        sourceType:
          type: string
          nullable: true
          enum: [PURCHASE_ORDER, PO_LINE, null]
        purchaseOrderId: { type: string, format: uuid, nullable: true }
        purchaseOrderLineId: { type: string, format: uuid, nullable: true }
        workOrderId: { type: string, format: uuid, nullable: true }
        vendorId: { type: string, format: uuid, nullable: true }
        materialRequestId: { type: string, format: uuid, nullable: true }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        committedAmount: { type: number, minimum: 0 }
        actualizedAmount:
          type: number
          minimum: 0
          description: >
            Actualization moves value from openAmount to actualizedAmount and
            does NOT free budget, so an obligation is never counted twice.
        releasedAmount: { type: number, minimum: 0 }
        openAmount: { type: number, minimum: 0 }
        status: { $ref: "#/components/schemas/OperationalCommitmentStatus" }
        title: { type: string, maxLength: 160 }
        reason: { type: string, nullable: true }
        overspendOverride: { $ref: "#/components/schemas/OperationalCommitmentOverride" }
        idempotencyKey: { type: string }
        createdByUserId: { $ref: "#/components/schemas/Uuid" }
        closedAt: { type: string, format: date-time, nullable: true }
        closedByUserId: { type: string, format: uuid, nullable: true }
        createdAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    OperationalCommitmentEntry:
      type: object
      description: >
        Append-only. signedAmount is the effect on the commitment's open amount,
        so the entries of a commitment always sum to its openAmount. Entries are
        never updated or deleted; corrections are new entries.
      required:
        [id, commitmentId, entryType, signedAmount, currency, idempotencyKey,
         actorUserId, occurredAt, createdAt]
      properties:
        id: { $ref: "#/components/schemas/Uuid" }
        commitmentId: { $ref: "#/components/schemas/Uuid" }
        entryType: { $ref: "#/components/schemas/OperationalCommitmentEntryType" }
        signedAmount: { type: number }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        sourceBindingId: { type: string, format: uuid, nullable: true }
        idempotencyKey: { type: string }
        reason: { type: string, nullable: true }
        actorUserId: { $ref: "#/components/schemas/Uuid" }
        requestId: { type: string, format: uuid, nullable: true }
        occurredAt: { type: string, format: date-time }
        createdAt: { type: string, format: date-time }

    OperationalCommitmentDetail:
      allOf:
        - $ref: "#/components/schemas/OperationalCommitment"
        - type: object
          required: [entries]
          properties:
            entries:
              type: array
              items: { $ref: "#/components/schemas/OperationalCommitmentEntry" }

    CreateOperationalCommitmentRequest:
      type: object
      description: >
        Manual/estimated commitment. Derived scope (client, building, budget,
        status and every ledger amount) must not be supplied.
      required: [budgetCategoryId, title, amount, currency, reason, idempotencyKey]
      properties:
        budgetCategoryId: { $ref: "#/components/schemas/Uuid" }
        title: { type: string, maxLength: 160 }
        amount:
          type: number
          exclusiveMinimum: 0
          description: Positive, at most two decimals, in the budget currency.
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        reason: { type: string, maxLength: 500 }
        idempotencyKey: { type: string, minLength: 8, maxLength: 120 }
        workOrderId: { type: string, format: uuid, nullable: true }
        vendorId: { type: string, format: uuid, nullable: true }
        materialRequestId: { type: string, format: uuid, nullable: true }
        overspendOverrideReason:
          type: string
          maxLength: 500
          nullable: true
          description: >
            Required to exceed available budget, and only honoured when the
            budget policy is ALLOW_WITH_OVERRIDE and the caller holds
            operational_budget.override.

    CreatePurchaseOrderLineCommitmentRequest:
      type: object
      description: >
        Amount, currency, vendor, Building and Material Request lineage are
        derived from the ISSUED Purchase Order line and must not be supplied.
      required: [purchaseOrderLineId, budgetCategoryId, idempotencyKey]
      properties:
        purchaseOrderLineId: { $ref: "#/components/schemas/Uuid" }
        budgetCategoryId: { $ref: "#/components/schemas/Uuid" }
        idempotencyKey: { type: string, minLength: 8, maxLength: 120 }
        overspendOverrideReason: { type: string, maxLength: 500, nullable: true }

    AdjustOperationalCommitmentRequest:
      type: object
      required: [amount, reason, idempotencyKey]
      properties:
        amount:
          type: number
          description: >
            Non-zero, at most two decimals. Positive increases the obligation,
            negative decreases it; a decrease below the actualized amount is
            rejected.
        reason: { type: string, maxLength: 500 }
        idempotencyKey: { type: string, minLength: 8, maxLength: 120 }
        overspendOverrideReason: { type: string, maxLength: 500, nullable: true }

    CloseOperationalCommitmentRequest:
      type: object
      required: [reason, idempotencyKey]
      properties:
        reason: { type: string, maxLength: 500 }
        idempotencyKey: { type: string, minLength: 8, maxLength: 120 }

    ChangeOperationalBudgetOverspendPolicyRequest:
      type: object
      required: [overspendPolicy, reason]
      properties:
        overspendPolicy: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicy" }
        reason: { type: string, maxLength: 500 }

    OperationalBudgetOverspendPolicyResult:
      type: object
      required: [budgetId, overspendPolicy]
      properties:
        budgetId: { $ref: "#/components/schemas/Uuid" }
        overspendPolicy: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicy" }

    OperationalBudgetVarianceTotals:
      type: object
      description: >
        openCommitment = ledger open + eligible legacy commitment.
        actual = ledger actualized + unallocated actual.
        consumed = (ledger committed - released) + eligible legacy commitment
        + unallocated actual. available = planned - consumed.
        variance = planned - actual. Percentages are null when the plan is zero.
      required:
        [plannedAmount, ledgerCommittedAmount, ledgerOpenAmount,
         ledgerActualizedAmount, ledgerReleasedAmount, legacyCommittedAmount,
         uncommittedMaterialActualAmount, uncommittedInvoiceActualAmount,
         unallocatedActualAmount, openCommitmentAmount, actualAmount,
         consumedAmount, availableAmount, varianceAmount, utilizationPercent,
         committedUtilizationPercent]
      properties:
        plannedAmount: { type: number }
        ledgerCommittedAmount: { type: number }
        ledgerOpenAmount: { type: number }
        ledgerActualizedAmount: { type: number }
        ledgerReleasedAmount: { type: number }
        legacyCommittedAmount: { type: number }
        uncommittedMaterialActualAmount: { type: number }
        uncommittedInvoiceActualAmount: { type: number }
        unallocatedActualAmount: { type: number }
        openCommitmentAmount: { type: number }
        actualAmount: { type: number }
        consumedAmount: { type: number }
        availableAmount: { type: number }
        varianceAmount: { type: number }
        utilizationPercent: { type: number, nullable: true }
        committedUtilizationPercent: { type: number, nullable: true }

    OperationalBudgetVarianceCategory:
      type: object
      required:
        [budgetCategoryId, categoryCode, categoryName, plannedAmount,
         ledgerCommittedAmount, ledgerOpenAmount, ledgerActualizedAmount,
         ledgerReleasedAmount, legacyCommittedAmount, openCommitmentAmount,
         actualAmount, consumedAmount, availableAmount, varianceAmount,
         utilizationPercent, committedUtilizationPercent, commitmentCount]
      properties:
        budgetCategoryId: { $ref: "#/components/schemas/Uuid" }
        categoryCode: { type: string }
        categoryName: { type: string }
        plannedAmount: { type: number }
        ledgerCommittedAmount: { type: number }
        ledgerOpenAmount: { type: number }
        ledgerActualizedAmount: { type: number }
        ledgerReleasedAmount: { type: number }
        legacyCommittedAmount: { type: number }
        openCommitmentAmount: { type: number }
        actualAmount: { type: number }
        consumedAmount: { type: number }
        availableAmount: { type: number }
        varianceAmount: { type: number }
        utilizationPercent: { type: number, nullable: true }
        committedUtilizationPercent: { type: number, nullable: true }
        commitmentCount: { type: integer, minimum: 0 }

    OperationalBudgetVarianceGap:
      type: object
      description: >
        A recorded gap is described, never valued. B-02: vendor_service_costs
        and basic_expenses have no authoritative currency. B-03: no approved
        vendor amount exists before a Purchase Order.
      required: [code, reference, message, affectedSourceCount]
      properties:
        code:
          type: string
          enum: [CURRENCYLESS_COST_AUTHORITY, VENDOR_ACTUAL_WITHOUT_COMMITMENT]
        reference: { type: string, enum: [B-02, B-03] }
        message: { type: string }
        affectedSourceCount: { type: integer, minimum: 0 }

    OperationalBudgetVariance:
      type: object
      required:
        [budgetId, clientId, buildingId, budgetName, budgetPeriod, currency,
         status, overspendPolicy, totals, categories, controls, gaps, asOf]
      properties:
        budgetId: { $ref: "#/components/schemas/Uuid" }
        clientId: { $ref: "#/components/schemas/Uuid" }
        buildingId: { $ref: "#/components/schemas/Uuid" }
        budgetName: { type: string }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        status: { $ref: "#/components/schemas/OperationalBudgetStatus" }
        overspendPolicy: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicy" }
        totals: { $ref: "#/components/schemas/OperationalBudgetVarianceTotals" }
        categories:
          type: array
          items: { $ref: "#/components/schemas/OperationalBudgetVarianceCategory" }
        controls:
          type: object
          required:
            [categoryScopeIncludesUnallocatedActual,
             legacyCommitmentSupersededCount, failClosed,
             excludedContributionCount, exclusions]
          properties:
            categoryScopeIncludesUnallocatedActual:
              type: boolean
              description: >
                Always false: an unmatched source carries no cost category and
                none is inferred.
            legacyCommitmentSupersededCount: { type: integer, minimum: 0 }
            failClosed: { type: boolean }
            excludedContributionCount: { type: integer, minimum: 0 }
            exclusions:
              type: array
              items: { $ref: "#/components/schemas/OperationalBudgetAggregationExclusion" }
        gaps:
          type: array
          items: { $ref: "#/components/schemas/OperationalBudgetVarianceGap" }
        asOf: { type: string, format: date-time }

    OperationalBudgetVarianceSummary:
      type: object
      required:
        [budgetId, clientId, buildingId, budgetName, budgetPeriod, currency,
         status, totals, failClosed, gapCount]
      properties:
        budgetId: { $ref: "#/components/schemas/Uuid" }
        clientId: { $ref: "#/components/schemas/Uuid" }
        buildingId: { $ref: "#/components/schemas/Uuid" }
        budgetName: { type: string }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        status: { $ref: "#/components/schemas/OperationalBudgetStatus" }
        totals: { $ref: "#/components/schemas/OperationalBudgetVarianceTotals" }
        failClosed: { type: boolean }
        gapCount: { type: integer, minimum: 0 }

    OperationalBudgetTraceabilityRow:
      type: object
      required: [classification, sourceType, sourceId]
      properties:
        classification:
          type: string
          enum: [COMMITMENT, LEGACY_COMMITMENT, ACTUAL, EXCLUDED]
        sourceType: { type: string }
        sourceId: { $ref: "#/components/schemas/Uuid" }
        commitmentId: { type: string, format: uuid, nullable: true }
        bindingId: { type: string, format: uuid, nullable: true }
        budgetCategoryId: { type: string, format: uuid, nullable: true }
        amount: { type: number, nullable: true }
        openAmount: { type: number, nullable: true }
        actualizedAmount: { type: number, nullable: true }
        currency: { type: string, nullable: true }
        status: { type: string, nullable: true }
        description: { type: string, nullable: true }
        purchaseOrderId: { type: string, format: uuid, nullable: true }
        purchaseOrderLineId: { type: string, format: uuid, nullable: true }
        vendorId: { type: string, format: uuid, nullable: true }
        workOrderId: { type: string, format: uuid, nullable: true }
        materialRequestId: { type: string, format: uuid, nullable: true }
        vendorInvoiceId: { type: string, format: uuid, nullable: true }
        workOrderMaterialUsageId: { type: string, format: uuid, nullable: true }
        exclusionReason: { type: string, nullable: true }

    OperationalBudgetTraceability:
      type: object
      required:
        [budgetId, clientId, buildingId, budgetPeriod, currency, rowCount, rows, asOf]
      properties:
        budgetId: { $ref: "#/components/schemas/Uuid" }
        clientId: { $ref: "#/components/schemas/Uuid" }
        buildingId: { $ref: "#/components/schemas/Uuid" }
        budgetPeriod: { $ref: "#/components/schemas/OperationalBudgetPeriod" }
        currency: { $ref: "#/components/schemas/OperationalBudgetCurrency" }
        rowCount: { type: integer, minimum: 0 }
        rows:
          type: array
          items: { $ref: "#/components/schemas/OperationalBudgetTraceabilityRow" }
        asOf: { type: string, format: date-time }

    OperationalCommitmentEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data: { $ref: "#/components/schemas/OperationalCommitment" }

    OperationalCommitmentListEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data:
              type: array
              items: { $ref: "#/components/schemas/OperationalCommitment" }

    OperationalCommitmentDetailEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data: { $ref: "#/components/schemas/OperationalCommitmentDetail" }

    OperationalBudgetOverspendPolicyEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data: { $ref: "#/components/schemas/OperationalBudgetOverspendPolicyResult" }

    OperationalBudgetVarianceEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data: { $ref: "#/components/schemas/OperationalBudgetVariance" }

    OperationalBudgetVarianceListEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data:
              type: array
              items: { $ref: "#/components/schemas/OperationalBudgetVarianceSummary" }

    OperationalBudgetTraceabilityEnvelope:
      allOf:
        - $ref: "#/components/schemas/SuccessEnvelope"
        - type: object
          properties:
            data: { $ref: "#/components/schemas/OperationalBudgetTraceability" }

"""


def splice(document: str, anchor: str, addition: str, marker: str) -> str:
    if marker in document:
        return document
    if anchor not in document:
        raise SystemExit(f"anchor not found: {anchor[:60]!r}")
    return document.replace(anchor, addition + anchor, 1)


def main() -> None:
    document = SPEC.read_text(encoding="utf8")

    document = splice(
        document, PATHS_ANCHOR, PATHS, "  /operational-budgets/{budgetId}/variance:\n"
    )
    document = splice(
        document,
        RESPONSES_ANCHOR,
        RESPONSES,
        "    OperationalBudgetVarianceSuccess:\n",
    )
    document = splice(
        document,
        COMPONENT_SCHEMAS_ANCHOR,
        COMPONENT_SCHEMAS,
        "    OperationalBudgetVariance:\n",
    )

    if "    OperationalBudgetOverspendPolicy:\n" not in document:
        if SCHEMAS_ANCHOR not in document:
            raise SystemExit("budget schema anchor not found")
        document = document.replace(SCHEMAS_ANCHOR, SCHEMAS_REPLACEMENT, 1)

    if "        overspendPolicy: { $ref: \"#/components/schemas/OperationalBudgetOverspendPolicy\" }\n        createdAt" not in document:
        if BUDGET_PROPERTY_ANCHOR not in document:
            raise SystemExit("budget property anchor not found")
        document = document.replace(
            BUDGET_PROPERTY_ANCHOR, BUDGET_PROPERTY_REPLACEMENT, 1
        )

    SPEC.write_text(document, encoding="utf8")
    print(f"spliced CR-BE-COMM-VAR-01 contract into {SPEC}")


if __name__ == "__main__":
    main()
