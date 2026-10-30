# CR-HM-BE-IAM-E2E-AUDIT-01 — PART 03

## PIC Identity & Approval Authority Hardening

- **Date:** 2026-10-25 (Asia/Jakarta).
- **Repository / branch:** `budiirmawan/Handyman-Backend` / `arena/3a9f4872-handyman-backend`.
- **Verified starting HEAD:** `cc02a0b547dc9516afb9c765545476809400e51d`; local and origin matched, working tree was clean before PART 03.
- **Inputs:** [PART 01](CR-HM-BE-IAM-E2E-AUDIT-01-PART-01.md), especially P0-02 and the staged roadmap; [PART 02](CR-HM-BE-IAM-E2E-AUDIT-01-PART-02.md), including its grant-policy preservation and PART 03 handoff.
- **Outcome:** **DONE for bounded PART 03 under the explicitly approved identity policy.** Prospective P0-02 application-path remediation is verified locally. Existing/deployed bindings are not certified or repaired by this change. Production remains **NO-GO**.
- **Delivery:** this report belongs to the PART 03 commit; the final delivery records its exact SHA, pushed HEAD and clean-tree verification. No PR, deployment or PART 04 execution is authorized here.

## 1. Source finding and actual affected contracts

The baseline PIC update service accepted a changed `userId` after checking only that the User existed and could reach the Company Client. Generic `tenant_company.manage` plus Client reach therefore let Operations replace the User behind an already-designated PIC. The immutable request retained its PIC **id**, but quotation/variation authority read that PIC's mutable **User binding**. A correct exact-PIC decision predicate could consequently be satisfied after an unauthorized rebind. Initial linking had the same insufficient authorization boundary.

Care's canonical default does **not** include generic manage; this is not a claim that default Care could call the route. A separately delegated contact-management capability must not become customer identity authority either. PART 01's source/stub observations were not a production exploit or a full PostgreSQL rebind-to-approval proof.

Existing HTTP paths, controllers, body shapes and success payloads remain:

| Purpose | Existing path (under `/api/v1`) | Authenticated actor / outer guard |
| --- | --- | --- |
| Initial PIC/contact creation | `POST /tenant-companies/:tenantCompanyId/pics` | `req.auth.userId`, `tenant_company.manage`, Client access |
| PIC/contact maintenance | `PATCH /tenant-pics/:id` | Same; `tenantCompanyId` remains immutable |
| Quotation decision | `POST /handyman/quotation-versions/:quotationVersionId/decision` | Session actor, existing permission, exact Building, shared personal-PIC guard |
| Variation decision | `POST /handyman/execution-scopes/:executionScopeId/variations/:variationId/tenant-decision` | Session actor, existing permission, exact Building, same shared guard |

No caller-supplied actor, permission/role label, Client, Building, email, phone, primary flag or reporter identity establishes approving identity. The quotation and variation engines themselves were not rebuilt.

## 2. Explicitly approved authorization policy

The user selected identity-administrator-only initial/replacement links and rejection of targets already linked to another Tenant Company. “Identity administrator” means an ACTIVE existing actor with live **both** `tenant_company.manage` and `user.manage`, not a new role and not a blanket Owner-only gate. A current customer may unlink themselves, but cannot transfer their binding to a different account. New self-binding is denied even for an identity administrator.

### Authorization matrix

Every allowed operation retains existing authentication, route permission and Client scope. Identity operations additionally apply the scope/eligibility rules below.

| Actor / intent | Contact fields, omitted/currently unchanged `userId` | Initial/replacement non-null `userId` | Unlink own binding | Unlink another binding |
| --- | --- | --- | --- | --- |
| Scoped identity administrator with both live capabilities | Allowed | Allowed only for eligible **different** User | Allowed | Allowed |
| Scoped Operations with generic contact manage only | Allowed | **Denied**: self or another User | Only if already the actual linked customer; no staff fallback | **Denied** |
| Care default | Denied by existing route RBAC | Denied | Denied without existing manage/scope | Denied |
| Care with explicitly delegated contact manage, no `user.manage` | Allowed | **Denied**: self or another User | Only if already the actual linked customer; no staff fallback | **Denied** |
| Current linked customer with existing manage/scope, no identity-admin capability | Allowed | **Denied**, including transfer | Allowed, `userId: null` only | **Denied** |
| Anonymous / forged or unknown actor | Denied | Denied | Denied | Denied |

A newly supplied/replacement target must be an existing ACTIVE account; its Company must be ACTIVE. A target linked to **any different Tenant Company** is denied, including within the same Client/Building. Another PIC using the target within the same Company retains the existing duplicate-link conflict. Existing bindings and past decisions are never automatically reassigned or rewritten.

### Exact affected scope and relationships

1. Every request designating the existing PIC must agree with its Company and Client. Actor and replacement must have exact access to **all** those requests' Buildings; one sibling Building is insufficient.
2. For non-terminal requests with a Space, require currently effective ACTIVE occupancy of that exact Company + Building + Space. A relink cannot repair missing, revoked, future or expired occupancy. Unlink is revocation, so it does not require renewed occupancy; actor scope still applies.
3. Do not require a new lease simply to maintain historical contact identity: existing `CANCELLED`/`REFERRED` requests and a `CLOSED` execution scope exempt that request's historical occupancy from relink eligibility. Their referenced Buildings remain scoped. Decision/replay authority independently retains the current exact-space occupancy check; the exemption creates no customer decision right.
4. With no designated requests, reuse existing effective Company Building/space locations and require a shared exact actor/target Building. If no effective locations exist, preserve Client-scoped pre-occupancy contact provisioning. This does not grant Building assignments or request approval rights.
5. No independent per-User customer-membership/delegation registry is invented. The approved identity administrator is the trusted link-attestation authority; Building membership alone is not customer approval authority.

The policy deliberately does not deactivate all contact maintenance. Names/email/phone/title/primary/status remain existing contact operations. In particular, changing a contact email never changes the linked login User.

## 3. Implementation, serialization and audit

### One governed mutation transaction

The service owns create/update transactions. A Company `FOR NO KEY UPDATE` mutex preserves primary-contact serialization. Updates reload and lock the actual PIC `FOR UPDATE` **before** comparing `userId` and classifying contact versus identity intent. Authorization, writes, primary changes and identity audit share that transaction.

This fresh comparison matters: if an Operations form resubmits an old `userId` after an administrator relinks, that stale value is now an identity change and is denied. A genuinely contact-only form omitting `userId` still succeeds and retains the new binding. Frontends should omit `userId` unless intentionally changing identity; no optimistic-concurrency field was added.

Live identity permissions/accounts and existing context scope reads use the mutation connection. The existing authoritative scope resolver now accepts an optional executor, forwarded through its lookup chain. This mechanical propagation avoids nested shared-pool borrows while holding mutation locks; it changes no assignment predicates, parent activity policy or public API. A focused positive test reserves every pool slot except the mutation's one remaining connection.

### Relink versus approval

The shared quotation/variation guard continues to enforce request/Company/PIC/Building/exact-space authority, explicitly joins an ACTIVE account, and holds **`FOR SHARE OF tp, u`** in the caller's decision transaction until decision/history commit.

- **Relink first:** the old customer's locking authority read waits for the PIC update, rechecks the changed binding after commit, and returns `403 HANDYMAN_TENANT_DECISION_ACTOR_FORBIDDEN`. The authorized replacement can decide.
- **Approval first:** the relink waits for the guarded PIC. The original customer's decision commits with its original actor; a later legitimate relink cannot rewrite that fact.
- **Cross-Company target races:** a target account `FOR NO KEY UPDATE` lock serializes governed new bindings before foreign-Company eligibility is re-read, so two Companies cannot concurrently acquire that account through these services.
- Company/account **NO KEY UPDATE**, rather than UPDATE, remains compatible with decision/audit FK **KEY SHARE** locks. Both actual decision engines exercise approval-first completion without that FK lock inversion.

Current authority is checked before idempotent replay. An old User loses current authority after a relink. A current authorized replacement can receive an existing same-intent idempotent result, but it still identifies the **original** quotation/variation deciding User; replay is not fresh consent.

### Durable identity mutation evidence

`tenant_pic.identity_link_changed` is inserted via the existing operational-event implementation and transaction executor, with:

- server-authenticated actor and HTTP request correlation;
- Company/Client and PIC identity;
- `previousUserId`, `nextUserId`, `authority` (`IDENTITY_ADMIN` / `SELF_UNLINK`), `buildingIds`;
- exact single Building when singular, otherwise the scoped Building list in metadata;
- no copied contact name, email or phone.

An event-insert failure rolls back the binding **and** related primary/contact changes. Ordinary unchanged/omitted-identity edits do not emit an identity-grant event. Existing PIC verification audit behavior is retained. This does **not** fix PART 02's separate global grant-audit-after-commit limitation.

### No migration dependency

Existing PIC/account/Company/request/occupancy tables and locks suffice. Operational-event type/entity columns already accept these text values. Existing per-Company User uniqueness and immutable quotation/variation history constraints are retained. Cross-Company exclusion is enforced at governed application writes with the target-account mutex, not claimed as a newly added global DB constraint. No migration, seed, package/configuration or deployment change was necessary.

## 4. Exact change inventory — 18 files

| File | Purpose |
| --- | --- |
| `src/modules/tenant-pics/tenant-pic-identity.guard.ts` | New approved identity policy, live eligibility, exact affected scope/relationships, target-account serialization. |
| `src/modules/tenant-pics/tenant-pic.service.ts` | Transaction-owned classification/authorization/write and atomic identity event; contact/read/verification contracts preserved. |
| `src/modules/tenant-pics/tenant-pic.repository.ts` | Optional shared transaction, Company mutex and fresh locked PIC lookup; preserved primary behavior. |
| `src/modules/tenant-companies/tenant-company.repository.ts` | Optional transaction for existing Company lookup only. |
| `src/modules/handyman-tenant-decision-authority/handyman-tenant-decision-authority.ts` | ACTIVE account predicate and transaction-held PIC/account share locks for both engines. |
| `src/modules/context-access/context-access.service.ts` | Optional executor for the existing Client/Building scope queries used by PIC mutations. |
| `src/modules/building-assignments/building-assignment.service.ts` | Propagate executor through the unchanged authoritative Building-context resolver. |
| `src/modules/building-assignments/building-assignment.repository.ts` | Optional executor for active assignments lookup only. |
| `src/modules/buildings/building.repository.ts` | Optional executor for existing `findById` only. |
| `src/modules/properties/property.repository.ts` | Same lookup-only executor propagation. |
| `src/modules/clients/client.repository.ts` | Same lookup-only executor propagation. |
| `tests/tenant-pic-identity-authority.test.ts` | 26 new focused real-DB/session/HTTP policy, preservation, race, pool and rollback cases. |
| `tests/tenant-pics.test.ts` | Disposable full-schema DB; positive binding fixtures use a separate customer, not now-forbidden admin self-binding; nine existing cases retained. |
| `tests/handyman-quotation-decision.test.ts` | Disposable full-schema DB and fail-closed setup; 12 existing cases retained. |
| `tests/handyman-tenant-decision-authority.test.ts` | Existing six SQL-contract cases additionally pin ACTIVE account and share-lock predicates. |
| `docs/api/openapi.yaml` | Conditional identity policy, current decision authority/locking/history, existing error documentation; no structural request/response changes. |
| `docs/CR-HM-TENANT-ACTOR-01_AUTHORITY_AND_FRONTEND_HANDOFF.md` | Matching identity/contact/client handoff and preserved personal-consent boundary. |
| `docs/audits/CR-HM-BE-IAM-E2E-AUDIT-01-PART-03.md` | This bounded report, evidence and next-part recommendation. |

The six existing scope-resolver/lookup files contain only optional executor propagation (25 insertions / 15 deletions together), not a new scope policy. Existing PIC routes/controllers/validation/errors, quotation/variation engines, PART 02 permission/role/bootstrap source, migrations/defaults, Finance, BAST, dispatch and mobile implementations are untouched.

## 5. Focused verification — final run

**130 PASS / 0 FAIL / 0 SKIP / 0 CANCELLED**, 17 suites in **11 explicitly selected files**. These are fresh final-source results, not reuse of PART 01/02 historical counts. No full-suite glob ran.

| Lane | Result |
| --- | --- |
| New PIC identity-authority regression | **26 PASS** |
| Existing PIC CRUD / quotation decision / variation / shared guard | **9 + 12 + 3 + 6 = 30 PASS** |
| PART 02 grant authority / revoke / permission catalogue+resolver | **23 + 8 + 27 = 58 PASS** |
| OpenAPI / shared errors / mobile OpenAPI completeness | **16 PASS** |
| `npm run typecheck` (`tsc --noEmit`, source configuration) | **PASS** |
| OpenAPI baseline comparison | **PASS:** all 2,065 existing operation ids/verbs, security, parameters, request/response structures and route permissions preserved; all component schema structures unchanged after stripping descriptions |
| Scope / whitespace / default-source review | **PASS**; exact inventory above; no migration/default/PART 02 source changes |

Commands:

```bash
npm run typecheck
NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/tenant-pic-identity-authority.test.ts \
  tests/tenant-pics.test.ts \
  tests/handyman-quotation-decision.test.ts \
  tests/handyman-scope-variations.test.ts \
  tests/handyman-tenant-decision-authority.test.ts \
  tests/permission-grant-authority.test.ts \
  tests/permission-revocation.test.ts \
  tests/permissions.test.ts \
  tests/openapi-contract.test.ts \
  tests/error-contract.test.ts \
  tests/mobile-openapi-completeness.test.ts
```

### Required evidence mapping (new suite case numbers)

| Acceptance / preservation | Evidence and result |
| --- | --- |
| Authorized contact-only edit does not confer identity authority | **1, 22:** Operations, explicitly delegated Care and current customer can maintain contact; omitted concurrent edit retains the newly authorized User; original customer can still approve after ordinary edits. |
| Legitimate admin initial/replacement binding | **2, 8:** non-Owner scoped identity administrator succeeds; no new account created; atomic server-attributed event. |
| Operations / Care cannot self-rebind or initially appoint themselves | **3, 4:** both identity paths denied, followed by denied quotation decisions; default Care RBAC also pinned in **1**. |
| New admin self-binding / unauthorized assignment of someone else | **5, 6:** denied even with forged actor/roles/permissions in body. |
| Self-unlink remains; customer cannot transfer | **7:** own unlink succeeds, subsequent old approval/self-relink denied; transfer denied. |
| Cross-customer / foreign-linked target | **9:** same-Building foreign-Company target and another customer's binding mutation denied; foreign customer cannot approve. |
| Cross-Client / sibling Building / all affected Buildings | **10, 11:** actor and target negatives; multi-Building relink succeeds only after legitimate exact assignment is present. |
| Unknown, inactive and duplicate target behavior | **12:** existing 404/400/409 contracts retained where applicable; inactive target denied. |
| Existing relationships cannot be bypassed | **13:** revoked/expired occupancy blocks new binding and approval, but contact maintenance remains. |
| Historical lease expiry does not disable legitimate PIC upkeep | **14:** scoped replacement succeeds for pre-existing CLOSED history; original decision/scope rows preserved; expired-occupancy replay still denied. |
| Authenticated actor, not forged/unknown identity | **3, 4, 6, 15, 16:** real session actors used; anonymous/unknown service actor denied; quotation/variation actor-body claims cannot override. |
| Unauthorized variation decision; legitimate customer decision | **16:** Operations, delegated Care and unrelated replacement denied; current customer succeeds with original actor/event. |
| Original quotation/variation decision provenance preserved | **17, 19, 21:** valid PIC change and authorized replay retain original actors/events; real quotation mutation trigger rejects rewriting its decision. |
| Relink-first / approval-first, both engines | **18–21:** actual PostgreSQL blocking observed; old actor denied if relink wins; original actor retained if approval wins; replacement can decide/replay as applicable. |
| Stale unchanged-User form cannot undo a concurrent relink | **23:** fresh locked comparison denies Operations' stale `userId`; no extra binding event or reverted identity. |
| Cross-Company concurrent target acquisition | **24:** second request waits on target account, then denies foreign binding; second PIC and its original history remain intact. |
| No nested-pool dependency in identity transaction | **25:** authorized HTTP relink succeeds with all but one configured pool slot reserved. |
| Denied/audit-failed mutations leave bindings/decisions/history unchanged | Denial helper compares all PIC/version/decision/scope/variation/variation-event/operational-event rows; **26** adds real DB event failure and verifies binding, contact, primary and history rollback. |
| PART 02 delegated permission hardening preserved | Fresh **58 PASS**, including its 23 dedicated grant authority cases, revoke/last-authority protections and legitimate bounded delegation. |

Race barriers pause after a real mutation or after the real decision guard inside its open transaction. Waits are established using `pg_stat_activity` plus `pg_blocking_pids`, not assumed from a sleep or a synthetic SQL response. All four approval/relink schedules and the cross-Company/stale-contact waits completed.

Database evidence uses disposable loopback PostgreSQL 18.4 only: full current migrations for the new authority/PIC/quotation suites (ports 55584–55586), existing variation disposable fixture (55445), and PART 02 disposable fixtures (55580–55582). Setup fails rather than silently succeeding without the new DB lane. Sessions are real, including password-backed Operations/Care fixtures; managed variation evidence has actual stored bytes/checksum. The variation suite seeds an existing revised-quotation prestate, and case 14 seeds closed historical state: neither is a Finance/close/field workflow certification. All test clusters/evidence and the abandoned development fixture were stopped/removed.

Only the final completed run is counted. Development iterations corrected a pooled-query callback mock (replaced with a real DB failure trigger) and a historical fixture column mismatch. No pre-patch PostgreSQL exploit run was made. Intentional immutable-row/audit-failure errors and contract-only uninitialized-DB/503 probes are expected negative-test logs, not failing final assertions or production incidents. Raw run logs are workspace-only at `/home/user/.cache/hm-iam-e2e-audit/part03/` (`final-focused.log`, `typecheck.log`), not committed artifacts.

Canonical default sources still match the starting baseline:

- `src/modules/iam-bootstrap/iam-canonical-roles.ts`: `23eb4355bf0a836a70d59e6744aaf2fe824d253f47e45d76026ce7e497256422`.
- `src/database/seeds/foundation-access.seed.ts`: `d2c6ded53bc890d30b8e7ebd6eea94a4cb144d92c942db9780155219f37074d1`.

## 6. Preserved capabilities, remaining risks and release limits

- Contact CRUD, authorized identity changes, own unlink, verification, primary replacement/status behavior, ordinary current-customer quotation APPROVE/REJECT and variation decisions remain. Existing optimistic versioning/idempotency, request/location snapshots and immutable decision history remain; no contact-based approval or staff consent fallback was added.
- PART 02 remains bounded delegation, **not Owner-only permission administration**. Its grant/revoke/default/bootstrap code is unchanged and freshly regressed. The source/UI Owner-count drift from PART 01 is not a deployed-role census and is not declared resolved.
- **Legacy trust roots require operational review.** Previously tainted or cross-Company bindings and historic decisions are not inventoried, silently rebound or retroactively certified. Existing ACTIVE bindings still participate in current authority. Approved reconciliation with trustworthy customer identity evidence is required before rollout; do not fabricate old consent.
- Identity administrators are trusted to attest that an eligible account is the correct customer. Existing Building membership and account activity are not independent legal identity/customer-intent proof. No new membership/delegation/proof registry or signature mechanism was approved. Trusted SQL/bootstrap/import and direct in-process repository calls remain privileged seams; production identity writes must use the governed services. Current production source callsites do so.
- Race evidence covers governed PIC mutation, account eligibility, decision and stale-contact paths, not universal serialization of every IAM, Company, occupancy, parent-activity or lifecycle mutation, arbitrary SQL, or high-load behavior. Existing broader scope/parent-activity and other PART 01 findings are not silently solved by optional executor propagation.
- Global PART 02 grant audit is still post-commit. Atomic PIC identity audit does not close all high-risk IAM audit gaps (P1-04).
- PART 01 **P0-03 through P0-06**, other P1 gaps and **BA-08 through BA-11** release gates remain. In particular this is not customer BAST/signature verification, warranty/chargeable consent hardening, dispatch-clearance correction, Finance maker/checker independence, or BM/provider actor isolation.
- **Not run by design:** full suite, production access/mutations, staging/live-provider checks, Web/PWA/Android runtime acceptance, deployment or migration rehearsal. Selected tests have zero skips; this is local Backend evidence only. The direct tenant→Handyman payment / BM-fee model is untouched. Production stays **NO-GO**.

## 7. Precise PART 04 recommendation — not execution

> HANDYMAN-BACKEND — PART 04 ONLY — CR-HM-BE-IAM-E2E-AUDIT-01:
> customer consent/recording boundary (PART 01 P0-03, relevant customer handoff
> portion of P1-02). Continue only after separate explicit authorization.

1. Verify the delivered PART 03 SHA/clean state on this same branch and read all three reports. Preserve PART 02 grants and PART 03 identity/decision controls; do not open a PR before FINAL REVIEW.
2. Trace the existing BAST accept/reject/sign-off and customer warranty/rework/chargeable-decision routes and downstream consumers. Preserve their current QC/artifact/state/history engines rather than adding parallel ones.
3. Obtain explicit product authority for customer principal, intent/version-bound proof, staff-recorder versus customer-decision separation, and legacy facts. A linked PIC is not itself proof of signature intent, and nonempty text/digest is not a verified signature.
4. Deny staff/Operations/Care/Manager-only substitutes and forged proof; preserve legitimate customer consent and separately authorized recording under the approved policy. Never fabricate past signers or treat staff attestation as customer signature automatically.
5. Use focused disposable-DB/preservation tests, update the existing consumer handoff, report strictly necessary schema dependencies before proceeding, commit/push only the same branch, then stop again. Do not fix unrelated Finance/readiness/dispatch/mobile concerns incidentally.

**STOP after PART 03. PART 04 has not started. No PR or deployment performed.**
