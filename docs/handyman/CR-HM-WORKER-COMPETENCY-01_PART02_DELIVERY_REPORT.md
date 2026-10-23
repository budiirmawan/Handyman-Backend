# CR-HM-WORKER-COMPETENCY-01 — PART 02: REST API & Worker Profile Integration

- **CR ID:** `CR-HM-WORKER-COMPETENCY-01`
- **Part:** `PART 02`
- **Repository:** `budiirmawan/Handyman-Backend`
- **Branch:** `arena/3df97f5e-handyman-backend`
- **Baseline PART 01:** commit `398925f` (cherry-picked onto this branch as the PART 01 foundation)
- **Status:** `DELIVERED — READY FOR PART 03`
- **Scope:** HTTP certification management for Operations + Mobile worker-profile projection.

---

## 1. Preflight results

| # | Check | Result |
|---|---|---|
| 1 | Active branch and PART 01 commit | `arena/3df97f5e-handyman-backend` branched from `main` @ `e8b94af`. PART 01 (`398925f`) lived on the sibling Arena branch `arena/1338174d-handyman-backend`; it was **not** present on this branch, so the exact PART 01 commit was cherry-picked (`1597ac5`) before any PART 02 work. No PART 01 file was rewritten during the import. |
| 2 | Migration `0461` uniqueness | `0461_create_workforce_certifications` is registered exactly once in `src/database/migrations/index.ts` (line after `0460`). No other file, ledger or doc claims `0461`; `0449` remains intentionally unclaimed. The new authority migration continues at `0462` — no historical migration was edited or renumbered. |
| 3 | PART 01 foundation preserved | Table, repository, validation, error registry, service, and its 6-part service suite are intact. Three **confirmed defects** were corrected (see §5) because they contradicted the PART 02 business rules; nothing else in PART 01 was rewritten. |
| 4 | Routing / auth / RBAC / envelope audit | Router-factory pattern (`createXRouter()` mounted in `src/routes/index.ts`), `authenticationMiddleware` + `requirePermission(code)` per route, `sendSuccess(res, data, status, meta)` envelope. PART 02 follows all four. A deviation found on the sibling branch's unpublished draft (`res.status(...).json({ data })`) was **not** adopted: the frozen envelope is used everywhere. |

Disposable-PostgreSQL evidence: the focused HTTP suite runs `migrateUp()` over the **complete canonical
registry** (including `0461` + `0462`) on an embedded PostgreSQL instance.

---

## 2. Endpoints (7)

| # | Method + path | Permission | Status codes |
|---|---|---|---|
| 1 | `GET /api/v1/workforce/:workforceId/certifications` | `workforce_certification.read` | 200 / 400 / 401 / 403 / 404 |
| 2 | `GET /api/v1/workforce/:workforceId/certifications/:certificationId` | `workforce_certification.read` | 200 / 400 / 401 / 403 / 404 |
| 3 | `POST /api/v1/workforce/:workforceId/certifications` | `workforce_certification.manage` | 201 / 400 / 401 / 403 / 404 / 409 |
| 4 | `PATCH /api/v1/workforce/:workforceId/certifications/:certificationId` | `workforce_certification.manage` | 200 / 400 / 401 / 403 / 404 / 409 |
| 5 | `POST /api/v1/workforce/:workforceId/certifications/:certificationId/verify` | `workforce_certification.verify` | 200 / 400 / 401 / 403 / 404 / 409 |
| 6 | `POST /api/v1/workforce/:workforceId/certifications/:certificationId/deactivate` | `workforce_certification.manage` | 200 / 400 / 401 / 403 / 404 |
| 7 | `GET /api/v1/workforce/certifications/expiring` | `workforce_certification.read` | 200 / 400 / 401 / 403 |

The Workforce Profile id always comes from the route — never from the body or query. Every operation
uses the frozen `{ success, data, meta }` / `{ success, error }` envelope. The `expiring` literal segment
is registered before the `:workforceId` routes so it can never be captured as a profile id.

---

## 3. Permission matrix

### 3.1 Authority codes (migration `0462`)

| Code | Grants | Default grant policy |
|---|---|---|
| `workforce_certification.read` | list, detail, expiry watch | ordinary operational administration → PLATFORM_ADMIN by the foundation seed policy |
| `workforce_certification.manage` | create, update metadata, deactivate | ordinary operational administration → PLATFORM_ADMIN by the foundation seed policy |
| `workforce_certification.verify` | VERIFIED / REJECTED decision | **withheld from every role** (`UNASSIGNED_BY_DEFAULT_PERMISSION_CODES`); explicit administrative grant required |

Deliberately **not** accepted as substitutes: `skill.read`, `skill.manage`, `workforce.read`,
`workforce.manage`, `tenant_company.read`, `tenant_company.manage`. Those administer the Skill
catalogue, the person, and tenant administration respectively — not an individual's competence
attestation — and `tenant_company.*` is exactly the "permission too broad" case.

### 3.2 Actor × operation

| Actor | List / Detail | Create / Update / Deactivate | Verify / Reject | Expiry watch |
|---|---|---|---|---|
| Certificate owner (self) | **allowed** (service-level self-read; the Mobile profile surface needs no permission) | requires `manage` | **403** `WORKFORCE_CERTIFICATION_SELF_VERIFICATION_FORBIDDEN` | requires `read` |
| ACTIVE Crew Lead of the worker's ACTIVE crew | **allowed** (same Client) | requires `manage` | requires `verify` and must not be the owner | requires `read` |
| Plain peer crew member | 403 `WORKFORCE_CERTIFICATION_FORBIDDEN` | 403 | 403 | 403 |
| `workforce_certification.read` holder | allowed, inside Client scope | 403 `PERMISSION_DENIED` | 403 | allowed, Client-scoped |
| `workforce_certification.manage` holder | requires `read` too | allowed | 403 `PERMISSION_DENIED` (manage ≠ verify) | requires `read` |
| `workforce_certification.verify` holder | requires `read` too | 403 | allowed (never on own record) | requires `read` |
| Actor without Client access (incl. another Client's admin) | 403 `BUILDING_ACCESS_DENIED` | 403 `BUILDING_ACCESS_DENIED` | 403 `BUILDING_ACCESS_DENIED` | empty list / scoped only |

**Client isolation is independent of permission breadth**: `contextAccessService.canAccessClient` (and
`getAccessibleClientIds` for the expiry watch) is evaluated on every operation, before any data is read.
The expiry watch never accepts a Client from the caller.

---

## 4. Business rules → enforcement map

| Rule | Enforcement |
|---|---|
| Certificates are optional | Profile projection degrades to `[]`; a worker with zero rows returns `200`; service tests assert it. |
| Certificate number is mandatory | Validation (`certificateNumber`), DB `CHECK` (1..128 after trim) + partial unique index on `(workforce_profile_id, lower(btrim(certificate_number))) WHERE status='ACTIVE'`. |
| Different from skill assignment / vendor licence | Separate table and module; authoritative codes are not shared; HTTP tests assert `workforce_skill_assignments` and `vendor_licenses_certifications` stay untouched by a certificate create. |
| Verification only by an authorized actor, never the owner | Dedicated `workforce_certification.verify` (not inherited) + `ensureVerifyAccess` ownership check → `403 …SELF_VERIFICATION_FORBIDDEN`. |
| Expired ≠ valid | `isExpired` / `isValid` derived per read; `currentOnly` excludes expired; verifying an expired certificate → `409 WORKFORCE_CERTIFICATION_VERIFICATION_NOT_ALLOWED`. |
| Metadata validated (issuer, dates, verification status, document reference) | §`validation.ts` + DB `CHECK` constraints + trigger-level Client scope for `skill_id` / `document_id`; verification status is **not** part of create/update. |
| Client isolation incl. document reads | Trigger (`0461`) + `ensureDocumentInClient` (409 mismatch) + `contextAccessService` on every operation; the Mobile projection never exposes a storage key. |
| Mutation + decision audit | `operational_events` `WORKFORCE_CERTIFICATION_CREATED / UPDATED / VERIFIED / DEACTIVATED`, with previous and new status and the deciding actor. |
| Permissions match the authority boundary | Dedicated namespace; no broad code accepted (see §3.1). |

---

## 5. Corrections to PART 01 (confirmed defects only)

1. **Broad permissions admitted** — PART 01 accepted `skill.*`, `workforce.*` and `tenant_company.*`
   for certification reads/writes. Against rule C (`jangan membuka sertifikat … hanya karena permission
   terlalu luas`) those codes are now rejected; the dedicated `workforce_certification.*` namespace is the
   sole authority. Client isolation was already structural and stays so.
2. **Verification could be bypassed** — PART 01 let a `manage` actor create a certificate directly as
   `VERIFIED`, or flip `verificationStatus` through `PATCH`. Both paths are now closed: create always
   produces `PENDING_VERIFICATION`, and `verificationStatus` is rejected on create/update with a
   `VALIDATION_ERROR` pointing at the verify endpoint.
3. **No separation of duties** — PART 01 had no ownership guard. `verify` now requires the dedicated
   permission *and* refuses the certificate owner.

Everything else in PART 01 (schema, constraints, trigger, repository shape, file-reference policy,
operational-event vocabulary) is untouched. The PART 01 suite was updated only where these three
decisions changed an assertion (permission strings, the create-as-VERIFIED case, and the modeled flag).

---

## 6. DTO changes

### 6.1 Operations (`WorkforceCertification`)

Additive fields: `isExpired: boolean`, `isValid: boolean`. Existing fields unchanged.

New request bodies:

- `CreateWorkforceCertificationRequest`: `certificateNumber*`, `certificateName*`, `issuingAuthority*`,
  `issueDate*`, `expiryDate?`, `status?`, `skillId?`, `documentId?`, `fileReference?`, `notes?`
  (`verificationStatus` deliberately absent).
- `UpdateWorkforceCertificationRequest`: at least one of `certificateNumber`, `certificateName`,
  `issuingAuthority`, `issueDate`, `expiryDate`, `status`, `skillId`, `documentId`, `fileReference`,
  `notes`.
- `VerifyWorkforceCertificationRequest`: `verificationStatus*`, `notes?`.
- `DeactivateWorkforceCertificationRequest`: `reason?` (audit metadata only).

### 6.2 Mobile (`certificationsAndExpiry`)

Backward-compatible and additive:

- `individualCertificateNumberModeled`: `false` → **`true`** (the capability is real now).
- **NEW** `individualCertifications: WorkforceCertificationMobileSummary[]` with `id`,
  `certificateNumber`, `certificateName`, `issuingAuthority`, `skillId`, `skillCode`, `skillName`,
  `status`, `verificationStatus`, `issueDate`, `expiryDate`, `expiryStatus`, `isExpired`, `isValid`,
  `documentAvailable`, `documentId`.
- `skillValidityWindows` and `providerLicensesAndCertifications` unchanged in meaning and shape.
- Raw `fileReference` is **never** projected to Mobile.

---

## 7. Contract & documentation

- `docs/api/openapi.yaml`: 7 operations + `WorkforceCertification`, `WorkforceCertificationExpiringItem`,
  `WorkforceCertificationMobileSummary`, request bodies, enum schemas, and the
  `WorkforceCertificationIdPath` parameter. Every operation carries `x-required-permission` and
  `x-error-codes`. `HandymanWorkerProfile.certificationsAndExpiry` now requires and documents
  `individualCertifications`.
- Runtime↔OpenAPI parity re-verified: `runtime === openapi === 1992` operations, `platform` unchanged at
  69/69, `/handyman` unchanged at 269/269.
- `MOBILE_API_HANDOFF.md`: §7 added (permissions, payloads, verify/deactivate semantics, expiry watch,
  validity semantics) and §5.3 updated (modeled flag + projection notes).
- Contract pins reconciled: permission catalogue `362 → 365` and
  `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES += workforce_certification.verify`
  (`tests/config-perm-01-permission-registry.test.ts`).
- Pre-existing stale pins left untouched (they were already failing on `main` before this change and are
  outside PART 02's scope): `tests/openapi-operational-final-parity.test.ts` (`1687`),
  `tests/deployment-cors-production.test.ts` (migration count `457` / head `0458`),
  `tests/r08-*` migration counts.

---

## 8. Test evidence (focused only — full suite not run)

| Suite | Result |
|---|---|
| `tests/workforce-certifications-http.test.ts` (new, 18 tests) | **pass 18 / fail 0** |
| `tests/workforce-certifications.test.ts` (PART 01 service, adjusted) | **pass 6 / fail 0** |
| `tests/handyman-worker-profile-schema-regression.test.ts` (canonical schema) | **pass 5 / fail 0** |
| `tests/handyman-worker-profile.test.ts` | **pass 4 / fail 0** |
| `tests/config-perm-01-permission-registry.test.ts` | **pass 13 / fail 0** |
| `tests/openapi-contract.test.ts` | **pass 7 / fail 0** |
| `tests/mobile-openapi-completeness.test.ts` | **pass 5 / fail 0** |
| `tests/handyman-contract-freeze-03-openapi.test.ts` | **pass 13 / fail 0** |
| `npm run typecheck` | clean |
| `npm run build` | clean |

The new HTTP suite covers: 401 on all seven operations; 201 create with envelope; mandatory number;
reversed dates; unsafe/traversal `fileReference`; duplicate ACTIVE number (409); metadata-only update;
`verificationStatus` rejection on create/update; manage ≠ verify; verifier ≠ manager; self-verification
forbidden; expired certificate not verifiable and never `isValid`; `currentOnly`; expiry watch window and
bounds; cross-Client read/write/verify/document rejection; expiry-watch Client scoping; dedicated-only
permissions; profile projection (with and without certificates, no storage-key leak, INACTIVE
withdrawal); scoped worker-profile visibility; `PLATFORM_ADMIN` without a worker context → `404
HANDYMAN_WORKER_PROFILE_NOT_FOUND` (never 500) and `403 BUILDING_ACCESS_DENIED` on a scoped read.

**Migration evidence:** `migrateUp()` executed the full canonical registry (`0001` … `0462`) on a
disposable embedded PostgreSQL cluster in the HTTP suite before any assertion ran.

---

## 9. Operator / rollout notes

- `0462` registers the three permission rows but grants nothing (precedent `0448` / `0450`). Run the
  idempotent foundation seed (`db:seed`, or the owner bootstrap) to apply the default policy
  (`read` + `manage` to `PLATFORM_ADMIN`). `verify` stays unassigned by design — grant it explicitly,
  and never to a worker who owns certification records.
- No PR, merge, or deployment (Railway / Vercel / Coolify Biznet) was performed.

---

## 10. PART 03 backlog

See `docs/handyman/CR-HM-WORKER-COMPETENCY-01_PART03_BACKLOG.md`.
