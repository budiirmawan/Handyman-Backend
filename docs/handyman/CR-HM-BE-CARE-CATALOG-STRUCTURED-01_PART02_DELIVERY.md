# CR-HM-BE-CARE-CATALOG-STRUCTURED-01 — PART 02 Delivery

**Date:** 2026-10-31

**Scope:** Reconcile only the PART 01 structured Care intake changes against the verified current repository baseline. No frontend/mobile work, internal-only note implementation, deployment, merge, or full-suite run.

**Overall decision:** **BLOCKED for active production-lineage certification.** The PART 01 patch is committed and focused validation passes on the verified current `main` code baseline. Available GitHub deployment metadata does not identify an active current production SHA; the previously reported `4ff...` SHA is a branch tip, not a deployment record.

## 1. Repository and ancestry verification

- Remote: `https://github.com/budiirmawan/Handyman-Backend.git`.
- GitHub's current `main`, `origin/main`, and the reconciliation branch's initial `HEAD` were all `11fad55ecae7a153df51cc463290ecc2ad70175c` (2026-10-24, merge PR #61). The current `main` API response and `git ls-remote` agreed.
- The PART 01 source base is also `11fad55ecae7a153df51cc463290ecc2ad70175c`; therefore the recovered PART 01 worktree patch applies directly to current `main` with no textual rebase conflict.
- The supplied PART 01 commit `bb7a7d96ef9886485eda7edaaf2c878792f5a2a0` was not present in the checkout's Git object database; the GitHub commit endpoint returned `422 No commit found`. At the start of PART 02, the PART 01 code/test/OpenAPI/migration changes were present as a worktree diff on `11fad55`. They were committed as a new targeted commit rather than cherry-picked from an unavailable object.
- The clone was initially shallow. After unshallowing `main` and fetching the reported branch into `FETCH_HEAD` (without switching branches), local Git ancestry confirmed:

| Comparison | Merge base | Left-only commits | Right-only commits | Result |
|---|---|---:|---:|---|
| `0b72d7c5...` → `11fad55...` | `0b72d7c5bff5f978740f17191821c4b26351a25d` | 0 | 116 | Current `main` descends from the latest recorded successful deployment SHA. |
| `11fad55...` → `4ff46085...` | `11fad55ecae7a153df51cc463290ecc2ad70175c` | 0 | 98 | The reported SHA is 98 commits ahead of `main`, not merged into it. |

### Reported production SHA vs repository deployment evidence

- `4ff46085baddae487a52e6a7ee01d76ad819bfd9` is the tip of `arena/9b080bd1-handyman-backend`; it is not `main` and is not among the repository's GitHub deployment records.
- The latest GitHub deployment entry is `0b72d7c5bff5f978740f17191821c4b26351a25d`, environment `Handyman Project / production`, created 2026-10-18. Its statuses include `success` at 11:42Z and a later `inactive` at 14:37Z. The entry has `production_environment: false`. The earlier deployment entry is `b2e49ccb9a5278a8b1e3349ef90f3d5dfbb43461` and is also not active.
- Consequently, `0b72...` is the latest **recorded successful** deployment SHA, not evidence of the currently running production SHA. The deployment records do not establish which SHA is active now. `main` is historically descended from `0b72...`, but this is not proof that current `main` is deployed.
- **Reconciliation target selected:** verified current repository `main` at `11fad55...`, because it is the current default branch and descends from the last recorded successful deployment. This target selection is limited to code-lineage reconciliation; it does not certify the live runtime.

### Relevant conflict found on the `4ff...` branch

The reported branch is not used as the target because repository deployment metadata does not identify it as deployed. It nevertheless has concrete conflicts with a direct PART 01 port:

- Its `src/database/migrations/index.ts` already registers `0481_handyman_commercial_consent_bridge`; the registry continues through migration `0535`.
- It also contains `0484_handyman_care_structured_request_items.ts` and `0485_handyman_internal_notes.ts`.
- Its changes overlap PART 01 files including `docs/api/openapi.yaml`, `src/database/migrations/index.ts`, the Care tenant-request gateway service/validation, and the parameterized-catalog repository/types/item service.
- We did **not** merge or cherry-pick the 98 commits, did not copy the `0485` internal-notes feature, and did not renumber the migration based on an unverified branch. If `4ff...` is later confirmed as the active production target, this patch is **not directly portable as-is**: its `0481` identifier is occupied and its Care item API/registry need an explicit reconciliation. `0536` would only be a provisional next slot after checking the authoritative migration ledger.

## 2. Ported PART 01 changes and migration disposition

The implementation commit contains only the recovered PART 01 changes: Care create validation and transactional gateway integration; authorized structured detail readback; the existing parameterized item-engine extension for UOM/item description; its repository/types/routes/export updates; migration registration and migration; OpenAPI; and the two focused tests. No frontend, mobile, unrelated backend module, or `INTERNAL_ONLY` Care Note implementation was added.

On the selected `main=11fad55...` target:

- `src/database/migrations/index.ts` ends at `0480_handyman_service_request_item_inherited_attributes`.
- `0481_handyman_service_request_item_uom_description.ts` did not exist on that target and is the next valid migration ID there.
- The new migration adds nullable reported `uom_id` and `item_description` columns to the existing request-item table. It is registered immediately after 0480. No previously applied migration was edited.
- PART 01's existing-table/structured-item design is retained. UOM remains reported intake data with ACTIVE, server-derived Client validation; it does not override quotation UOM or pricing authority.

**Migration result:** `0481` is valid on selected current `main`; it conflicts only on the unverified `4ff...` branch described above. No production migration was executed.

## 3. Focused behavior verification

Command run against disposable embedded PostgreSQL, serially; these are five focused files, not the full suite:

```sh
NODE_ENV=test LOG_LEVEL=error ASENTRA_USE_EMBEDDED_POSTGRES=true \
  npx tsx --test --test-concurrency=1 \
  tests/cr-hm-be-care-catalog-structured-01-part01.test.ts \
  tests/cr-hm-be-care-catalog-structured-01-openapi.test.ts \
  tests/handyman-care-tenant-request-gateway-http.test.ts \
  tests/handyman-care-request-create.test.ts \
  tests/cr-hm-service-catalog-01-part03.test.ts
```

| Focused suite | Result | Evidence covered |
|---|---:|---|
| PART 01 structured Care E2E | 13/13 | Authorized mixed structured create and persisted GET readback; legacy single-service remains item-free; inspection-first; quantity precision/range; Client-scoped active UOM; variant applicability and attribute contradictions; inherited attribute provenance; cross-Tenant/Building isolation; idempotent replay and changed-payload conflict; failed-item rollback/no poisoned idempotency claim; existing item-engine path. |
| PART 01 OpenAPI | 2/2 | Exclusive legacy/structured create schema and persisted structured readback/item schema. |
| Care gateway regression | 9/9 | Legacy gateway contract, exact Building/Tenant authority, forbidden scope, permission enforcement, idempotency and existing staff behavior. |
| BM-exchange request-create regression | 10/10 | Existing exchange-token route remains unchanged; it still requires its own exchange authority and retains its original DTO/behavior. |
| Catalog PART 03 regression | 10/10 | Existing variant, attribute inheritance, price-resolution/inspection, quantity and quotation behavior. |
| **Combined** | **44/44** | **0 failed, 0 skipped.** |

Additional checks:

- `npx tsc --noEmit` — **PASS**.
- OpenAPI YAML parse — **PASS**; version remains 3.0.3 and the four relevant relative paths are present: Care Building create/detail and existing item POST/PATCH.
- Focused OpenAPI contract assertions — **2/2 PASS** (included above).
- `git diff --check` — **PASS**.
- No full test suite, deployment, live database migration, PR, or merge was run.

## 4. Security and scope conclusions

- Care create remains on the authenticated Care Staff session route with `handyman.care.building`, an ACTIVE assignment to the exact Building, server-derived Client/Tenant checks, and Backend authorization. Structured E2E verifies a Care actor from another Building and foreign Tenant are denied; the existing gateway regression covers permission and Building-scope denial. Authorized detail readback is Building-scoped and foreign Building staff receive 403.
- Structured authoring uses the existing item engine in the Care idempotency transaction. Failure does not leave a partial request/item set or a poisoned key; identical retries replay without duplicate items.
- `/api/v1/handyman/requests/care` remains the separate BM-exchange-token legacy contract. It was not modified; its 10/10 regression passed. No Care session is emulated as an exchange token.
- Preferred scheduling remains preference-only; BM permit/access authority and Operations-only quotation authority are unchanged. No `INTERNAL_ONLY` note contract or implementation was added.

## 5. Commits, branch, and remaining gate

- **Target base:** `11fad55ecae7a153df51cc463290ecc2ad70175c` (`main`).
- **PART 01 source reference:** `bb7a7d96ef9886485eda7edaaf2c878792f5a2a0` (not resolvable in this checkout/GitHub; see §1).
- **Reported SHA:** `4ff46085baddae487a52e6a7ee01d76ad819bfd9` (branch tip, not a GitHub deployment record).
- **Latest recorded successful deployment:** `0b72d7c5bff5f978740f17191821c4b26351a25d` (later marked inactive).
- **Reconciliation implementation commit:** `d512ecff1fc4404375b8f5f22bf3a6710c369fa4`, parent `11fad55ecae7a153df51cc463290ecc2ad70175c`.
- **Reconciliation branch:** `arena/2175aeac-handyman-backend` (session branch, rooted at current `main`).

**Final decision: BLOCKED for deployment-lineage certification only.** The implementation is committed and focused checks pass on the verified current `main` code baseline. A PASS for active production lineage requires authoritative confirmation of the currently running backend SHA/artifact. If it is `4ff...`, do a separate compatibility port against that lineage and its migration history; do not merge its 98 commits into this focused change or claim migration 0481 is valid there. No deploy or automatic merge was performed.
