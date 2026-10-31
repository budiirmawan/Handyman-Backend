# CR-HM-BE-CARE-OPENAPI-CONTRACT-01 — PART 09 Delivery

Correct the authoritative Care request response schema.

- **Change request:** `CR-HM-BE-CARE-OPENAPI-CONTRACT-01`
- **Part:** PART 09 (one focused Backend contract/documentation correction)
- **Branch:** `arena/9ab3fff8-handyman-backend`
- **Required ancestor:** `c5d1931`
- **Verified baseline HEAD:** `c5d19318da43440d385038225b3e195c7fb01dcd`
- **Frontend PART 08 reference (read-only, not touched):** `a366346`
- **Verdict:** **PASS**
- **Migration required:** **NO** (registry unchanged at 535)
- **Frontend modified:** **NO** — Backend contract/documentation only

---

## 1. Verified baseline

| Check | Result |
| --- | --- |
| `git merge-base --is-ancestor c5d1931 HEAD` | TRUE after restoration |
| Branch | `arena/9ab3fff8-handyman-backend` (never switched) |
| Working tree before the edit | Clean at `c5d1931` |
| Migration registry | 535 files, 0 touched |
| Frontend repository | Not opened, not modified |

The local checkout had again drifted to `4ff4608` with the PART 04 + PART 06
content sitting uncommitted. Before touching anything the drift was proven
harmless: `git diff --stat c5d1931` showed no change to any tracked file, and
all six untracked files hashed **byte-identical** to their `c5d1931` blobs.
`git reset --hard origin/arena/9ab3fff8-handyman-backend` then restored the
branch head. No branch switch, no re-clone, no unrelated work overwritten.

---

## 2. Root cause

Frontend PART 08 passed isolated real HTTP E2E **33/33** but its contract
validation flagged that the Backend documents a response shape the Backend
does not produce.

The defect was **doubly** wrong in one place — `HandymanCustomerCareServiceRequest`
listed two names in `required` that it did not even declare as `properties`:

```yaml
# BEFORE (docs only)
required:
  [id, clientId, channelAttributionId, tenantCompanyId, tenantPicId,
   buildingId, spaceId, serviceCatalogId, serviceVariantId,
   originChannel, originReference, description,
   preferredWindowStart,      # <-- required, and not a property at all
   preferredWindowEnd,        # <-- required, and not a property at all
   status, createdByUserId, createdAt, updatedAt, actorType, careActorId,
   actorReference, attribution, executionScopeId]
```

Four independent authorities agree they are absent from this projection:

1. **`CUSTOMER_CARE_PROJECTION_SELECT`** (`handyman-service-request.repository.ts:45`)
   never selects `preferred_window_start` / `preferred_window_end` — the columns
   are not in the statement at all.
2. **`toCustomerCarePublic`** (`handyman-service-request.service.ts:95`) emits
   exactly 21 keys, none of them a window. It is the single projector behind
   every list, detail and workspace read.
3. **`HandymanCustomerCareServiceRequestRecord`** /
   `PublicHandymanCustomerCareServiceRequest` (`handyman-service-request.types.ts:110,125`)
   have no window field, so the type system says the same thing.
4. **Live HTTP** (test 5 of the new suite) returns the 21 documented keys and
   nothing else.

The database cannot be the source either: the window lives in a **different
table** (`handyman_scheduling_readiness`, migration `0387`), not on
`handyman_service_requests`.

### Exact correction

`docs/api/openapi.yaml` — `HandymanCustomerCareServiceRequest`:

- `preferredWindowStart` and `preferredWindowEnd` **removed from `required`**;
- **no property added** (they were never properties — nothing fictional was
  introduced);
- the field contract is otherwise byte-identical: the same 21 required names
  in the same conceptual order plus the optional detail-only `items`;
- a short description sentence records *where* the window actually lives, so
  the mistake cannot silently return.

Because `CareWorkspaceRequestDetail` (`allOf`), `CareWorkspaceRequestPage.items`
and the unlisted-intake internal-notes response all `$ref`/compose this one
schema, the correction propagates without a second edit.

### Scope of the edit

`docs/api/openapi.yaml`, +27 / −4 lines. No TypeScript, no route, no service,
no repository, no migration, no frontend change.

---

## 3. Create-versus-read contract distinction

The preferred window is a **create-side fact**, and it remains fully documented
as such:

| Contract | Owner | Window status | Changed? |
| --- | --- | --- | --- |
| `HandymanCareRequestCreateBody` | Care Building intake body | declares both, **optional pair** | NO |
| `CreateCareHandymanServiceRequest` | exchange-token Care intake | declares both, **optional pair** | NO |
| `HandymanCareSchedulingPreference` | `schedulingReadiness` on the CREATE response | both **required** | NO |
| `HandymanSchedulingReadinessRecord` | `GET …/scheduling-readiness` (`current`/`history`) | both **required** (columns are `NOT NULL`) | NO |
| `CreateHandymanSchedulingReadinessRequest` | readiness create | both **required** | NO |
| `HandymanUnlistedIntakePreferredWindow` / `HandymanUnlistedIntakeCase` | unlisted intake lane | unchanged | NO |
| **`HandymanCustomerCareServiceRequest`** | list + detail read projection | **absent — was wrongly required** | **YES (this part)** |

Runtime confirmation of the split (test 6):

- `POST /handyman/care/buildings/{buildingId}/requests` with a window returns
  `201` and `data.schedulingReadiness = {id, timezone, preferredWindowStart,
  preferredWindowEnd, status, supersedesReadinessId}` — exactly the
  `HandymanCareSchedulingPreference` field set, with `timezone: "Asia/Jakarta"`
  derived from the Building.
- One `handyman_scheduling_readiness` row is persisted with those exact
  instants → the read projection omitting them is a **contract fact, not data
  loss**.
- `GET /handyman/requests/{id}/scheduling-readiness` returns the same instants
  under `data.current` → the preference is readable, through its own contract.
- `GET /handyman/requests/{id}` returns neither field, and the request status is
  still `INTAKE` with **zero** `handyman_visit_appointments` rows → a tenant
  scheduling preference is **not** a confirmed appointment and creates no
  appointment authority.

Paired-optional intake validation is preserved unchanged (test 7): a lone
start, a lone end and inverted bounds all return `400`
`HANDYMAN_SCHEDULING_READINESS_WINDOW_INVALID`; omitting both keeps the legacy
no-date intake and the response has no `schedulingReadiness` key at all.

---

## 4. Second defect found and corrected (same read contract)

The runtime evidence exposed a *value-domain* mismatch in the very schema under
correction: `originChannel` was documented as `enum: [BM_SUPER_APP]`, but a real
Care Building-session request is written on the `CUSTOMER_CARE_BACKEND` channel,
and the runtime returns exactly that:

```
"originChannel": "CUSTOMER_CARE_BACKEND"
```

The governed domain enum (`HANDYMAN_CHANNEL_ATTRIBUTION_ORIGIN_CHANNELS`,
`handyman-channel-attribution.types.ts:23`) is
`['BM_SUPER_APP', 'CUSTOMER_CARE_BACKEND']`. A documented response contract that
rejects a whole class of rows the endpoint really returns is the same class of
defect PART 09 was raised for, and the PART 09 acceptance criterion is that the
Backend OpenAPI matches the verified runtime response — so both occurrences
inside the corrected read contract were widened to the governed enum:

- `HandymanCustomerCareServiceRequest.properties.originChannel`
- `HandymanRequestAttributionProvenance.properties.originChannel` (the nested
  `attribution` object of the same response)

This is documentation only: no field was added, removed or renamed, and the
values are taken verbatim from the domain enum (test 5 asserts each documented
value exists in the TypeScript source). `actorType` remains
`enum: [CUSTOMER_CARE], nullable: true`, which correctly admits the `null`
of a Care-staff intake whose acting identity is the staff user.

---

## 5. Focused test results

New suite: `tests/handyman-care-openapi-contract-part09.test.ts` (886 lines,
9 tests), run against a disposable embedded PostgreSQL on a unique port with
real authenticated sessions:

`ASENTRA_USE_EMBEDDED_POSTGRES=true npx tsx --test --test-reporter=tap <file>`

| # | Check | Result |
| --- | --- | --- |
| 1 | Read schema is key-exact with the runtime projection | PASS |
| 2 | Every composing schema inherits the correction | PASS |
| 3 | Create and readiness contracts keep the window | PASS |
| 4 | YAML parses and every `$ref` resolves | PASS |
| 5 | Runtime read serializes exactly the documented fields, no window | PASS |
| 6 | Window survives intake, stays out of the read, is not an appointment | PASS |
| 7 | Paired-optional intake rule preserved | PASS |
| 8 | PART 04 structured create/read + PART 06 metadata compatible | PASS |
| 9 | Customer-facing read exposes no internal-note surface | PASS |

**9/9 PASS.**

What tests 1–2 assert beyond the obvious: `required` equals the runtime key set
**in both directions** (nothing required that is absent, nothing present that is
undocumented), `properties` equals that set plus the optional `items`, and no
property is documented that the projection cannot emit. Prose that *explains*
the distinction is allowed; a *declared field* is not.

Regression sweep (focused only, no full suite):

| Suite | Result |
| --- | --- |
| `handyman-care-building-structured-items-part04` (PART 04) | **12/12 PASS** |
| `handyman-care-catalog-metadata-part06` (PART 06) | **9/9 PASS** |
| `handyman-scheduling-readiness` | **10/10 PASS** |
| `handyman-care-workspace-requests` (workspace page schema coupling) | **16/16 PASS** |
| `handyman-customer-care-request-reads` | **0/8 — PRE-EXISTING, not caused by this part** |

The last suite fails because its own teardown `TRUNCATE` is rejected by the BM
immutability trigger (`Issued BM documents are immutable and cannot be
removed`, PL/pgSQL `hm_bm_issued_document_immutable`). Proven pre-existing by
stashing every PART 09 change and re-running: **identical 0 ok / 8 failed**.
It is an unrelated failing suite and was **not modified**.

Static checks:

- `npx tsc --noEmit` → **exit 0**
- OpenAPI YAML parse → OK; internal `$ref` walk → **21,351 refs, 0 unresolved**
- `git diff --check` → **CLEAN**
- Migration registry → 535, none added or modified

---

## 6. Remaining contract mismatches (reported, deliberately not fixed)

Same `originChannel` value-domain defect still exists in three *other*
contracts, which are outside the read contract corrected here. They were left
untouched to keep PART 09 focused; each needs its own verified change:

| Location | Schema | Note |
| --- | --- | --- |
| `docs/api/openapi.yaml:99075` | `HandymanServiceRequest` | general request projection; also emits `originChannel` |
| `docs/api/openapi.yaml:94731` | `HandymanChannelAttribution` | attribution resource; domain enum admits both channels |
| `docs/api/openapi.yaml:91280` | `CareCreateExchangeIssued` | **correct as-is** — a BM-issued handoff artifact really is `BM_SUPER_APP`-only |

Recommended follow-up: widen the first two to the governed enum
`[BM_SUPER_APP, CUSTOMER_CARE_BACKEND]` in one focused documentation change,
leaving `CareCreateExchangeIssued` as-is.

No other mismatch was found: the runtime body of every list/detail read, the
Care Building detail block (`{request, items, progress}`), the PART 04 item
projection and the PART 06 metadata payload all match what is documented.

---

## 7. Files changed

| File | Δ |
| --- | --- |
| `docs/api/openapi.yaml` | +27 / −4 |
| `tests/handyman-care-openapi-contract-part09.test.ts` | +886 (new) |
| `docs/handyman/CR-HM-BE-CARE-OPENAPI-CONTRACT-01_PART09_DELIVERY.md` | this report |

No TypeScript, no runtime behaviour, no migration, no seed, no frontend.
No PR, no merge, no deployment — **STOP after PART 09.**

---

## 8. Commit

- **Implementation + report:** `__COMMIT_SHA__`
