# CR-HM-BE-IAM-E2E-AUDIT-01 — PART 01

## Deep source audit: IAM, role authority, isolation, and the 18-stage Handyman journey

**Audit date:** 2026-10-24 UTC
**Repository:** `budiirmawan/Handyman-Backend`
**Working branch:** `arena/3a9f4872-handyman-backend`
**Audited source HEAD:** `11fad55ecae7a153df51cc463290ecc2ad70175c`
**Scope:** PART 01, audit and documentation only. No implementation authorization is implied by the recommendations below.

> **PART 01: DONE. Production acceptance: BLOCKED / NO-GO.**
>
> The lifecycle engines and most important server-side prerequisites already exist. They must not be rebuilt. This audit identifies six source-confirmed P0 boundary concerns under the requested acceptance model, plus bounded integration/evidence gaps. Several concerns require an existing delegated or combined capability; they are **not** claims that every default role, every deployed account, or an unauthenticated caller can exploit the system.
>
> Fresh evidence: typecheck PASS; **138 repository checks PASS, 0 FAIL, 0 SKIP, across 14 explicitly selected files**; **7 additional no-database service probes** observed the stated current behavior. No actual PostgreSQL instance, migration, production account, deployment, or consumer application was used. The probes are not proof of end-to-end exploitation or proof that the security requirements pass.

## Contents

- [A. Baseline and evidence rules](#a-baseline-and-evidence-rules)
- [B. Role → Permission → Endpoint and IAM audit](#b-role--permission--endpoint-and-iam-audit)
- [C. Complete 18-stage lifecycle matrix](#c-complete-18-stage-lifecycle-matrix)
- [D. Findings and priorities](#d-findings-and-priorities)
- [E. Ordered remediation PARTs](#e-ordered-remediation-parts)
- [F. Focused validation and outstanding production checks](#f-focused-validation-and-outstanding-production-checks)
- [Appendix 1. Exact canonical permission sets](#appendix-1-exact-canonical-permission-sets)
- [Appendix 2. Source reference index](#appendix-2-source-reference-index)

# A. Baseline and evidence rules

## A.1 Repository and change baseline

| Check | Result / evidence |
|---|---|
| Branch | `arena/3a9f4872-handyman-backend`; no branch switch or rename. |
| Audited source commit | `11fad55ecae7a153df51cc463290ecc2ad70175c`, merge of PR #61. The eventual documentation commit is separate from this source baseline. |
| Initial worktree/index | `git status --short`, `git diff`, and `git diff --cached` were empty. No unfinished user changes were overwritten. |
| History availability | Checkout is shallow/grafted. A root-looking local `git show --stat HEAD` is not a meaningful PR delta; GitHub PR/commit metadata was inspected instead. |
| Current branch PR | None at baseline (`gh pr status` / `gh pr list`). No new PR is opened by this audit. |
| Latest merged work | [PR #61](https://github.com/budiirmawan/Handyman-Backend/pull/61), merged 2026-10-24T14:25:13Z, final remediation review Parts 01–09. Source approval did not authorize production deployment. |
| Recent commit metadata inspected | `e2156bf480e9` manual source certification; `de33600d2b2f` readiness evidence; `67487c838da6` crew-admission evidence; `6d6864bbdac2` lifecycle evidence; `9bdf6b1aefbe` price replacement/correction fix; `33bd79f6307f` migration-recovery safety. These are historical changes, not this audit's work. |
| Other relevant merged PRs | #60 catalogue, #59 arrival QR/geofence, #58 multi-Client notifications, #57 field integration/competency/assignment/helper/expense, #54 worker-profile compatibility. Current mounted source, not the PR title, determines capability. |
| Open financial proposal | [PR #47](https://github.com/budiirmawan/Handyman-Backend/pull/47) is OPEN and reported CONFLICTING: bank-receipt attestation, including an obsolete competing `0459` migration. It is not the existing payment-confirmation implementation. Do not merge it or recreate its proposal as a supposedly absent verification engine. |
| Permitted artifact | This Markdown report only. No application, schema, seed, lockfile, configuration, or repository test change. Temporary probe/log files were kept outside the repository in the excluded workspace cache. |
| Not performed | Full suite; database migration/seed; real database connection; Railway/Biznet/Coolify deployment; production mutation; consumer-repository change; PR creation/merge. |

Read-only local Git commands and `gh` PR/commit metadata supplied the baseline. No credentials were requested or copied. All source references below refer to the audited SHA; the reference index supplies immutable links.

## A.2 Existing work preserved, not repeated

Documents reviewed as context include the root `FINAL_BACKEND_GAP_AUDIT.md`, `E2E_CAPABILITY_MATRIX.md`, `BACKEND_REMAINING_WORK_ROADMAP.md`, and `BIZNET_COOLIFY_RELEASE_GATE.md`; IAM bootstrap, multi-persona, admin-handoff and permission-revocation reports; `docs/HANDYMAN_PRODUCT_BASELINE.md`, `docs/HANDYMAN_JOURNEY_LIFECYCLE.json`, `docs/data-isolation.md`, `docs/effective-context.md`; Handyman lifecycle/persona/Finance-authority reports; API/OpenAPI and relevant contract-freeze/cross-repository handoffs.

The latest accepted work closed **BA-01 through BA-07 and BA-23 at their documented local boundaries**. It retained **BA-08 through BA-11** for live consumer/staging, providers, persisted Client configuration, and paired backup/recovery. This report does not reopen those completed implementations or replace their IDs. Earlier **621 PASS / 0 FAIL / 0 SKIP across 58 files** is historical certification, **not** a fresh run on this branch.

Earlier reports described no proven P0 exploit at their evidence boundary. The findings here examine additional IAM/composed-authority paths and the stricter customer-consent, independent-Finance, and BM-versus-provider requirements of this CR. A historical staff-signature convention can be implemented correctly yet still fail this CR's customer-authority requirement. That distinction is explicit below.

## A.3 Frozen business model and evidence vocabulary

- **Handyman is an external service provider, not BM/FM.** BM coordinates location, permits, access and the customer relationship. Tenant money goes **directly to Handyman**. Handyman owes the contractual cooperation fee to BM.
- Quotation approval, physical arrival, crew execution, Supervisor QC, customer BAST acceptance, Finance payment confirmation, Manager close, settlement accounting and warranty are **different authorities**. A notification, screenshot, role label or client-supplied status cannot substitute for one.
- Platform `Client` isolation and represented `tenantCompany`/PIC isolation are different layers. An explicit Building assignment is not customer consent. A permission grants a capability, not an unbounded location or a customer identity.
- **IMPLEMENTED:** the inspected Backend route/service/domain control exists. This is not a deployed/live-E2E PASS.
- **PARTIAL:** the engine exists, but a named control or handoff does not meet the requested boundary.
- **MISSING:** a specifically named sub-control/transport is absent; do not apply it to an existing engine merely because no UI or permission label was observed.
- **UNVERIFIED:** no adequate runtime, persisted-state or production evidence was obtained. Production execution of **every** stage remains UNVERIFIED.
- **S:** current source/DDL inspected as text. **T:** an existing no-DB test was freshly executed. **P:** a temporary, repository/SQL-I/O-stubbed service probe was freshly executed. **H:** historical test/report only.
- SQL text and mocks do not validate PostgreSQL joins, triggers, transaction isolation or concurrency. Source-confirmed control absence is distinguished from an unexecuted database/HTTP exploit scenario.

# B. Role → Permission → Endpoint and IAM audit

## B.1 Actual role resolution and source counts

The Backend normally authenticates an **opaque bearer session, not a JWT**. Session tokens are randomly generated, stored as hashes, and resolved against live ACTIVE/non-expired sessions, an ACTIVE login-capable account, and an existing credential. Default source configuration is 32 token bytes and 480 minutes; deployed values were not read. Forced password change is checked live. See [S02].

`requirePermission` resolves a `DISTINCT` union through ACTIVE user-role assignments, roles, role-permission assignments and permissions on each protected request ([S03]). There is no frontend-persona deny overlay and no JWT-embedded role snapshot. A user with several roles has their **additive union**. There is no role-to-Building binding: those effective capabilities combine with all Buildings explicitly reachable by that account. Domain actors, such as current Lead and Supervisor, add further conditions.

| Role | UI observation supplied by user | Current source default | Actual Handyman authority / important exclusions |
|---|---:|---:|---|
| PLATFORM_ADMIN / Owner | 332 | **333** = foundation catalogue 365 minus 32 deliberate withholdings | Broad IAM/BM capability; **not** automatic Finance, QC, BAST-issuance, Settlement, Commercial or Care authority. Operational data still requires explicit Building assignment. Scope-administration has a specific Owner exception, not a global business-data bypass. |
| SYSTEM_ADMIN | 9 | **9** | Account/invitation administration; bounded Building-assignment administration; role/permission/audit reads. **No `role.manage`, `permission.manage` or Handyman execution/Finance permissions by default.** |
| CUSTOMER_CARE | 8 | **8** | Dedicated Building Care identity/discovery/intake/communication, **PENDING payment reporting + binary proof upload**, and ordinary scoped reads. No `tenant_company.manage` and no Finance verification/dispatch/customer-commercial decisions. Bounded Care gateways do not require generic manage. |
| MANAGER | 29 | **29** | Reporting, oversight, `finding.close` plus `handyman.finance.read` enable the existing final-close command. No Finance execution, QC, BAST issuance or dispatch by default. |
| OPERATIONS | 38 | **38** | `tenant_company.read/manage` opens many operational mutations. Dedicated Finance/QC/BAST-issuance/Settlement are excluded. However the generic manage gate also reaches customer BAST decisions and PIC administration: see P0-02/03/06. |
| MOBILE_STAFF | 18 | **18** | Field reads and auth-only commands **only when** current assignment/Lead/Inspector domain conditions hold. No generic manage, Finance, QC or BAST issuance. A role name alone never supplies a Lead binding. |

**The 332-versus-333 Owner difference is UNVERIFIED configuration drift, not a discovered production bug.** All source figures above were calculated by importing constants without running seeds or bootstrap. Bootstrap definitions, migrations, deployed grants, additional roles and revocations can differ. Do not auto-reconcile production to a UI count.

The complete non-Owner canonical sets and the exact Owner withholding set are in Appendix 1. [S04] is the authority; OpenAPI and historical persona tables are not permission resolvers.

## B.2 Endpoint matrix: six roles, real guards and scope

All paths below are under **`/api/v1`**. The table covers the IAM and Handyman journey being audited; it does not claim to review every unrelated BM/FM endpoint in the 365-entry foundation catalogue.

Legend: **Y** = the single canonical role reaches the permission layer; it still needs the indicated domain/scope/state checks. **D** = no role permission is required at that transport, but the domain actor is mandatory. **—** = that default role lacks the required permission. Owner is **P**, System Admin **S**, Care **C**, Manager **M**, Operations **O**, Mobile Staff **F**. Additional grants/multi-role union can change every cell.

| Endpoint / family | Real permission or transport boundary | P | S | C | M | O | F | Service scope / actor and audit observation |
|---|---|---|---|---|---|---|---|---|
| `/auth/me`, `/auth/me/buildings`, `/auth/password/status`, `POST /auth/password`, `/auth/logout` | Session; password-change allowlist during forced reset | Y | Y | Y | Y | Y | Y | Identity from `req.auth.userId`; own session/password, not a client-supplied actor. [S02] |
| `/users`, `/users/:id`; reset/deactivate/suspend/reactivate | `user.read` / `user.manage` | Y | Y | — | — | — | — | Installation-level user administration; protected Owner/last-Owner checks. Not a Client-filtered user directory. [S06] |
| `/invitations` create/list/read/revoke | `user.manage` | Y | Y | — | — | — | — | Global email/token lifecycle; token hash only persisted; accept does not grant roles or Buildings. [S07] |
| `/invitations/validate`, `/invitations/accept` | Invitation token, no user session | token | token | token | token | token | token | Public by design, not open registration. One-time, unexpired/non-revoked token controls admission. [S07] |
| `/roles`, `/users/:userId/roles`; `/permissions`, `/roles/:roleId/permissions` reads | `role.read` / `permission.read` | Y | Y | — | — | — | — | Global authority catalogue/assignment reads. [S03/S06] |
| Create roles; assign/remove user roles | `role.manage` | Y | — | — | — | — | — | No self-assignment; privileged-role mutations Owner-only; last Owner protected. Domain Finance/QC roles are not all classified as IAM-privileged merely by their names. [S06] |
| `POST /roles/:roleId/permissions` | `permission.manage` | Y | — | — | — | — | — | **Grant service lacks the privileged/self-escalation protections used by revoke.** Delegated holders are the relevant precondition. [S08], P0-01 |
| `DELETE /roles/:roleId/permissions/:permissionId` | `permission.manage` | Y | — | — | — | — | — | **Exists.** Transaction/advisory lock, protected grants, last authority grant, soft revocation, live next-request loss. [S08] |
| `POST/DELETE /users/:userId/buildings[/:buildingId]`; assignment reads | `building.manage` / `building.read` | Y | Y | — | — | — | — | Owner can administer assignment targets without gaining their data. Non-Owner administrator must reach the exact target Building; filtered assignment reads. [S05] |
| `GET /auth/audit-events` | `auth.audit.read` | Y | Y | — | — | — | — | Global IAM events; no per-Client filter. `recordEvent` is best effort, not transactionally durable. [S09] |
| `PATCH /tenant-pics/:id`; list/read PIC | `tenant_company.manage` / `.read` | Y | — | read | read | Y | read | Legacy master uses Client reach, not request-level customer delegation; `userId` is mutable. [S10], P0-02 |
| `GET /handyman/operations/queue` | `tenant_company.read` | Y | — | Y | Y | Y | Y | Dedicated discovery query filters assigned Buildings/Client. **No PIC membership required. This capability is implemented.** [S12] |
| Care Building authority/discovery/intake/communications and bounded payment reporting/proof | `handyman.care.building` + Backend session | — | — | Y | — | — | — | Exact Building, actual Care account; communications are neutral, while the dedicated payment gateway creates **PENDING** only and uploads proof. Neither verifies funds nor records customer commercial consent. Signed BM/Care handoff is separate. [S11] |
| `/handyman/requests`, lifecycle triage/inspection/diagnosis/referral/cancel, quotation create/revise/issue | `tenant_company.read/manage` | Y | — | read | read | Y | read | Exact resource Building on commands; request customer projection additionally uses C6 occupancy/representation SQL. Inspection requires current Inspector **when assignment records exist**. Coarse mutating actor gate: P0-06. [S13/S14] |
| `POST /handyman/quotation-versions/:id/decision` | `tenant_company.manage` **and exact request PIC** | Y* | — | — | — | Y* | — | `*` Permission alone never authorizes APPROVE/REJECT. Active request PIC/user/company/effective exact-space occupancy checked inside lock transaction, before replay. Mutable PIC trust root remains P0-02. [S15] |
| Visit proposals/confirmation; scheduling/permit/unit-access readiness | `tenant_company.manage` | Y | — | — | — | Y | — | Exact Building; proposals are not confirmed bookings. Confirmation needs a trusted tenant-slot consent, current version, eligible resource and capacity. [S16/S17] |
| Scope assignment/reassign; dispatch release/cancel | `tenant_company.manage` | Y | — | — | — | Y | — | AUTHORIZED scope, provider/crew/Lead competency, current assignment, conflicts and dispatch gates. Missing operator-domain boundary and permit/access consumption: P0-04/06. [S18/S19] |
| Assignment response, `/field/my-jobs`, arrival challenge/POST verification, work-session commands | Session + domain actor | D | D | D | D | D | D | Current authorized Inspector or Lead as applicable; exact Building/Client. No role-name bypass. Check-in's historical arrival lookup is P1-01. [S18/S20/S21] |
| Field material-line estimate/approve/issue/purchase/use/return/settle and evidence commands | Session + current Lead; operations-purchase paths add service capabilities | D | D | D | D | D | D | Same scope/quote line; quantity/state invariants; evidence byte/hash verification. A material quantity APPROVE is not tenant commercial consent or payment authority. [S22] |
| QC checklist publish/configure; QC open/items/evidence/finish and defect verification | Session; service checks `handyman.qc.configure` or `.manage` **and domain actor** | — | — | — | — | — | — | Withheld from all six defaults. Current effective Supervisor relation and non-executing-crew checks; current guarded PASS consumers. Explicit provisioning required, not a missing QC engine. [S23] |
| Field BAST prepare/issue/void | `handyman.bast.manage` + current Lead | — | — | — | — | — | — | Withheld by default. QC-bound lifecycle already exists. Do not grant all Mobile users BAST authority merely to make a button visible. [S24] |
| Customer BAST `/accept`, `/reject`, `/sign-off` | `tenant_company.manage` | Y | — | — | — | Y | — | Exact Building + state/QC; **not exact customer/PIC or verified customer signature authority**. Separate from worker BAST permission. P0-03. [S24] |
| Ledger/payment reads; `POST .../customer-payments` | `tenant_company.read/manage` | Y | — | read | read | Y | read | Generic path: PENDING report is not confirmed funds. Care has a **separate dedicated** `.../care/.../payments` + proof gateway under `handyman.care.building`; no missing reporting capability. [S11/S25] |
| Payment `/:paymentId/confirm` / `/reject`; ledger execution/entitlement derive | `handyman.finance.manage` | — | — | — | — | — | — | Dedicated Finance gate, scope and ledger/payment locks; **no reporter-versus-verifier identity exclusion**. Explicit Finance provisioning required. [S25/S26] |
| Tenant invoices create/lines/finalize/cancel; reads | `tenant_invoice.manage` / `.read` | Y | — | — | read | — | — | Handyman source lines bind Client/company/Building/space/currency/scope. This is not automatic financial-execution authority. [S27] |
| `POST .../final-close`; readiness/reconciliation | `finding.close` **AND** `handyman.finance.read`; reads `.finance.read` | — | — | — | Y | — | — | Both capabilities, exact Building and non-field actor; all current gates re-evaluated in locked transaction. **Implemented**, not a missing Manager endpoint. [S26] |
| Commercial agreements/BM fee rules/warranty start; settlement commands | `handyman.commercial.manage` / `handyman.settlement.manage` | — | — | — | — | — | — | Explicit domain grants, exact financial lineage and versioned agreement. Accounting facts are not fund transfers. [S28] |
| Warranty claims/customer authorization/chargeable accept/reject; field rework | Customer side `tenant_company.manage`; field side session + current Lead | Y / D | — / D | — / D | — / D | Y / D | — / D | Customer-side Building wall is not PIC consent; field verification is a separate warranty state machine, not permission to issue Supervisor QC. P0-03 includes these decision seams. [S29] |

**Missing permission at transport does not imply missing authorization:** the auth-only field/QC/material routes above were traced into services. Conversely, passing a generic route permission does not prove a Handyman operator or customer. Both observations are necessary to avoid false positives.

## B.3 IAM/account lifecycle, revocation and audit

| Concern | Current implementation and forbidden behavior | Limits / evidence |
|---|---|---|
| Login/session/JWT | `POST /auth/login` validates password/account and issues an opaque session; every protected call resolves current account/credential/session. Expired/revoked sessions and inactive/suspended accounts are rejected. No normal bearer-JWT role claim to refresh. Source login attempt limiting exists. | Browser storage, TLS/proxy/rate-limit deployment and real expiry/revocation behavior UNVERIFIED. [S02] |
| Request actor | HTTP controllers pass `req.auth.userId`; identity fields are ignored or explicitly rejected by their validators. Integration-signed claims are a separate trust root, not an invented local user session. | Upstream issuer registration, secret rotation and physical tenant identity proof remain live checks. [S11/S16] |
| Invitation/activation | `user.manage` create/list/read/revoke; token validate/accept public. Email-normalized create is advisory-lock serialized; accept locks/rechecks invitation and atomically creates ACTIVE user + hashed credential + ACCEPTED invitation. No role or Building automatically assigned. Revoked/expired/accepted token is not reusable. | Automated invitation email is **not wired**, even if another email provider is configured. Create returns a one-time token for controlled handoff; never claim “email sent.” Existing bounded contract, not missing invitation support. [S07] |
| Suspension/deactivation/reactivation | `POST /users/:id/{suspend,deactivate,reactivate}` under `user.manage`. Protected/last Owner controls; state change and session revocation for disabling flows use transaction authority. Reactivation does not restore a previously revoked session or grant a role/Building. | Global account administration, not Client-local user administration. Cross-operation races and real stale-token loss were not re-executed. [S06] |
| Password reset/change | Admin `POST /users/:id/password-reset` under `user.manage`, protected Owner guard, hashed temporary password, `mustChangePassword=true`, session revocation. Self `POST /auth/password` checks CURRENT password, clears forced-change and revokes other sessions. | Admin credential update/revocation and self update/other-session revocation are separate calls, not one atomic transaction. No fresh concurrent-reset test. Global non-Owner reset power is intentional current IAM authority, but must be approved before delegating to a tenant-local administrator. [S02/S06] |
| User-role assignment/removal | `POST /users/:userId/roles`, `DELETE /users/:userId/roles/:roleId`, `role.manage`. Serialized role mutations; no self-assignment; Owner/authority-defining role protection; last ACTIVE Owner protected. Assignment changes do not need token renewal. | Privileged predicate covers Owner and roles with IAM authority codes (`role.manage`, `permission.manage`, `user.manage`, `building.manage`); domain Finance/QC grants need their own deliberate provisioning policy. No canonical non-Owner role has `role.manage`. [S06] |
| Permission grant/removal | `POST /roles/:roleId/permissions`; **`DELETE /roles/:roleId/permissions/:permissionId` exists**. Delete serializes with advisory lock `724196035`, protects privileged revocation and last authority grant, soft-REVOKED assignment, 404 on repetition; active union is re-read next request. | Grant `assignPermissionToRole` has no matching privileged/self escalation guard and uses actor only in audit. P0-01; grant is not covered by the revoke transaction/lock merely because a nearby comment describes mutations. [S08] |
| Building assignment/removal | `POST /users/:userId/buildings`, `DELETE /users/:userId/buildings/:buildingId`. ACTIVE assignment + ACTIVE exact Building drives accessible set. Non-Owner admin limited to own exact Buildings; Owner exception applies to **scope administration**, not business reads. | `GET /auth/me/buildings` is own context, not a role selector that can widen access. No implicit sibling/Property/Client expansion. [S05] |
| Tenant/Property/Building isolation | Resource guard matches **both** authoritative `clientId` and exact `buildingId`. Request C6 projection additionally joins active location parents and represented tenant/occupancy; operation queue is a separate assigned-Building discovery path. | General Building resolver does **not** reject INACTIVE Property or Client; it filters assignment/Building only. Same-Building staff reads are not tenant-PIC consent. Policy and negative coverage are discussed in P1/P2, not asserted as a proven cross-Client leak. [S05/S12/S13] |
| Multi-role resolution | ACTIVE union, no persona override. Dedicated Supervisor/non-field/Lead/tenant actor gates remain applicable after the union. | Care+Finance can become both reporter and verifier; BM capability plus Handyman generic manage creates domain coupling. A selected UI persona is not a deny policy. P0-05/06. [S03/S23/S25/S26] |
| Revocation completeness | Permission, role, Building, invitation and session revocation all have real existing routes/services. Next permission-guarded request uses live grants. Account suspension and removing exact Building reach invalidate field authority too. | **Role/permission revocation alone is not complete field offboarding:** auth-only field commands depend on current assignment/Lead, not `MOBILE_STAFF` role membership. Remove domain authority/Building reach or disable account; do not invent a nonexistent “revoke Mobile permission” endpoint. [S03/S18/S21] |
| Audit durability/visibility | IAM mutations call `recordEvent`; public audit projection redacts sensitive metadata. Operational lifecycle commands frequently insert their own event records in the same transaction; Finance/BAST/QC/close have immutable domain events. | IAM `recordEvent` catches/logs insert errors and returns; mutation can succeed without durable IAM event. `/auth/audit-events` is installation-global. PIC `userId` PATCH has no dedicated decision-trust-root audit/authorization. No global-audit breach asserted for a role intentionally defined as installation admin. [S09/S10] |

## B.4 Preserved authority boundaries and uneven handoffs

1. **Ordinary Care cannot impersonate a customer through its canonical role.** `handyman.care.building` proves Authority A: actual staff identity + exact Building. Its response states customer commercial Authority B is blocked. `POST /handyman/care-decisions` is **not registered**; do not describe or implement it as an already supported endpoint. Neutral `QUOTATION_RESPONSE_RECEIVED`, `BAST_CONFIRMATION_RECEIVED` and `PAYMENT_COMMUNICATION` records do not mutate quotation/BAST/payment authority. **Separately, real Care payment-report/proof endpoints already exist** under `/handyman/care/buildings/:buildingId/requests/:requestId/payments` and `/:paymentId/proof`: the dedicated Care capability can create PENDING DP/TERMIN/PELUNASAN reports and verified-storage proof, never CONFIRMED funds or PAID status. Do not mistake the generic manage denial or neutral communication route for missing Care payment functionality.
2. **Ordinary Operations cannot mint QC PASS or confirm funds.** Those service/route capabilities are distinct. Operations nevertheless reaches the generic customer BAST and PIC-edit surfaces, which is the composed-authority concern here.
3. **Mobile assignment is real authority.** Current Lead resolution revalidates provider/crew/member/worker/user and Building/competency relations. A Helper is not implicitly a Lead. Inspector response/feed and an assigned Inspector's inspection write are not the same transport capability; the default Mobile role cannot pass the generic inspection POST manage gate.
4. **Manager close is real and guarded.** Permission conjunction is not a hardcoded role-name test. The command excludes an executing field actor on that scope, recomputes gate aggregates, and writes an immutable close event + CLOSED scope atomically. It does not create missing QC, BAST or payment facts. A falsely authorized upstream BAST sign-off can, however, satisfy its current BAST fact check.
5. **Exact Building isolation is preserved in the inspected command chains.** No universal permission-only/cross-Client business-data bypass was found. Master PIC administration is Client-scoped and can affect a request's decision trust root, even though the eventual decision still passes its exact-Building guard.
6. **Default roles alone do not staff the entire journey.** None of the six defaults has QC manage/configure, BAST issuance, Finance execution, Settlement or Commercial manage. Those are deliberately withheld, not missing services. A deployment needs explicitly approved, least-privilege domain actors; indiscriminately adding withheld codes to Operations/Manager/Owner is not remediation.

# C. Complete 18-stage lifecycle matrix

Stages below preserve the requested business order but describe the actual Backend dependency graph. In particular, an EXECUTION visit proposal already requires an ACTIVE scope crew assignment ([S16]); the safe concrete order is **quote APPROVE → scope → crew assignment → execution visit/tenant-slot confirmation → readiness/release → arrival/check-in**. This does not permit crew assignment before quotation approval. Agree the scheduling-screen handoff rather than bypassing this prerequisite.

**Evidence for all rows:** S unless T/P is explicitly identified. Database-backed test files listed in the detailed trace are **reviewed, NOT EXECUTED** in this PART. All 18 deployed journeys remain UNVERIFIED.

| # | Stage | Backend status | Actual actor/guard | Key supported capability / open handoff |
|---:|---|---|---|---|
| 01 | Intake and customer context | IMPLEMENTED | Signed BM/Care assertion or dedicated session Care authority; generic local path uses manage + authoritative attribution | Immutable request context and intake evidence exist; no fabricated Client/tenant/space. Live issuer/configuration BA-08/10. |
| 02 | Triage and onsite inspection | PARTIAL | Generic manage + exact Building; current assigned Inspector required when assignment history exists | Engines and actor restrictions exist; default Mobile Inspector cannot pass inspection POST manage gate (P1-02); operator-domain coupling P0-06. |
| 03 | Diagnosis and quotation preparation | IMPLEMENTED | Generic manage + exact Building; active discipline/catalog/commercial rules | Immutable diagnosis, versioned quote lines/totals and parameterized pricing exist. Operator-domain P0-06 is cross-cutting. |
| 04 | Issue/revise and customer approve/reject | PARTIAL | Generic manage + exact active request PIC, company and exact-space occupancy | Approval atomically mints scope; mutable PIC trust root P0-02; Care customer-commercial-proof transport remains deliberately blocked, not an admin override. |
| 05 | Schedule and tenant confirmation | IMPLEMENTED | Scoped operator proposal; integration-authenticated tenant slot choice; fail-closed operator confirmation | PROPOSED → TENANT_SELECTED → CONFIRMED, capacity/version/resource checks. Real issuer deployment UNVERIFIED. Crew assignment is an execution-visit prerequisite. |
| 06 | Permit/access/readiness clearance | PARTIAL | Scoped generic manage authoring; dispatch consumes readiness | Three readiness records/history are implemented; dispatch's permit/access booleans are hard-coded true (P0-04). |
| 07 | Post-approval crew assignment/reassignment | PARTIAL | AUTHORIZED scope + generic manage, exact Building; eligible provider/crew/Lead | Quote-before-crew and competency/history/supersession exist. Missing independent Handyman-operator authority under generic BM manage (P0-06). |
| 08 | Arrival QR/GPS and check-in | PARTIAL | Current Lead, exact Building; trusted challenge/evaluator; released dispatch | Genuine server-side QR/GPS evaluation exists. Check-in accepts any historical VERIFIED result for the scope instead of current actor/assignment (P1-01). |
| 09 | Start/pause/material-run/resume | IMPLEMENTED | Session + current Lead, exact Building and session identity | Server-clock state machine, idempotency and append-only events; no caller-owned timestamps. |
| 10 | Materials, evidence and progress/variations | IMPLEMENTED | Current Lead; bounded Operations/Manager actions; exact PIC for variation decision; QC/Finance gates downstream | Quantity/usage/history, genuine evidence bytes/hash and ADD/REDUCE workflow exist. Inherits PIC/operator concerns, not a missing material engine. |
| 11 | Completion and independent QC | IMPLEMENTED | Lead completion; dedicated QC permission + current non-executing Supervisor reporting line | Versioned checklist, actual evidence, completed sessions, defects and current guarded PASS. Explicit QC provisioning and live proof outstanding. |
| 12 | Defect correction and re-QC | IMPLEMENTED | Assigned Lead rectifies; Supervisor reinspection/current PASS | Failed/terminal runs preserved; new corrective session/evidence and re-QC gates protect BAST/final charge. |
| 13 | BAST and customer acceptance | PARTIAL | Worker: BAST permission + Lead + current QC; customer transport: generic manage + exact Building | Lifecycle/artifact/QC exist. Nonempty caller digest is not verified customer consent (P0-03). |
| 14 | Tenant invoice and reconciliation | IMPLEMENTED | `tenant_invoice.manage`, exact source line identity; Finance/reconciliation reads separate | HANDYMAN_CHARGE source binding, finalize and payment-state projection exist. DP/prebilling versus final-invoice timing must not be conflated. |
| 15 | Tenant direct payment and independent Finance verify | PARTIAL | Record PENDING: dedicated Care gateway or generic manage; confirm/reject: Finance manage + exact Building + locked payment/ledger | Dedicated Care report/proof and Finance confirmation are implemented. No maker/checker identity exclusion under union (P0-05); no missing Care-report engine. |
| 16 | Manager final close | IMPLEMENTED | `finding.close` AND Finance read; exact Building; non-field actor; all locked gates | Atomic close event + CLOSED status, no QC/BAST/payment shortcut. Upstream consent facts remain P0-03; post-close representation mismatch P1-03. |
| 17 | BM cooperation fee and settlement accounting | IMPLEMENTED | Commercial/Finance/Settlement dedicated grants, versioned Client agreement/beneficiary and ledger scope | Atomic provider/BM entitlement pair, funding/reconciliation/exception/forward-correction guards. Does not collect tenant money for BM or transfer funds. Persisted configuration BA-10. |
| 18 | Warranty/post-close claims, free rework and additional work | PARTIAL | Commercial warranty start; customer-side generic manage + Building; field current Lead | Separate warranty/rework/chargeable machines exist. Customer authorization/chargeable acceptance lack the exact PIC boundary used by quotes (P0-03). Post-close types/contracts P1-03. |

## C.01 Intake and customer context

- **Routes/controller:** `POST /handyman/requests`, `POST /handyman/requests/care`, intake-evidence GET/POST in `handyman-api.routes.ts`/controller; dedicated `POST /handyman/care/buildings/:buildingId/requests` in standalone Care discovery; signed handoff/workspace routers are mounted before these ([S01/S11/S13]).
- **Service/authority:** `handyman-service-request.service.ts` derives Client/company/PIC/Building/space/origin from existing immutable channel attribution; signed-Care intake and dedicated session-Care intake have their own authority. A generic bearer is not a substitute for an integration assertion. Service/catalog/variant must belong to the authoritative Client and be active.
- **State/forbidden transitions:** creation produces `INTAKE`, one request per attribution. Intake evidence is bounded to intake/request context; no FM conversion or caller-selected tenant/actor/status. No request creates an execution scope or crew assignment.
- **Scope/transaction/audit:** authoritative attribution/request lineage and C6 customer projections; local existing-attribution create is a single bounded INSERT with uniqueness, not a newly opened multi-write transaction. Signed-Care exchange and session-Care gateway supply an existing transaction for their attribution/request/party/idempotency/audit chain. Evidence uses managed storage plus persisted scope/metadata; a filesystem and PostgreSQL are not one distributed transaction. Uniqueness prevents duplicate requests.
- **Tests/handoff:** `handyman-service-requests.test.ts`, `handyman-request-evidence.test.ts`, Care admission/discovery and handoff suites (S/H, not rerun). OpenAPI/cross-repository contract checks T. Upstream active integration, Care-session issuer configuration and real per-Client catalogue data remain BA-08/10, not missing intake code.

## C.02 Triage and inspection

- **Routes/controller:** `/handyman/requests/:handymanRequestId/{triage,inspection}` POST/GET; `postHandymanTriageHandler` and `postHandymanInspectionHandler`, lifecycle API ([S14]). Inspector assignment/response uses the existing visit-inspector and inspector-assignment API, not execution crew assignment.
- **Service/actor:** `recordHandymanRequestTriage` and `recordHandymanInspection` require exact request Building; HTTP mutates under `tenant_company.manage`. Inspection service additionally enforces current assigned Inspector, declined/superseded/revoked histories when inspector assignments exist. The no-assignment legacy branch remains generic staff authority; do not describe inspection as unconditionally requiring an assignment.
- **State/forbidden transitions:** triage only from `INTAKE`; the persisted next status is the recorded disposition, `INSPECTION_REQUIRED` or `DIAGNOSIS` (no separate required TRIAGE command). Inspection only from `INSPECTION_REQUIRED`, projects `DIAGNOSIS`; duplicate/out-of-order records rejected.
- **Transaction/audit:** parent request row lock, immutable decision/inspection row, status projection and operational journal in one transaction; uniqueness handles races. Referral is a separate explicit exit. Cancellation is only pre-commitment and refuses once a scope exists.
- **Tests/handoff:** `handyman-request-triage.test.ts`, `handyman-request-inspection.test.ts`, `handyman-inspector-authority.test.ts`, assignment-response/Building-scope suites (reviewed). **P1-02:** assigned Mobile Inspector sees a legitimate task but lacks this POST's generic manage permission; granting all BM manage would introduce P0-06 rather than safely closing that handoff.

## C.03 Diagnosis and quotation preparation

- **Routes/controller:** lifecycle `/diagnosis`, quotation `POST /handyman/requests/:handymanRequestId/quotation`, version `/versions`, `/lines`, `/totals`; parameterized `/quotation/prepare` and `/quotation/revision` are also implemented catalogue consumers. Controllers are lifecycle/quotations API adapters plus `handyman-parameterized-catalog/handyman-parameterized-quotation.routes.ts` ([S14/S15/S30]).
- **Service/actor:** `handyman-request-diagnosis.service.ts` uses active discipline classification; optional recommendation must be active, same Client and associated with that discipline. Quotation create/revision/line services enforce request/thread Building and same-Client commercial/catalog lineage. HTTP generic operations gate, no role-name authority.
- **State/forbidden transitions:** diagnosis only from `DIAGNOSIS`, projects `READY_FOR_NEXT_STEP` for serviceable work or `REFERRED`; quotation eligibility consumes the serviceable request. Quote/version starts DRAFT, immutable line snapshots/totals; invalid catalogue/price/currency/variant and invalid request states are rejected. Revision creates a new version, not mutation of approved scope history.
- **Transaction/audit:** request/quotation/version locks as appropriate; diagnosis/projection/journal atomic; version/line decisions use their own transactional repositories and events. Pricing is server-resolved, not UI arithmetic.
- **Tests/handoff:** `handyman-request-diagnosis.test.ts`, `handyman-quotation.test.ts`, `handyman-quotation-line.test.ts`, parameterized quote/catalogue suites (reviewed). Do not duplicate PR #60 or the merged price replacement/correction fix. Persisted Client commercial/catalogue prerequisites are BA-10; P0-06 applies to the operator boundary, not the existence of pricing.

## C.04 Issue, revision, customer approve/reject and execution-scope creation

- **Routes/controller:** `POST /handyman/quotation-versions/:quotationVersionId/{issue,expire,supersede,decision}`; GET decision/execution-scope; request quotation `/presented`; quotations API controller ([S15]).
- **Service/actor:** quotation lifecycle services manage DRAFT/ISSUED/expired/superseded versions. `decideHandymanQuotation` takes the version lock, checks thread Building, then calls `assertHandymanTenantDecisionActor` **before idempotent replay**. It joins the request's designated PIC, PIC `userId`, active company/PIC and effective same-space occupancy. No Owner/Operations/Care role override and no current delegation record.
- **State/forbidden transitions:** only an unexpired ISSUED version can become APPROVED/REJECTED. Same key/fingerprint/decision replays; divergent second decision conflicts. APPROVE inserts one immutable decision + APPROVED projection + server-derived AUTHORIZED scope; REJECT creates no scope. No assignment before a scope and no scope before approval.
- **Transaction/audit:** version-lock transaction contains decision, projection, scope and operational journals. Location lineage fails closed; caller cannot choose target Client/Building/PIC/space.
- **Tests/handoff:** `handyman-quotation-decision.test.ts`, `handyman-execution-scope.test.ts`, quotation/Building scope and E2E reconciliation suites reviewed. **T:** six `handyman-tenant-decision-authority` cases use a mocked executor/SQL assertions, not real relational permutations. **P:** PIC update accepts an actor's own `userId`; the join reads that mutable link (P0-02). Care's commercial Authority B stays intentionally unavailable until an approved proof/authority contract exists; never fix this by making Care the customer.

## C.05 Scheduling and tenant confirmation

- **Routes/controller:** request `/visits` GET/POST, `/:appointmentId/cancel-proposal`; `POST /handyman/integrations/tenant-slot-choices`; `POST /handyman/requests/:handymanRequestId/visits/:appointmentId/confirm` ([S16]). These actual routes, not a generic scheduling status PATCH, implement the seam.
- **Service/actor:** `handyman-visit-api.service.ts` proposes only eligible Inspector/crew resources under exact request Building. EXECUTION admission requires AUTHORIZED scope with ACTIVE matching crew assignment. `handyman-tenant-slot-consent.service.ts` verifies bounded integration/purpose/signature/freshness/PIC context; confirmation requires configured authority, matching persisted consent, expected appointment version and current resource eligibility. A local operator cannot supply customer consent by changing a field.
- **State/forbidden transitions:** PROPOSED is not booked; valid consent binding yields TENANT_SELECTED; confirm yields CONFIRMED and an active capacity reservation. Absent authority disables confirmation; overlapping reservation, stale version, past slot and mismatched consent/resource/request reject. Proposal cancellation is bounded to current PROPOSED, not confirmed customer bookings.
- **Transaction/audit:** request/appointment/consent locks, unique/exclusion constraints, consent binding/reservation/journal atomic. A time window alone is not customer agreement or dispatch release.
- **Tests/handoff:** **T:** `handyman-appointment-core.test.ts` and `handyman-tenant-slot-assertion.test.ts` pure contracts, including fail-closed authority/HMAC/freshness/purpose. `handyman-tenant-slot-consent-db.test.ts`, booking-authority/readiness suites reviewed, not run. Active issuer/scope grant/secret and genuine upstream tenant selection remain UNVERIFIED; there is no justification for bypassing this configured gate.

## C.06 Permit, unit access and readiness

- **Routes/controller:** request `/scheduling-readiness`, `/permit-readiness`, `/unit-access-readiness` create/read/history; readiness-ID `/supersede` in readiness API ([S17]); dispatch `/readiness` is a separate consumer.
- **Service/actor:** `handyman-scheduling/handyman-scheduling.service.ts`, `handyman-scheduling/handyman-permit-readiness.service.ts`, `handyman-scheduling/handyman-unit-access.service.ts` derive request location/timezone, validate bounded windows/authorization fields, require scoped generic manage to author, and preserve ACTIVE/SUPERSEDED history. These records do not create an FM permit, crew assignment, arrival or session.
- **State/forbidden transitions:** one current ACTIVE record, bounded supersession, no caller-redirected Building/unit/worker/context; invalid/reversed windows and duplicate current records rejected.
- **Transaction/audit:** readiness mutation + operational journal atomic. Existing deterministic readiness-test repairs from BA-06 are preserved.
- **Missing consumer control:** `evaluateDispatchReadiness` queries permit/access rows, then sets **`permitClearance = true` (line 208)** and **`unitAccessClearance = true` (line 218)**. It neither consumes validity/coverage nor distinguishes a required-but-absent/expired clearance from not-applicable policy. The comment about optional permits does not implement a required-permit decision. **P:** absent rows + otherwise satisfied gates produce `ready: true`. P0-04 is a consumer-gate gap, not missing readiness CRUD.
- **Tests/handoff:** `handyman-scheduling-readiness.test.ts`, `handyman-permit-readiness.test.ts`, `handyman-unit-access-readiness.test.ts`, history/API and `handyman-dispatch-authority.test.ts` reviewed. Do not claim those authoring tests prove current clearance consumption.

## C.07 Crew assignment, acknowledgement and reassignment

- **Routes/controller:** `POST/GET /handyman/execution-scopes/:executionScopeId/assignment`, `/assignment/reassign`; `.../assignments/:assignmentId/respond` and `/response-history`; scope-assignment API/controller ([S18]).
- **Service/actor:** `assignHandymanExecutionScopeCrew`, reassign and current-Lead resolution enforce AUTHORIZED scope, exact Building/Client, ACTIVE provider/crew/current Lead, linked user/workforce placement and competency. Generic manage is the HTTP operator gate; the **target crew's eligibility is not the operator's provider-domain authority** (P0-06).
- **State/forbidden transitions:** one ACTIVE assignment, TERIMA/TIDAK_BISA response facts with bounded reason/key/version; decline prevents field mutation; late/superseded responses denied. Reassign requires expected current version, refuses active work sessions, preserves old assignment/response history and supersedes RELEASED dispatch. No approval/scope, inactive/foreign provider/crew, invalid Lead and stale assignment are forbidden.
- **Transaction/audit:** scope/assignment row locks, assignment + response/supersession/history/events in one mutation transaction; current resolution revalidates live worker eligibility rather than trusting caller-supplied Lead/user.
- **Tests/handoff:** execution-scope assignment/service/scope-guard, `handyman-worker-competency-*`, `handyman-assignment-response-part02a.test.ts`, `handyman-assignment-response-part02b.test.ts`, `handyman-assignment-response-part02c.test.ts`, dispatch-authority suites reviewed. Existing BA-05 fixture/admission fixes are not repeated. None of these facts grants a BM-only operator Handyman authority merely by role label.

## C.08 Arrival QR/GPS, dispatch and check-in

- **Routes/controller:** Building `/arrival-location-identifiers` and `/geofence-policy` configuration under `building_configuration.*`; scope `/arrival-challenge`, `/arrival-verification` POST/GET; `/dispatch/{readiness,release,cancel}`; `/work-sessions/check-in` ([S19/S20/S21]).
- **Service/actor:** server challenge issuance and terminal evaluator enforce current Lead, exact Client/Building/assignment, challenge identity/expiry, hashed QR registry and GPS/policy. QR text and coordinates are **signals**, never client verdicts. Configuration permission does not imply a field Lead. Arrival verification is not a work session.
- **State/forbidden transitions:** terminal arrival VERIFIED/FAILED/MANUAL_REVIEW_REQUIRED/EXPIRED; positive authoritative evidence required for VERIFIED. Check-in requires AUTHORIZED scope, current Lead, non-declined assignment and active RELEASED/IN_PROGRESS dispatch. Missing release or no VERIFIED result is rejected. Creates CHECKED_IN, not IN_PROGRESS.
- **Transaction/audit:** arrival result immutable/one per challenge; check-in atomically inserts session/event/helper snapshot and advances dispatch. However its scope/Lead/release/arrival preflight occurs before the session transaction; concurrent invalidation was not re-proven here.
- **Gap:** check-in `findVerifiedArrivalResultId` filters only scope + VERIFIED. Arrival rows already carry assignment/actor/challenge/time, but consumer does not bind them to current assignment/Lead/release (P1-01). Old assignment result can remain discoverable after reassignment; no real-database exploit was executed. Dispatch DDL **does** guard assignment and appointment scope/state, so no fabricated cross-scope appointment-ID exploit is claimed. However release accepts a caller appointment ID instead of the current crew appointment it evaluated, while that DDL does not match crew/window; same-scope old-crew appointment coherence is also a P1-01 test requirement.
- **Tests/handoff:** arrival challenge/configuration/evaluation/results/API, dispatch-authority and work-session-command/scope suites reviewed. Physical PWA/Android QR/GPS, low accuracy, expired/superseded challenge, and reassignment-with-old-result remain BA-08/live verification. Existing issuer/configuration endpoints are not missing.

## C.09 Work start, pause, material-run and resume

- **Routes/controller:** scope `/work-sessions/{start-work,pause,material-run,resume}`, active session and time projection; work-sessions API/controller ([S21]).
- **Service/actor:** `commandAuthorityPreamble` uses exact Building and current Lead, rejects declined assignment; session identity is server resolved. Auth-only transport is intentional domain authorization, not public mutation.
- **State/forbidden transitions:** CHECKED_IN → IN_PROGRESS on START_WORK; IN_PROGRESS → PAUSED or MATERIAL_RUN; PAUSED/MATERIAL_RUN → IN_PROGRESS on RESUME. Illegal transitions reject; same idempotency command replays rather than duplicating history. No field user can act as arbitrary staff/crew simply by passing a user ID.
- **Transaction/audit:** session lock + conditional state update + event in one transaction, server timestamps. Presence and actual-work clocks remain distinct; pause/material-run stop work time, not presence. Arrival/check-in is not automatic start-work.
- **Tests/handoff:** commands, lifecycle, workclock, read/close/checkin-start scope guards reviewed. **T:** available-actions contracts are advisory projection checks, not authorization of POST. Concurrent invalidation and stale-session authority remain focused staging checks. Preserve Web/PWA/Android route/time semantics.

## C.10 Materials, evidence, variations and progress

- **Routes/controller:** scope `/material-lines/{estimate,.../:lineId/approve,issue,purchase,use,return,settle}`; material-purchasing routes; scope evidence records/files/finalize and genuine field-evidence upload/download; field/Operations variation routes ([S22/S23/S31]).
- **Service/actor:** material execution uses current Lead, live Building authority via Lead resolver, same scope/approved quotation line, quantity bounds and decimal money contracts. Operations purchasing/manager decisions use their explicit service authority. Evidence verifies managed storage bytes/hash/MIME/size and exact scope; a submitted URL or fabricated DB row is not verified bytes. Variation review/authorization/tenant decision/QC/final-charge have distinct actor gates; tenant decision reuses exact request-PIC guard.
- **State/forbidden transitions:** estimate → approval/acquisition → usage/return → reconciliation/final-charge readiness are bounded; receipt/acquisition is not use and quantity approval is not new commercial consent. ADD/REDUCE follows proposal/review/revised quotation/customer decision/authorization/execution/QC/final-charge eligibility; reduction cannot exceed authorized base and rejected proposal is not chargeable.
- **Transaction/audit:** locked material/variation records, immutable events, keys/expectedVersion; no auto-invoice or automatic commercial decision from progress/evidence/notification. Source-bound money remains downstream Finance authority.
- **Tests/handoff:** material execution/acquisition/usage/purchasing, evidence commands/scope/binary storage, `handyman-scope-variations.test.ts`, helper/personnel/expense suites reviewed. Genuine files/persistent evidence, consumer uploads and multi-device progress are BA-08/11. PIC/operator boundary concerns are inherited, not a reason to discard working material/evidence APIs.

## C.11 Completion and independent Supervisor QC

- **Routes/controller:** work-session `/complete` and `/check-out`; Client QC checklist versions, scope checklist/QC runs; QC-run `/items`, `/evidence`, `/finish`; evidence-QC API/controller ([S21/S23]).
- **Service/actor:** Lead completes field session; QC checklist publication/configuration checks `handyman.qc.configure`; QC decisions require `handyman.qc.manage` **plus** effective reporting line through the current Lead worker's organization/Client to an ACTIVE Supervisor. The Lead and any executing crew member cannot become their own QC Supervisor merely by a unioned role.
- **State/forbidden transitions:** field IN_PROGRESS/PAUSED/MATERIAL_RUN → COMPLETED; CHECK_OUT from CHECKED_IN (aborted visit) or COMPLETED. QC OPEN → computed PASSED/FAILED with versioned required items, genuine bound evidence, completed sessions and defect conditions. Arbitrary outcome/status, empty checklist, stale evidence, foreign scope and executing-crew QC are denied. A no-work CHECK_OUT alone cannot satisfy required completed-session QC evidence.
- **Transaction/audit:** scope/crew/reporting-line/run locks; authoritative FINISH event records expectedVersion/template; immutable terminal run/history. `assertCurrentGuardedHandymanQcPass` rechecks checklist binding, guarded FINISH, all PASS items, defects, sessions and real storage bytes for BAST/variation/final-close consumers.
- **Tests/handoff:** `handyman-qc-supervisor-authority.test.ts`, QC/evidence/defect commands and scope guards reviewed, not rerun. Six default roles intentionally do not provision this actor. Existing engines cannot be called MISSING due to that withholding; live independent Supervisor provisioning remains required.

## C.12 Defect rectification and re-QC

- **Routes/controller:** `/handyman/defects/:defectId/{start-rectification,record-rectification,request-reinspection,pass-reinspection}`, scope defect/QC reads and new QC-run operations ([S23]).
- **Service/actor:** assigned Lead records corrective work/evidence; independent Supervisor verifies/reinspects. Staff possession of generic manage does not supply Supervisor relation or actual evidence.
- **State/forbidden transitions:** defects advance from OPEN through rectification/reinspection to VERIFIED under bounded actions; open/unverified defects prevent guarded PASS. Terminal failed QC is not rewritten into PASS; a new run preserves history, requires corrective completed work after failure and fresh verified evidence. BAST ISSUE/ACCEPT and final-charge gates consume the current PASS, not an old success.
- **Transaction/audit:** defect/run/scope locks and append-only events; shared guarded-PASS consumer resists stale-head reuse. No automatic BAST/acceptance/payment/warranty trigger from QC completion.
- **Tests/handoff:** `handyman-defect-commands.test.ts`, QC Supervisor authority and scope-variation evidence tests reviewed. Fresh actual rework/re-QC and storage-byte lifecycle remain staging evidence; no new rectification engine is proposed.

## C.13 BAST issuance and customer acceptance

- **Routes/controller:** field scope `/bast/prepare`; field BAST `/:bastId/{issue,void}` under `handyman.bast.manage` + Lead; customer `/handyman/bast/:bastId/{accept,reject,sign-off}` under generic manage; scoped read routes ([S24]).
- **Service/actor:** `prepareHandymanBast`, issue/void and sign-off services implement the lifecycle. PREPARE/ISSUE/ACCEPT consume current guarded QC; sign-off locks BAST and proves exact resource Building. Optional evidence, when supplied, must belong to scope. **It does not call the exact request-PIC/delegation/customer authority guard.**
- **State/forbidden transitions:** DRAFT → ISSUED; ISSUED → ACCEPTED/REJECTED; bounded VOID branch preserves history. ACCEPT requires `signatureDigest`, but validation is only trimmed nonempty and at most 512 characters. It is not signature verification, signer identity, verified customer intent or evidence ownership. REJECT is similarly a customer decision with staff Building authority.
- **Transaction/audit:** status + event + sign-off atomic; QC linkage and artifact acceptance read model implemented. A nonempty digest can become the downstream “customer ACCEPT sign-off” fact consumed by warranty/final-close.
- **Tests/handoff:** **T:** BAST lifecycle/acceptance/artifact/read contracts. Existing database `handyman-bast-signoff-scope-guard.test.ts:480` explicitly expects **exact-Building staff ACCEPT**; reviewed, not rerun. That is evidence of the historical staff-attestation convention, not proof of current customer identity. **P0-03:** retain QC/worker/artifact behavior, but decide and enforce the stricter customer consent/recording proof contract before claiming customer acceptance. PSrE/legal-signature selection is a separate existing question, not a prerequisite for the simpler actor-boundary finding.

## C.14 Invoice and reconciliation

- **Routes/controller:** `POST /tenant-companies/:tenantCompanyId/invoices`, `/tenant-invoices/:id/lines`, `/finalize`, `/cancel`; GET invoice/list; `GET /handyman/execution-scopes/:executionScopeId/invoice-reconciliation` ([S26/S27]).
- **Service/actor:** tenant invoice service requires `tenant_invoice.manage` at transport and exact invoice/source context; HANDYMAN_CHARGE references a real ledger charge and resolves same Client/company/Building/space/currency/scope. Reconciliation reads require Finance read and scoped access.
- **State/forbidden transitions:** draft lines can be composed then invoice FINALIZED; invalid/foreign source, mixed identity/currency, duplicate or invalid lifecycle rejected; cancellation/finalization are bounded. Invoice payment status derives from verified ledger allocations, not a client “paid” flag.
- **Transaction/audit:** service source/currency/eligibility prechecks precede repository transactions. Create/add-line/finalize/cancel repositories own transactions and append invoice history; finalize locks invoice, refreshes source amounts/totals and marks eligible variations invoiced. The additional `recordOperationalEvent` calls occur **after** the repository commit, not in that same transaction. Source links/history are preserved, but journal failure/revalidation races were not executed. Final-close independently requires full source-line coverage, exact reconciliation and PAID/zero balance.
- **Tests/handoff:** `handyman-p0-contract.test.ts`, tenant invoice and E2E financial reconciliation suites reviewed. **No general BAST gate was found in invoice finalize.** DP/TERMIN can intentionally predate BAST, so this is **not automatically a defect**. Confirm which invoice is the final-work invoice and its timing; do not destroy approved DP/prebilling contracts to enforce a simplistic stage list.

## C.15 Direct tenant payment and independent Finance verification

- **Routes/controller:** scope `/customer-payments` POST/GET; `/:paymentId/{confirm,reject}`; dedicated Care `POST /handyman/care/buildings/:buildingId/requests/:requestId/payments` and `.../payments/:paymentId/proof`; Finance payment-proof metadata/content reads; Finance-close API allocation/refund/reversal/adjustment ([S11/S25/S26]).
- **Service/actor:** generic report under `tenant_company.manage` creates PENDING. **Existing bounded Care reporting/proof** uses `handyman.care.building` + exact request Building; `reportBuildingCareRequestPayment` derives the request's scope, initializes a ledger container if necessary, and calls the same PENDING record service; `uploadBuildingCareRequestPaymentProof` binds genuine uploaded bytes to the scope/payment. It does not call Finance confirm or mark paid. Confirm/reject transport requires dedicated `handyman.finance.manage`; service resolves exact scope Building and locks authoritative transaction + bound payment, never trusts screenshot/provider status. [S11/S25]
- **State/forbidden transitions:** PENDING → CONFIRMED or REJECTED only; idempotent decision replay; no arbitrary re-decision/cross-transaction or cross-Client payment; rejection requires reason. CONFIRMED received funds are still not an allocated/fully paid invoice until ledger allocation/reconciliation.
- **Transaction/audit:** payment decision + append-only event atomic, ledger locks and immutable money/identity. Direct tenant→Handyman payment model is retained; no automatic gateway/settlement transfer inferred.
- **Missing independence:** `decide` never compares actor with `recordedByUserId`; additive roles can let the reporter confirm their own claim. **P:** actual service code accepted a PENDING row recorded by the same actor and produced CONFIRMED (repositories/transaction I/O stubbed). P0-05 is a maker/checker gap, not absent Finance RBAC or a missing confirm endpoint. The neutral communication intake is not a payment fact, but the **separate existing Care payment gateway is**. Do not grant generic manage or implement a replacement reporting engine.
- **Tests/handoff:** customer-payment/payment-scope, payment allocation/proof, `handyman-p0-contract.test.ts`, Care gateway/standalone HTTP source contracts, Finance-authority and E2E reconciliation suites reviewed. Confirm real recipient proof and independent approver credentials in staging; optional PR #47 bank attestation is neither implemented here nor silently required by this audit.

## C.16 Manager final close

- **Routes/controller:** `GET .../final-close/readiness`, `/invoice-reconciliation`; **`POST /handyman/execution-scopes/:executionScopeId/final-close`** → `postExecuteManagerFinalCloseHandler` → `executeHandymanManagerFinalClose` ([S26]).
- **Actor/guard:** `finding.close` **and** `handyman.finance.read`; exact Building; actor may not be executing field actor on the scope. Not an unrestricted Manager role-name shortcut.
- **Required state/gates:** AUTHORIZED scope, ACTIVE crew, completed work/no active sessions, settled material execution/purchases, reconciled charge-eligible/invoiced variations, **current guarded Supervisor QC PASS**, zero unverified defects, ACCEPTED latest QC-bound BAST plus ACCEPT sign-off, no PENDING payment, positive ledger charges, fully settled/allocated ledger with no unallocated overpayment, finalized fully covering PAID invoice, and no blocking disputed settlement exception. DP/partial payment alone cannot close. See service lines 573–914.
- **Transaction/audit:** scope + ledger locks; prerequisites recomputed; actor/reason/key-bound replay; immutable close event and `status='CLOSED'` in one transaction (lines 1025–1224). No automatic QC/BAST/payment creation or Manager bypass. Separate settlement/warranty lifecycles are retained.
- **Tests/handoff:** E2E financial reconciliation/close and Finance authority tests reviewed. Do **not** implement a second final-close endpoint. P0-03 concerns upstream signer's authority, not missing close aggregation. **P:** existing quotation-version scope read can return CLOSED; shared TS/OpenAPI AUTHORIZED-only declarations are stale (P1-03). Live Manager positive/negative close, including settled money and non-field exclusion, remains UNVERIFIED.

## C.17 BM cooperation fee, entitlements and settlement

- **Routes/controller:** Finance-close API commercial agreements/version activate/supersede, BM fee rule/term/beneficiary, pricing/config reads, scope `/financial-entitlements/derive`, `/settlement/{prepare,include,reconcile,settle,correction,dispute,dispute/resolution}` ([S28]).
- **Service/actor:** dedicated Commercial/Finance/Settlement permissions; financial entitlement service consumes authoritative ledger, single-provider/current assignment/session attribution and exact effective agreement version/Client beneficiary. DEFAULT LABOR_ONLY percentage terms required for authoritative derivation; missing/reference-only/unconfigured basis blocks **both** entitlement writes.
- **State/forbidden transitions:** atomic PROVIDER amount = charged net minus contractual BM fee, paired with BM_FEE fact; no provider-only “default full amount” on missing BM terms. Settlement unit inclusion/reconciliation must match earned pair/ledger/funding; open disputes/variance prevent settling; SETTLED terminal, later correction is forward-only, not history rewrite.
- **Transaction/audit:** ledger/unit locks, paired immutable facts/events, idempotency and exact binding; settled/reconciled state is an **accounting record**, not movement of funds. BM fee entitlement is not permission for BM to receive the tenant's service payment.
- **Tests/handoff:** entitlement foundation/derivation, settlement, financial-contract/reconciliation suites reviewed. Actual Client agreement/beneficiary/prices/catalogue are existing BA-10; bank/provider payouts and recoverability are UNVERIFIED. No new fee or settlement engine is recommended.

## C.18 Warranty and post-close

- **Routes/controller:** scope `/service-warranty/start` and warranty `/:id/expire` (Commercial); read/claims/submit/approve/reject/withdraw and rework `/authorize`/chargeable accept/reject (generic manage); auth-only field claim reworks/propose/start/complete/verify through Finance-close API ([S29]).
- **Service/actor:** warranty start derives eligibility/time from accepted BAST and service warranty contract; it is not an FM asset-warranty alias. Claims/evidence bind original Client/scope. Field proposal/start/complete/verify revalidate current Lead; customer AUTHORIZE and chargeable ACCEPT/REJECT deliberately use only Building access in their services, not the quote's exact-PIC guard.
- **State/forbidden transitions:** warranty `ACTIVE`/`EXPIRED` and claim `CLAIM_DRAFT`/`CLAIM_SUBMITTED`/`CLAIM_APPROVED`/`CLAIM_REJECTED`/`CLAIM_WITHDRAWN` are bounded. Free rework REWORK_DRAFT → REWORK_AUTHORIZED → REWORK_IN_PROGRESS → REWORK_COMPLETE → REWORK_VERIFIED; no chargeable state inserted into that machine. Additional chargeable work is a separated referral/decision/payment-trigger fact, not automatic free warranty conversion. QC, work completion and quotation approval do not automatically start warranty or authorize rework.
- **Transaction/audit:** warranty/claim/rework locks, immutable events and same-scope evidence checks. Optional QC reference in warranty verification must belong to scope and be PASSED; this is **not** the main independent Supervisor-QC adjudication surface. Do not assert the current Lead acquired `handyman.qc.manage` by verifying warranty rework.
- **Tests/handoff:** warranty/claim/rework/chargeable lifecycle and Lead/Building-scope guards reviewed. P0-03 includes customer rework/chargeable decisions that can authorize obligations with only generic staff authority. P1-03 concerns truthful post-close types/read contracts; actual post-close device/readback and commercial provisioning UNVERIFIED.

# D. Findings and priorities

## D.1 P0 release blockers under this CR's acceptance model

Severity describes the consequence if the stated prerequisites exist. **Source-confirmed is not “exploited in production.”** No default non-Owner has `permission.manage` or Finance manage; no unattended production proof is claimed.

| ID | Concern, exact evidence and prerequisite | Existing protection preserved | Required closure evidence |
|---|---|---|---|
| **P0-01** | **Delegated permission grant can redefine its own authority.** `permission.service.ts:81–130` validates role/permission activity/duplicate then inserts; actor is only audit. A delegated `permission.manage` holder can add `user.manage`, `role.manage`, `building.manage` or another withheld capability to a role already held; user-role self-assignment protection is not consulted. **S + P**: non-Owner grant accepted, zero Owner checks; matching privileged revoke was denied. | Normal defaults give that permission only to Owner. Revoke's Owner/last-authority guard, endpoint, soft revocation and immediate live resolver already work. | Owner-controlled privileged grant policy; no delegated self-escalation via existing own/other role; preserve legitimate ordinary grants. Test grant/revoke/concurrent role-classification and immediate stale-session effect on disposable authorized test DB later. |
| **P0-02** | **Mutable PIC link undermines exact customer decision authority.** `PATCH /tenant-pics/:id` uses generic manage; `tenant-pic.service.ts:102–131` allows changing `userId` after Client-reach checks only. Request retains the PIC ID, but decision SQL reads the PIC's current user link. Operations can rebind an existing designated PIC to itself, then meet the nominal exact-PIC predicate on an accessible request. **S + P** for accepted rebind; full PostgreSQL approval sequence not executed. No special consent/rebinding authorization or durable decision-trust-root event. | Exact quote/variation request-PIC, company, space and Building guards are correct and deny unrelated actors without the trust-root change. Care default lacks generic manage. | Govern PIC identity relink separately from ordinary contact edits; decide verified customer/Owner authority and effect on existing requests, prevent self/customer substitution, serialize with decision authorization as necessary, retain legitimate approved relinks + audit. Add real negative rebind→decision tests, not only mocked SQL rows. |
| **P0-03** | **Staff Building authority is accepted as customer commercial consent.** BAST accept/reject/sign-off route has generic manage; service `338–456` checks Building and current QC for ACCEPT but no exact customer/delegation proof. Signature validator only accepts nonempty ≤512 text; evidence optional. Existing DB test explicitly approves staff ACCEPT. Warranty rework AUTHORIZE and chargeable ACCEPT/REJECT also have Building-only customer authority. **S + T** for signature/lifecycle contract, not a new DB ACCEPT exploit. | Current QC, worker BAST issuance permission/Lead, state machine, exact Building, immutable events/artifact and Manager close aggregation all exist. This is a mismatch with a historical staff-attestation contract, not evidence the whole BAST feature is absent. | Product-approved customer principal or verified customer-intent proof/recording contract bound to exact request/document/action/version; distinguish staff recorder from customer decision maker; deny Operations/Care/Manager-only substitutes and forged digest. Reuse existing lifecycle/guarded QC; bind downstream warranty/close to proven consent, preserve old history without fabricating signers. |
| **P0-04** | **Dispatch readiness asserts clearances it never evaluates.** `handyman-dispatch.service.ts:196–218`: queried rows ignored; both booleans literal true; validity/window/required-vs-not-applicable policy unused. **S + P:** missing rows still report ready when other gates satisfied. A request with required but absent/expired clearance is not distinguishable from a legitimately exempt one at this gate. | Readiness authoring/history, confirmed appointment/current crew/conflict/material gates and transactionally released dispatch already exist. No blanket claim that every request needs a permit. | Explicit applicable/required policy and effective permit/access coverage of the execution window; block required absent/expired/revoked/superseded clearance; truthfully allow not-applicable. Consume current facts under release lock; preserve readiness CRUD and no-FM boundary. |
| **P0-05** | **Finance verifier need not be independent from reporter.** `/customer-payments/:paymentId/confirm` correctly requires Finance manage, but `decide:273–347` never compares `recordedByUserId` with actor. Multi-role/delegated reporter+Finance user can verify their own PENDING claim. **S + P** actual decision service accepted same actor with stubbed persistence. | Care-only/Operations-only cannot confirm by default. Dedicated Finance permission, scoped/locked payment decision, PENDING semantics and immutable money/events exist. | Transaction-bound maker/checker exclusion or approved equivalent independent verification policy; same-person multi-role cannot self-confirm; correct independent Finance can; replay/reject/cross-scope and allocation/invoice behavior preserved. Do not add a duplicate verification endpoint or silently merge PR #47. |
| **P0-06** | **BM generic administration is sufficient for Handyman operational mutations.** Triage/diagnosis/quote authoring/assignment/readiness/dispatch commonly need only `tenant_company.manage` + Building. A BM-only holder with no Handyman provider/operator relationship reaches them. Target crew eligibility does not establish the operator's Handyman authority. Source role comments explicitly acknowledge this coarse blast radius. **S**; deployed BM-only account exposure UNVERIFIED. | Exact Building, approval-created scope, provider/crew eligibility, customer quote guard, independent QC and dedicated Finance/Settlement remain. The finding is absence of a provider-domain actor check, **not merely absence of a permission named “handyman.operations.”** | Approve an explicit Handyman operational actor/capability + scope model, layered over existing domain/Building/state controls; distinguish BM coordination from provider operational control. Preserve legitimate Operations workflows, avoid granting generic manage to Care/Mobile, and test BM-only actors against each mutating family. |

### Composed-path examples, not production exploit claims

- A delegated permission administrator can edit a held role rather than assigning a new role to itself: the role-assignment self guard does not cover permission grants to existing roles (P0-01).
- A correct quote decision guard reads a contact identity an Operations caller can edit (P0-02). Immutability of the request's **PIC ID** does not make the PIC's **user binding** immutable.
- A correctly guarded Manager close can consume an accepted BAST whose signer's customer authority was never verified (P0-03). This is not a Manager endpoint bypass; it is an upstream fact-quality/authority problem.
- Care-only cannot verify payment; **Care/Operations plus explicitly granted Finance** can currently both report and confirm as one person (P0-05). A UI persona switch does not change the additive Backend identity.

## D.2 P1 integration and validation gaps

| ID | Classification / evidence | Action without duplicating existing work |
|---|---|---|
| **P1-01** | **Current-binding gaps at dispatch/arrival consumption (S).** Work-session lookup `114–124` accepts any VERIFIED scope result, with no current assignment/Lead/challenge/release/time constraint; preflight is outside session transaction. Reassign supersedes dispatch, not old arrival results. Separately, release line 301 accepts caller `appointmentId` over the appointment assessed for the current crew; DDL 0441 checks same scope/kind/state, not equality to that crew/window. Same-scope old-crew override and reassignment/concurrency reproduction remain UNVERIFIED. | Bind selected release appointment to the current crew/readiness window and consume current assignment/actor-bound arrival; reprove current facts at mutation. Test old versus fresh crew/arrival, same-scope different-crew appointment override, and racing supersession. Preserve legitimate not-applicable policies, QR evaluator, challenge/configuration APIs and cross-scope DDL protections. |
| **P1-02** | **Bounded Inspector/customer-consent handoff alignment (S).** Assigned MOBILE_STAFF Inspector can read/respond but cannot use manage-gated inspection POST. Commercial Care Authority B remains explicitly blocked, and integration Care registry is not automatically a local session/Building binding. **Care PENDING payment reporting and proof are already supported** by dedicated gateways and are not a gap. | Specify bounded Inspector write and verified customer-proof/decision handoffs before UI changes. Preserve correct Care/Finance denials, existing Care payment/proof, and neutral communications; do not grant `tenant_company.manage` to Care/Mobile or label a staff statement customer consent. Part of P0-03/06 remediation, not duplicate reporting or decision engines. |
| **P1-03** | **Post-close/supersession contract drift (S + P).** Final-close writes CLOSED; scope read service passes actual status through. `handyman-execution-scope.types.ts:13` and OpenAPI `HandymanExecutionScopeRecord` / `HandymanExecutionScopeCustomerProjection` still allow AUTHORIZED only (`95549`, `95575`). Dispatch DDL 0441 adds SUPERSEDED, while shared dispatch status constant excludes it. Finance-close-specific schemas do include CLOSED. | Additive, truthful lifecycle representations and response-schema tests for actual CLOSED/SUPERSEDED history, preserving existing fields/errors and denying new execution after close. Check worker-read eligibility separately; do not assume all field reads permit CLOSED. Existing static OpenAPI greens do not cover this state. |
| **P1-04** | **IAM audit durability and delegation scope need an explicit contract (S).** IAM event write swallows failure after business mutation. User/invitation/auth-audit surfaces are installation-global; domain permissions are not scoped per role/Building. A tenant-local “System Admin” UI label must not imply narrower authority than the actual global `user.manage` reset/lifecycle API. | Decide installation-admin versus delegated tenant-admin semantics before exposure; add transactional audit/outbox or approved fail-closed durable strategy for high-risk grants/relinks/resets, with retry/rollback evidence. Do not globally filter legitimate installation admin data without a product decision. |
| **Existing BA-08** | **UNVERIFIED** live cross-repository/staging behavior, real role/Building census, device/tenant negative journeys, persistence and approved deployment rehearsal. | Reuse the existing BA-08 acceptance artifact; this source audit cannot close it. |
| **Existing BA-09** | **UNVERIFIED** real notification/provider/device delivery and approved external-provider environment. | Use existing provider/security controls; no notification authority redesign or reimplementation of closed BA-01. |
| **Existing BA-10** | **UNVERIFIED** persisted Client service catalogue, prices, currencies, commercial agreements, BM fee terms and beneficiary. Source starter data/import capability is not production readback. | Read-only census first; separately authorize required configuration. Do not auto-seed/reconcile or add duplicate catalogue/fee engines. |
| **Existing BA-11** | **UNVERIFIED** automated backup/retention and executed paired database + evidence-file restore, RPO/RTO and native recovery. | Retain closed local recovery fix; approved isolated paired rehearsal with evidence is still required. Database-only local restore is insufficient. |

## D.3 P2 improvements / policy decisions, not invented missing engines

| Item | Source observation / bounded recommendation |
|---|---|
| Parent activity policy | General resolver accepts ACTIVE Building/assignment even when Property/Client is INACTIVE; P observed exact-Building true but foreign Client/Building false. Request C6 SQL is stricter. Decide whether parent lifecycle is an authorization kill switch and apply consistently if required; do not claim a documented global Client-suspension policy already exists. |
| Customer-versus-staff read contract | Request C6 representation is stricter than Building-wide quote/ledger/BAST staff reads; Operations queue intentionally does not require PIC. Preserve staff discovery. If direct/local customer sessions are supported, prove every customer read uses represented-company scope and cannot reuse staff read grants to inspect another company in the same Building. No such deployed customer login/cross-company read was tested here. |
| Final invoice versus DP/TERMIN and transaction boundaries | Generic invoice finalize does not consume BAST; DP/prebilling can be intentional. Define final-invoice designation/timing before adding a BAST prerequisite; close already requires correct finalized PAID coverage. Invoice history is transactional, but service source prechecks and extra operational journal are outside the repository commit; test post-commit failure/race behavior before promising atomic HTTP+journal semantics. Do not reject legitimate DP merely to fit a diagram. |
| Password/administrative defense in depth | Reset/update and session revocation are separate calls; exercise race/failure cases on authorized disposable environment. Consider step-up/MFA/session/device controls for high-risk installation authority. These were not requested implementations or proven login bypasses. |
| Role-count/config drift and documentation | Investigate Owner 332 observed versus source 333 with read-only effective grant data; retain default withholding. Fix stale persona rows that still say Manager final close is missing, but only when delivering their own contract update. Do not backfill this report's source counts into production. |
| Test precision | Mocked tenant-guard tests prove call/SQL/error behavior, not tenant/occupancy joins. Add relational and negative composed-path tests when DB work is separately authorized. Keep no-DB contract checks, but add actual response-state validation after close/reassign. Preserve separately registered historical structural-test debt rather than silently skipping or “repairing” it in this audit. |

# E. Ordered remediation PARTs

**Stop after this PART 01.** The following is an ordered proposal, not work performed. Backend owns authorization and domain truth; Operations, Care, PWA and Android should integrate only after the corresponding Backend contract is accepted. No new engine, blanket role expansion, historic migration rewrite, or second PR is implied.

| Proposed PART | Small scope / acceptance boundary | Dependency / exclusions |
|---|---|---|
| **PART 02 — privileged permission-grant safety** | Close **P0-01 only**: apply approved privileged grant protections to existing `POST /roles/:roleId/permissions`, serialize relevant classification/mutations consistently, add focused positive/negative/replay/concurrency evidence, update existing IAM handoff. | First Backend change. Preserve current grant/revoke URLs, `permission.manage`, legitimate ordinary delegation, last-Owner/last-authority protection and live effective union. No role reseed, default-role expansion, new UI, deploy or PR #47 work. DB tests need separately approved disposable execution. |
| **PART 03 — request PIC identity-link governance** | Close **P0-02**: distinguish contact editing from decision-authority relink; approve actor/proof/audit/current-request semantics; protect rebind→decision races and test self-rebind/cross-tenant negatives plus valid authorized relink. | Preserve existing exact-PIC quotation/variation guard and request/location snapshots. Do not solve by disabling all PIC maintenance or by making Care the customer. |
| **PART 04 — customer consent/recording boundary** | Close **P0-03** across existing BAST and customer warranty/chargeable decisions; approved customer/proof/recorder separation and downstream fact checks. Resolve the real customer handoff portion of **P1-02**. | Requires PART 03 trust root and explicit product authority decision. Keep current QC/BAST artifact/history/state machines and Finance/final-close facts. Do not activate blocked Care Authority B merely because RBAC works; do not retroactively fabricate signatures. |
| **PART 05 — Handyman operational actors and bounded staff handoffs** | Close **P0-06** and the Inspector-write portion of **P1-02** using an agreed provider-domain/coordination capability model and explicit Building reach. Preserve the already implemented Care PENDING/proof gateway; only validate its safe handoff. | Reuse existing assignment, pricing, readiness, inspection, purchasing and neutral Care APIs. Avoid blanket `tenant_company.manage` for Care/Mobile, and avoid duplicate lifecycle endpoints where an existing bounded service suffices. |
| **PART 06 — dispatch/arrival consumption integrity** | Close **P0-04** and **P1-01**: applicable/effective permit+access policy at release; current actor/assignment-bound arrival consumption and in-transaction reproof at check-in. | Preserve readiness CRUD/history, approved scope, tenant-confirmed visit, crew competency, QR/GPS evaluator, dispatch state/history and work clocks. Not a repeat of BA-05/06 fixture fixes or missing-QR-issuer work. |
| **PART 07 — independent Finance decision** | Close **P0-05** at existing confirmation service/transaction boundary; define independent actor policy and explicit Finance provisioning; prove maker/checker, scope, replay, allocation/invoice and Manager-close negatives. | Preserve PENDING reporter flow, real confirm/reject routes and direct tenant→Handyman model. No new payment engine, automatic bank attestation, settlement transfer or Manager bypass. |
| **PART 08 — lifecycle contract parity** | Close **P1-03**: additive CLOSED/SUPERSEDED shared types/OpenAPI/customer-history parity and focused real-response-state contract checks. | Preserve existing Web/PWA/Android payloads/routes; truthfully handle terminal/history states without granting post-close execution. Coordinate with current handoffs, not broad schema rewrite. |
| **PART 09 — IAM audit/delegation contract hardening** | Resolve **P1-04** with explicit global/delegated admin policy and durable high-risk mutation evidence; include remaining approved P2 parent/offboarding/reset policies only as separately bounded subparts. | Policy approval first; no silent loss of installation-administrator capability or audit event visibility. Keep current revocation/account/session contracts. |
| **PART 10 — Operations/Manager consumer validation** | Integrate accepted permission/actor contracts and existing queue/assignment/readiness/Finance/final-close endpoints; disabled actions reflect actual Backend denials; read-after-write and multi-role negative flows. | After Backend parts for each feature. Do not infer Backend capability from missing buttons or duplicate engines from historical UI gaps. Record under BA-08. |
| **PART 11 — Care consumer validation** | Preserve Authority A/intake, existing PENDING payment/proof and neutral communications, correct invitation handoff states and verified customer-proof/independent-Finance boundaries; no “approved/paid” from a staff statement alone. | Only after approved Backend consent contracts; reuse existing Care reporting/proof contracts. No impersonation or generic-manage grant to make UI pass. BA-08. |
| **PART 12 — field PWA and Android parity** | Current assigned jobs/Inspector write handoff, decline/reassign, fresh QR+GPS/check-in, clock/material/evidence, rework, terminal history/offboarding; same Backend verdict contract on both clients. | Only after Backend fixes. No localhost/browser-only authority or client-computed arrival/QC/payment status; physical-device evidence BA-08/09. |
| **Existing release workstreams, not a new engine PART** | Named release approval, live configuration census, provider proof, staging migration/status/recovery rehearsal and paired backup/evidence restore. | Reuse **BA-08 through BA-11**. Production deployment/migration remain NO-GO until explicitly approved and evidenced. |

### Exact recommended next instruction

**CR-HM-BE-IAM-E2E-AUDIT-01 — PART 02: harden privileged permission grants on the existing role-permission POST path.** Inspect current source again, enforce approved Owner/authority-defining grant protection and delegated self-escalation denial, preserve existing revoke and legitimate ordinary grants, use a consistent mutation boundary, add narrowly focused authority/concurrency tests and IAM/OpenAPI handoff parity as needed. Do not change role defaults, implement lifecycle/consent/Finance/clients, run production mutations, rewrite migrations, merge PR #47, deploy, or open a new PR. Real-database tests require explicit authorization for a disposable environment because current helpers run migrations.

# F. Focused validation and outstanding production checks

## F.1 Fresh execution on audited source

| Lane | Explicit scope | Fresh result / limitations |
|---|---|---|
| TypeScript | `npm run typecheck` (`tsc --noEmit`) | **PASS**. No emitted implementation/build files. |
| Lifecycle pure/unit contracts | Eight files listed below | **94 PASS / 0 FAIL / 0 SKIP**, 13 suites. Mocked/pure behavior only; no PostgreSQL. |
| IAM/OpenAPI/consumer contract surface | Six files listed below | **44 PASS / 0 FAIL / 0 SKIP**, 5 suites. No DB. The intentional uninitialized `/health/database` 503 in the OpenAPI suite is a passing negative check, not a real database outage observed. |
| Temporary service probes | Seven probes, outside repository; `pg.Pool` query/connect/end replaced before pool initialization, fake transaction executor; all repository data stubbed | **7 observations matched**: grant accepts non-Owner; corresponding revoke denies; PIC relink accepts self; self-recorded payment confirms; missing readiness rows still clear; inactive parent chain still grants exact Building while foreign Client/Building deny; CLOSED scope read passes through. These are current-behavior observations, **not seven security-remediation passes**. No socket/real DB/migration. |
| Final repository review | `git diff --check`; doc-only change inventory; source-link/test-path/role-set/18-stage checks | **PASS:** one Markdown deliverable only, 18 stage rows, 32 defined source IDs, all immutable source paths/ranges and named test paths resolved; canonical permission sets match source constants. No implementation files staged. |

Commands actually used for repository checks (explicit filenames, not the full-suite glob):

```bash
npm run typecheck

NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/handyman-tenant-decision-authority.test.ts \
  tests/handyman-tenant-slot-assertion.test.ts \
  tests/handyman-appointment-core.test.ts \
  tests/handyman-bast-lifecycle.test.ts \
  tests/handyman-bast-acceptance.test.ts \
  tests/handyman-bast-artifact-evidence.test.ts \
  tests/handyman-bast-read-contract.test.ts \
  tests/handyman-available-actions.test.ts

NODE_ENV=test LOG_LEVEL=error ./node_modules/.bin/tsx --test --test-concurrency=1 \
  tests/config-perm-01-permission-registry.test.ts \
  tests/handyman-contract-freeze-03-openapi.test.ts \
  tests/handyman-cross-repo-gap-contract.test.ts \
  tests/handyman-bast-worker-read-openapi.test.ts \
  tests/mobile-openapi-completeness.test.ts \
  tests/openapi-contract.test.ts
```

Read-only role-count evidence:

```bash
./node_modules/.bin/tsx -e "
import { FOUNDATION_PERMISSIONS, UNASSIGNED_BY_DEFAULT_PERMISSION_CODES }
  from './src/database/seeds/foundation-access.seed';
import { CANONICAL_ROLE_DEFINITIONS }
  from './src/modules/iam-bootstrap/iam-canonical-roles';
console.log('catalog', FOUNDATION_PERMISSIONS.length);
console.log('Owner', FOUNDATION_PERMISSIONS.filter(
  p => !UNASSIGNED_BY_DEFAULT_PERMISSION_CODES.has(p.code)).length);
console.log(CANONICAL_ROLE_DEFINITIONS.map(r => [r.code, r.permissions.length]));
"
```

Result: catalogue **365**, Owner **333**, SYSTEM_ADMIN **9**, CUSTOMER_CARE **8**, OPERATIONS **38**, MANAGER **29**, MOBILE_STAFF **18**. This imports definitions only; it does not run seed/bootstrap.

### Probe interpretation and reproducibility boundary

The temporary probes called the **real service functions** with fake repository rows and transaction I/O. No permission middleware, real database/trigger/join, genuine QC/evidence bytes, or HTTP exploit sequence was claimed. For later committed regression tests, retain these distinguishing inputs:

1. Active ordinary held role; actor not Owner; delegated `permission.manage` at route; active `user.manage` target permission; no existing grant. Grant currently succeeds. Counterexample: removing an existing privileged grant currently returns `PRIVILEGED_ROLE_ASSIGNMENT_DENIED` for non-Owner.
2. Existing active request PIC linked to another user; actor and replacement user have only same-Client reach. `updateTenantPic(picId, {userId: actorId}, actorId)` currently succeeds without customer/relink authority.
3. Bound PENDING payment with `recordedByUserId === actorId`; same-Client/scope/ledger; no prior decision key; route actor has Finance manage. Confirmation service currently sends the same actor to `decidePayment` and returns CONFIRMED.
4. AUTHORIZED scope/current eligible accepted crew, confirmed execution appointment, no overlap/open material blocker; empty permit/access result sets. `evaluateDispatchReadiness` currently returns both clearances true and ready.
5. ACTIVE user/assignment/Building; existing INACTIVE Property and Client. Exact resource guard currently returns true; different Client or Building returns false.
6. Existing scope repository row with `status='CLOSED'`. `getHandymanExecutionScopeByQuotationVersion` currently returns CLOSED while shared declarations exclude it.

The seven probe tests include the grant/revoke positive-control pair. They were not committed as new product tests in this audit-only PART. The scenarios above and immutable source references, not a cache path, are the durable handoff.

## F.2 Focused suites deliberately not executed

The following relevant suites/helpers initialize PostgreSQL and call `migrateUp` (including embedded/disposable variants), or otherwise require actual persisted integration fixtures. They were inspected for authority/test intent only: `iam-bootstrap`, `permission-revocation`, `rbac`, `sessions`, user/account lifecycle, quotation/decision/execution-scope, assignment/competency/dispatch, tenant-slot-consent DB, work-session scope/commands, readiness authoring/API, QC Supervisor/evidence/defect, BAST sign-off scope, customer payment/Finance authority, invoice/reconciliation/final-close, entitlement/settlement/warranty and their scope guards.

**No “skipped due to DB” count has been represented as PASS.** These suites were not invoked. Existing tests that explicitly allow staff BAST acceptance or only insert an arbitrary VERIFIED arrival are not sufficient to prove this CR's stronger customer/current-assignment boundaries, even if historically green. Add/adjust focused tests only in authorized implementation PARTs.

## F.3 Outstanding read-only census and authorized staging/production gates

First obtain approved **read-only** evidence, with no credentials or tokens in reports:

- Deployed SHA/migration **status**, unknown/pending history, effective configuration version; no automatic apply/seed or inference from merged PR.
- Actual ACTIVE user/role/permission assignments, the 332/333 discrepancy, noncanonical/delegated grants and multi-role unions; who has `permission.manage`, Finance, Commercial, Settlement, BAST/QC configure/manage and global account reset. Prove withheld defaults are not accidentally inherited.
- Exact user→Building→Property→Client assignments, inactive account/assignment/Building/parent policies, workforce/provider/member/current Lead and Supervisor/reporting-line eligibility. Approval and Finance permissions must not accidentally expand to every BM Building when only one provider context was intended.
- Invitation delivery configuration and safe one-time handoff; account activation/reset/forced-change/revocation semantics. Never report configured email as delivered without actual delivery evidence.
- Tenant PIC user bindings, provenance/verification and authorized change history; occupancy/effective dates; real customer identity/proof issuer, consent version and recorder versus decision-maker. Absence of a local PIC session/customer-proof producer must not be masked by staff approval.
- Actual Client catalogue/variants/prices/currency/agreements/BM fee version/beneficiary; source definitions/import tools are not persisted data (BA-10).

After separate authorization, run bounded scenarios on a **disposable approved staging environment**, never by mutating production as an audit side effect:

| Boundary | Required positive and negative evidence |
|---|---|
| Auth/revocation | Active/stale/expired/revoked token; suspended/inactive user; missing credential; forced reset; permission and role removal reflected next request; Building removal and assignment supersession deny field execution; unaffected user sessions/contracts preserved. |
| Privilege definition | Non-Owner delegated ordinary grant allowed per approved policy; privileged/self-escalating grant denied; protected role/Owner and last-authority protections; concurrent grant/revoke/classification; immutable, durable actor/event evidence. |
| Isolation | Two Clients, sibling Buildings, two tenant companies in one Building, unrelated PIC, missing/inactive/effective-expired occupancy and user with permissions but no Building. Test exact IDs and enumeration/read lists as well as mutations, and both single-role and combined-role accounts. |
| Customer consent | Care/Operations/Manager-only cannot decide; no userId/PIC/actor field smuggling; PIC relink cannot create customer authority; expired/superseded quote/consent rejects; exact authorized customer decision works; replay after authority removal denied; customer BAST cannot be manufactured by digest alone. |
| Assignment/schedule/clearance | Quote approval required before assignment; eligible/current crew only; tenant-confirmed matching visit; declined/superseded/late responses; concurrency/stale versions; required missing/expired/revoked permit/access blocks release, legitimate not-applicable works; supersession preserves history. |
| Physical arrival and execution | Both PWA and Android same raw QR/location input and Backend verdict; wrong Building QR, low accuracy, GPS outside/unavailable, expired/superseded challenge; reassigned Lead cannot reuse old arrival; no release/arrival, wrong Lead, Helper or revoked Building cannot check in/start; work clocks and retries remain server-authoritative. |
| QC/rework/evidence | Genuine upload/download/hash and persistent storage; checklist version bind; executing crew cannot QC even with extra permission; stale/failed QC, no corrective work and open defects block BAST/final charge; independent Supervisor can complete re-QC without rewriting failed history. |
| Payment/Manager close | Care can report only through approved bounded handoff; PENDING never paid; same-person multi-role verification denied; independent Finance confirm/reject works; cross-ledger, duplicate key, partial/DP-only, unallocated overpayment, missing invoice, QC, BAST, materials or disputed exception all block final close. Successful non-field Manager close produces exactly one immutable close event and CLOSED scope. |
| Post-close/fee/warranty | CLOSED/SUPERSEDED payloads schema-valid on permitted reads; no new execution on closed scope; contractual BM fee exact-version/Client beneficiary, missing term fails closed, settled history forward-only; warranty starts from proven BAST, free rework versus new chargeable obligation stays separate and customer-authorized. |
| Cross-repository and recovery | Actual Operations/Care/PWA/Android reports; real device/provider delivery (BA-08/09); paired database + managed evidence backup/restore and measured RPO/RTO (BA-11). Retain prior fixes and explicit production NO-GO until evidence/approval. |

### PART 01 exit

Only this report may change. Check doc paths/references, 18 rows, role-count provenance, `git diff --check`, and doc-only staged diff before an authorized same-branch documentation commit/push. Do not open a PR, deploy, run migrations, or begin PART 02 in this turn. Final response must distinguish **audit DONE** from **release BLOCKED**, give branch/current HEAD and audited source SHA, and point to the exact PART 02 scope above.

# Appendix 1. Exact canonical permission sets

These are source defaults, not deployed permission census. Codes not governing this IAM/Handyman journey remain BM/FM capabilities; listing them is not an endpoint-security audit of unrelated modules.

## PLATFORM_ADMIN

Exactly `FOUNDATION_PERMISSIONS` minus `UNASSIGNED_BY_DEFAULT_PERMISSION_CODES` in [S04]: **365 − 32 = 333**. The 32 withheld codes are:

```text
fx_rate.approve
handyman.bast.manage
handyman.care.building
handyman.commercial.manage
handyman.finance.manage
handyman.finance.read
handyman.qc.configure
handyman.qc.manage
handyman.settlement.manage
operational_budget.override
platform.audit.read
platform.billing.manage
platform.billing.read
platform.configuration.manage
platform.customer.manage
platform.customer.read
platform.health.read
platform.payment.read
platform.payment.reconcile
platform.pricebook.manage
platform.pricebook.read
platform.product.manage
platform.product.read
platform.provisioning.execute
platform.reporting.read
platform.subscription.manage
platform.subscription.read
platform.support.access
platform.usage.read
price_catalog.override
rfq.award
workforce_certification.verify
```

## SYSTEM_ADMIN — 9

```text
user.read, user.manage, role.read, permission.read, auth.audit.read,
building.read, building.manage, organization.read, workforce.read
```

## CUSTOMER_CARE — 8

```text
tenant_company.read, handyman.care.building, work_order.read,
work_request.read, finding.read, document.read,
service_request.read, service_request.manage
```

`service_request.manage` is the separate BM/FM service-request capability; it is **not** permission to triage or commercially decide the sibling Handyman request entity.

## MANAGER — 29

```text
management_read_model.read, report_archive.read, reporting_export.read,
report_export.generate, basic_financial_reporting.read,
work_order.read, work_request.read,
finding.read, finding.review, finding.close,
permit.read, permit.approve, document.read, document.approve,
vendor.read, asset.read, tenant_company.read, utility_meter.read,
inventory_stock.read, service_charge_readiness.read, tenant_invoice.read,
rfq.read, price_catalog.read, operational_budget.read,
workforce.read, workforce_kpi.read, handyman.finance.read,
service_request.read, engineering.read
```

## OPERATIONS — 38

```text
tenant_company.read, tenant_company.manage,
work_order.read, work_order.manage, work_request.read, work_request.manage,
finding.read, finding.manage, finding.assign, finding.execute,
schedule.read, schedule.manage, task.read, task.manage,
checklist.read, checklist.manage, vendor.read, vendor.manage,
asset.read, asset.manage, inventory_item.read, inventory_item.manage,
inventory_stock.read, inventory_stock.manage,
material_request.read, material_request.manage, permit.read, permit.manage,
document.read, document.manage, evidence.read, evidence.manage,
utility_meter.read, utility_meter.manage, workforce.read,
service_request.read, engineering.read, safety_field_report.read
```

## MOBILE_STAFF — 18

```text
tenant_company.read, attendance.read, attendance.manage,
form_instance.execute, task.read, checklist.read, work_order.read,
utility_meter.field.read, utility_meter.field.record,
utility_meter.field.evidence, material_request.field.read,
material_request.field.request, material_usage.field.record,
safety_field_report.create, safety_field_report.read,
security_logbook.read, security_logbook.manage, evidence.read
```

# Appendix 2. Source reference index

Paths/lines describe the audited SHA; inspect complete functions and mounted routers, not comments alone. Links below are immutable to avoid the documentation commit moving the source baseline.

| Ref | Primary source anchors |
|---|---|
| S01 | [Mounted routes, 865–916](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/routes/index.ts#L865-L916); IAM mounts in same file. |
| S02 | [Session token](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/auth/session.token.ts#L11-L16), [live session context](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/auth/session.service.ts#L64-L103), `auth.routes.ts`, `authentication.middleware.ts`, `auth.service.ts`, `credential.service.ts`, `login-rate-limit.ts`; `src/config/env.ts:110–120`. |
| S03 | [Live ACTIVE permission union](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/permissions/permission.repository.ts#L242-L258); `auth/rbac.middleware.ts`, permission resolver/routes/controller. |
| S04 | [Canonical roles](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/iam-bootstrap/iam-canonical-roles.ts#L40-L245), [withholdings/default seed](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/database/seeds/foundation-access.seed.ts#L834-L969), `owner-bootstrap.service.ts`. |
| S05 | [Exact Building + Client guard](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/context-access/context-access.service.ts#L86-L136), [assignment admin and resolver](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/building-assignments/building-assignment.service.ts#L43-L210), assignment routes/repository. |
| S06 | [Role mutation protection](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/roles/role.service.ts#L70-L232); `roles/role.routes.ts`, `users/user.routes.ts`, `users/user.service.ts`, `users/privileged-account.guard.ts`. |
| S07 | [Invitation service](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/invitations/invitation.service.ts#L57-L250), invitation routes/repository/token. |
| S08 | [Permission grant](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/permissions/permission.service.ts#L76-L130), [protected revoke](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/permissions/permission.service.ts#L133-L287), `permission.routes.ts:43–65`. |
| S09 | [Best-effort IAM audit](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/audit/audit.service.ts#L63-L79), audit routes/repository; compare transaction-bound domain events. |
| S10 | [PIC mutable user link](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/tenant-pics/tenant-pic.service.ts#L34-L131), `tenant-pic.routes.ts:33–38`, validation/types/repository. |
| S11 | [Care Authority A and blocked B](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-care-authority/handyman-care-authority.service.ts#L12-L94), Care-authority routes; `handyman-care-communications.routes.ts`, Care standalone discovery and its [payment gateway, 509–625](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-care-standalone-discovery/handyman-care-tenant-request-gateway.service.ts#L509-L625), payment/proof routes `385–468`; handoff/workspace/actor services. |
| S12 | [Operations discovery](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-operations-queue/handyman-operations-queue.service.ts#L1-L167), queue repository/routes. |
| S13 | [Request intake/read service](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-requests/handyman-service-request.service.ts), C6 `handyman-service-request.repository.ts:171–244`; `handyman-api.routes.ts`/controller. |
| S14 | [Lifecycle routes](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-lifecycle-api/handyman-lifecycle-api.routes.ts#L53-L114), lifecycle controller; request triage `113–203`, inspection `111–224`, diagnosis `104–194`, referral and cancellation services. |
| S15 | [Exact customer guard](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-tenant-decision-authority/handyman-tenant-decision-authority.ts#L17-L74), [decision/atomic scope](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-quotations/handyman-quotation-decision.service.ts#L156-L328), `handyman-quotations-api.routes.ts:50–106`, quotation access/lifecycle/create/revision/line services. |
| S16 | [Visit resource admission/proposal](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-appointment-contract/handyman-visit-api.service.ts#L30-L137), visit confirmation/tenant slot consent/authority/assertion/binding services and routes. |
| S17 | [Readiness routes](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-readiness-api/handyman-readiness-api.routes.ts); `handyman-scheduling/handyman-scheduling.service.ts`, `handyman-permit-readiness.service.ts`, `handyman-unit-access.service.ts` in the same module. |
| S18 | [Assignment eligibility/create/reassign](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-scope-assignments/handyman-scope-assignment.service.ts#L196-L620), current Lead resolver/response functions in same service; assignment API/controller/repository; field-feed service/routes. |
| S19 | [Dispatch readiness/release](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-dispatch/handyman-dispatch.service.ts#L49-L330), dispatch API; migration `0441_handyman_dispatch_release_reassignment_supersede.ts:32–58` guards assignment/appointment. |
| S20 | [Arrival HTTP authority](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-arrival-verification-api/handyman-arrival-verification-api.routes.ts), challenge issuer/evaluator/results/configuration services; migration `0400_create_handyman_arrival_verification_results.ts:39–121`. |
| S21 | [Arrival consumer/current Lead/check-in](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-work-sessions/handyman-work-session.service.ts#L109-L307), work clock/completion/read functions in same service; `handyman-work-sessions-api.routes.ts`, migration 0401. |
| S22 | [Material execution authority](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-material-execution/handyman-material-execution.service.ts#L81-L103), material-execution API, material-purchasing service/routes, managed field-evidence service/routes. |
| S23 | [QC Supervisor authority](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-evidence-qc/handyman-qc-authority.ts#L33-L118), [current guarded PASS](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-evidence-qc/handyman-qc-pass-gate.ts#L14-L156), evidence-QC service/API including checklist, defect and storage proof. |
| S24 | [BAST staff sign-off](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-bast/handyman-bast.service.ts#L338-L456), [digest validator](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-bast/handyman-bast.lifecycle.ts#L54-L68), BAST/worker routes and authority; staff acceptance test `tests/handyman-bast-signoff-scope-guard.test.ts:480`. |
| S25 | [Payment authority/decision](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-customer-payments/handyman-customer-payment.service.ts#L273-L379), authority preamble `128–147`; customer-ledger API `57–105`, payment-proof read; migration 0412 payment constraints. |
| S26 | [Final-close aggregate](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-finance-close-api/handyman-final-close.service.ts#L573-L914), final-close mutation `1025–1224`; finance-close routes `84–102`, `167–309`; migration 0458 CLOSED/close-event authority. |
| S27 | [Tenant invoice source authority](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/tenant-invoices/tenant-invoice.service.ts), invoice routes/controller/repository and HANDYMAN_CHARGE source resolution. |
| S28 | [Atomic provider/BM entitlements](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-financial-entitlements/handyman-financial-entitlement.service.ts#L104-L222), settlement service, commercial agreements/pricing/BM fee rules/services and dedicated finance-close routes. |
| S29 | [Warranty rework field/customer split](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-service-warranty-reworks/handyman-service-warranty-rework.service.ts#L121-L163), warranty/claim/rework lifecycle/services; chargeable additional-work authority `110–150`, decision `303–423`; service-warranty and finance-close API controllers/routes. |
| S30 | [Parameterized quotation](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-parameterized-catalog/handyman-parameterized-quotation.service.ts), service catalogue/parameterized catalogue/pricing modules and related tests. |
| S31 | [Variation authority/transactions](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-scope-variations/handyman-scope-variation.service.ts), scope-variation routes, material/evidence/progress/helper modules. |
| S32 | [Scope shared type](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/src/modules/handyman-quotations/handyman-execution-scope.types.ts#L12-L15), scope read service `157–177`, scope repository `118–126`; dispatch types and DDL 0441; [OpenAPI scope schemas](https://github.com/budiirmawan/Handyman-Backend/blob/11fad55ecae7a153df51cc463290ecc2ad70175c/docs/api/openapi.yaml#L95529-L95577). |

**Final boundary:** source audit and focused no-DB evidence only. No implementation, production readiness, deployment approval, real-bank verification, consumer E2E or migration completion is certified by this document.
