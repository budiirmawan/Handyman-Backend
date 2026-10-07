# Known Issues — Asentra Backend

Defects that are **known and reproduced** are tracked here with their root cause
and authorised repair scope. Resolved entries remain as closure evidence; open
entries continue to describe work that must not be folded into unrelated CRs.

---

## KI-001 — Vendor Invoice generated-outstanding payment failure — RESOLVED

- **Status:** closed / resolved
- **Found by:** CR-BE-R2P-01 PART 06 (documented in PART 07)
- **Resolved by:** CR-BE-PAY-01 PART 01–02
- **Affected surface:** `POST /api/v1/vendor-invoices/{id}/payment`

### Root cause

The application explicitly wrote `outstanding_amount` during payment even
though PostgreSQL defines `vendor_invoices.outstanding_amount` as:

```sql
NUMERIC(18, 2) GENERATED ALWAYS AS (invoice_amount - paid_amount) STORED
```

PostgreSQL correctly rejected the explicit assignment, causing payment requests
to return HTTP 500.

### Resolution evidence

- **PART 01:** removed the explicit `outstanding_amount` write and restored the
  generated column as the sole outstanding-balance authority.
- **PART 02:** moved payment mutation into one transaction protected by a
  `SELECT ... FOR UPDATE` row lock, with cumulative payment decisions based on
  locked current state and payment/history/event consistency strengthened.
- `outstanding_amount` remains database-generated from `invoice_amount` and
  cumulative `paid_amount`; no service-side balance authority was introduced.
- No parallel payment or settlement architecture was introduced.

Focused payment regression now passes for partial, full, sequential and
concurrent payments, generated outstanding balance, audit snapshots, required
event rollback, lifecycle/access rejection, and overpayment prevention.

---

## KI-002 — BAST document creation fails (`documents.document_number` NOT NULL) — RESOLVED

- **Status:** closed / resolved
- **Found by:** CR-BE-R2P-01 FINAL REVIEW (observed only; not caused by the CR)
- **Closed by:** post-stabilization backend closure review (2026-08-22)
- **Historical severity:** high — canonical BAST documents could not be created
- **Affected surface:** `POST /api/v1/bast-documents` and the BAST suites

### Historical symptom

BAST creation was reported to fail with:

```
null value in column "document_number" of relation "documents"
violates not-null constraint
```

### Historical root cause

The observed BAST creation path inserted into `documents` without supplying
`document_number`, while that column was declared `NOT NULL` with no default:

```sql
INSERT INTO documents (id, client_id, building_id, document_type, status,
                       title, created_by_user_id)
VALUES ($1, $2, $3, 'BAST', 'DRAFT', 'Test BAST', $4)
```

The failure was reproduced at the CR base commit `beb0309` with **no**
CR-BE-R2P-01 code present. CR-BE-R2P-01 neither introduced nor touched that
path, so the entry correctly recorded the defect as pre-existing.

### Current resolution evidence

The current canonical BAST path no longer has the reported omission:

- `parseCreateBastDocumentBody` requires a non-empty `documentNumber`, and
  `CreateBastDocumentInput` makes it mandatory.
- `createBastDocument` passes `input.documentNumber` to the shared
  `documentService.createDocument` path.
- `documentRepository.create` includes `document_number` in the `documents`
  insert and binds `input.documentNumber` to it.
- The canonical BAST foundation and lifecycle integration suites submit a
  `documentNumber` and assert successful HTTP 201 creation. These BAST suites
  were also inspected against the canonical contract during CR-BE-STAB-03
  PART 02, with no further stale implementation assertion identified.

Therefore the current code evidence directly addresses the recorded NOT NULL
failure, and KI-002 is closed. This documentation-only closure does not claim
a new production-code fix or alter historical attribution. Earlier handoff
references to KI-002 as open remain point-in-time history and do not override
this entry's current status.

No PostgreSQL-backed suite was run during this documentation-only closure, in
accordance with its validation scope. The historical focused verification
command remains:

```
npx tsx --test tests/bast-foundation-part01.test.ts \
                tests/bast-lifecycle-part02.test.ts \
                tests/bast-legacy-compatibility-part03.test.ts
```

---

## KI-003 — Legacy Test Suite Assertion Alignment Debt — DEFERRED

- **Status:** open / deferred (non-blocking CI debt)
- **Documented by:** CR-BE-CI-01 (2026-08-23)
- **Scope:** Legacy integration suites containing strict key-set assertions written prior to cross-cutting feature additions (e.g. BE-25B mobile scope, CR-BE-COM-02 BAST requirements).

### Symptom & Root Cause

As domain entities and authoritative contracts evolve through feature milestones (such as `EffectiveUserContext` adding `scope` in BE-25B, and `WorkOrder` adding `bastRequirement` in CR-BE-COM-02), older pre-existing test suites that use strict `Object.keys()` equality assertions may fail in full CI execution when encountering newly mandated canonical fields.

### Governance & Resolution Policy

- CR-BE-CI-01 confirmed and repaired the immediate contract assertion drifts in `tests/sessions.test.ts` (`scope`) and `tests/work-orders.test.ts` (`bastRequirement`).
- Full PostgreSQL CI regression execution remains active via `.github/workflows/ci.yml`.
- Any further legacy assertion drifts are classified as non-blocking test alignment debt to be remediated iteratively per module without weakening or deleting tests or altering authoritative production behavior.
