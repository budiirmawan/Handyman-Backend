# CR-HM-06 — AMENDMENT 01: TENANT PIC APPROVAL ACTOR & BOUNDED PIC SESSION

**Amendment to:** `CR-HM-06_DECISION_FREEZE.md` (F1–F12, frozen 2026-09-27, base `97a4c1b`) — **F6** (Customer approval), and the F8/F9 Execution Scope actor minimum.
**Referenced by:** `CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md` (frozen D4–D8), `CR-HM-CARE-WORKSPACE-01_PART01_AUTHORITY_CONTRACT_FREEZE.md` (§2 session admission, §7 routes/errors, §8 predicate separation), `docs/e2e/HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md` (§2, §4.3, §8, §9).
**Repository:** Handyman-Backend holds the design authority; the BM Super App side owns the attesting half (§12 BLK-1 and BLK-2).
**Type:** GOVERNANCE / DESIGN RECORD — **no runtime, migration, OpenAPI, or test change is made by this document.**
**Amendment id:** `CR-HM-06/A01` · **Version:** 1.1 (v1.0 → v1.1 ratification revision) · **Date:** 2026-10-10 · **Working HEAD:** `2db34f2` (`arena/44e8ce22-handyman-backend`).
**Status:** **AMENDMENT RATIFIED (contract level) at W03 PART 03A, 2026-10-10.** The revised freeze is recorded explicitly in `CR-HM-06_DECISION_FREEZE.md` (block "F6 — REVISED v1.1"); the original F6 text stays in that file verbatim and is superseded **in part**, never edited away.
**Ratification scope:** the amended F6 actor class, A1–A9, the session contract (§4–§5), the ledger design (§6–§7), maker-checker (§8) and compatibility (§9–§11) are **FROZEN as contract**.
**Ratification certifies nothing about code:** no implementation PART has started, and one **P0 release-sequencing decision remains open (BLK-GAP-1)**, reported in `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` §8.
**v1.1 delta (explicit):** rule **R-1** replaces v1.0's ledger coherence rule `tenant_pic_id IS NOT DISTINCT FROM decided_by_tenant_pic_id` (§6.1, §6.2); the maker set gains the binding granter (§8 MC0); BLK-1 is resolved by the ratified late-binding authority; BLK-5 is superseded by MC0. No other v1.0 text changes.

---

## 1. Verified baseline (pre-work gate)

| Check | Result |
|---|---|
| Repository | `Handyman-Backend` |
| Branch | `arena/44e8ce22-handyman-backend` — matches session branch |
| HEAD | `21a7b4737a27608bac66e27950422b4c9fdef3d8` — equals the expected HEAD `21a7b47` |
| Working tree | CLEAN before this document (`git status --porcelain` empty) |
| `main` ancestry | `git merge-base --is-ancestor origin/main HEAD` → TRUE (21 ahead / 0 behind at entry) |
| Frozen inputs read | `CR-HM-06_DECISION_FREEZE.md` (146 lines, F1–F12 verbatim), journey v1.3 (96 lines), `CR-HM-01_AMENDMENT_01_*` (349 lines), `CR-HM-CARE-WORKSPACE-01_PART01_*` (365 lines) |
| Ledger/migrations read | `0391`, `0394`, `0395`, `0396`, `0425`, `0426`, `0427`, `0429`, `0430`, `0431`, `0432`, `0375`, `0378`, `0145`, `0080`, `0002` |
| Addendum read | `CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` — the ratified late-binding authority v1.1 depends on; it is the normative source for the binding table, B0-B20, R-1 and MC0-MC5' |
| Runtime read | quotation decision service/repository/types, execution-scope service/repository, quotation access guard, quotations + lifecycle route tables, care workspace service/routes/scope/create-exchange, care actor registry + permission service, handoff context + care representation services, `migrate.ts`, `shared/errors.ts` |
| DB / OpenAPI / code executed | **NONE** — no PostgreSQL, no migration, no `src/` or `docs/api/` change |
| Full test suite | **NOT run** (per standing rule); no focused suite was needed because no code changed |

## 2. The conflict, stated exactly

**Frozen F6 says** (`CR-HM-06_DECISION_FREEZE.md` §F6):

> Actor = authenticated local user with required Client/RBAC authority; customer/request context is **server-derived**; caller-supplied customer identity is **never authority**.

**Journey v1.3 says** (§2 persona table, row "Tenant / PIC"):

> Menyetujui quotation. Menentukan jadwal. — Batas: **Tidak login langsung.**

and §4.3: "**Quotation** disetujui oleh **Tenant/PIC**."

The contradiction is not stylistic. A decision row in `handyman_quotation_decisions` **is** the customer's decision (its own migration header: "customer decision records", F6 `CUSTOMER_APPROVAL = EXPLICIT_VERSION_BOUND`). F6 requires that row's actor to be an authenticated local user; the journey forbids that person from holding a local login. Both cannot hold:

| Reading | Consequence | Verdict |
|---|---|---|
| Keep F6 literally | Every quotation decision must be recorded under a staff `users.id` → the tenant never decides; journey §2/§4.3 violated; PART 00 T-01 (any `tenant_company.manage` holder can approve) becomes the design, not a defect | REJECTED |
| Give PICs local users + `tenant_company.manage` | Customers obtain the staff commercial surface (create/price/issue/supersede), not just approval; and C6 (`customerRequestReadScope`) still rejects them without a building assignment (W03 PART 01 F-05: the whole predicate, PIC branch included, nests inside `EXISTS (user_building_assignments …)`) | REJECTED |
| **Amend F6: a second, attested actor class** | Approval authority moves to a bounded, BM-attested Tenant PIC principal; the staff administrative path is closed for decisions; no new customer privilege anywhere | **THIS AMENDMENT** |

**Structural facts this amendment must respect** (all verified at HEAD `21a7b47`):

1. `handyman_quotation_decisions.decided_by_user_id UUID NOT NULL REFERENCES users (id)` (`0394`) — a decision cannot exist without a local user.
2. `handyman_execution_scopes.created_by_user_id UUID NOT NULL REFERENCES users (id)` (`0395:47-48`) — **F9's minimum authority set itself demands a user id**, so widening only the ledger still cannot complete an approval. Both tables need the same treatment in one release.
3. `handyman_quotation_decisions.tenant_pic_id UUID REFERENCES tenant_pics (id)` is **nullable** and is copied from the request lineage; `handyman_service_requests.tenant_pic_id` is nullable (`0378:40`), unlike `tenant_service_requests.tenant_pic_id NOT NULL` (`0148:20`).
4. No customer-authenticated read surface exists today (`handyman-api.routes.ts:38-95`: every route except the care POST requires `authenticationMiddleware` + `tenant_company.read|manage`).
5. `tenant_pics.user_id` is an optional link (`0145`); there is no `users` row kind for customers (`0002:14-22` has only `status IN (ACTIVE,INACTIVE,SUSPENDED)`), and **no trigger on `tenant_pics`** exists (`grep "ON tenant_pics"` in `src/database/migrations/` → indexes only).
6. CR-HM-01 frozen **D4** states the care actor registry "intentionally stores NO local-user, Tenant PIC, tenant-company, session or RBAC linkage" and that the actor "is never a PIC". A Tenant PIC principal therefore **must not** be smuggled through `handyman_handoff_care_actors`; it needs its own principal resolution path (§6), while reusing the *credential machinery* (signature, replay store, session lifecycle).

## 3. Amended F6 (normative text)

> ### F6 (as amended by CR-HM-06/A01) — Customer approval
>
> The decision is **explicit** and bound to exactly **one ISSUED quotation version**. Decision vocabulary: **APPROVE | REJECT**. A revision request is represented through creation of a **new immutable quotation version** — never mutation of the decided version.
>
> **Actor = a Tenant PIC principal admitted through the bounded, BM-attested PIC session defined in §5–§6 of `CR-HM-06/A01`.** The actor is explicit, immutable and auditable: the decision row records the resolved `tenant_pic_id` **and** the admitting session id.
>
> Customer/request context is **server-derived**; caller-supplied customer identity is **never authority**. For a PIC principal this means: the PIC identity is **resolved server-side** from the signed handoff representation (`resolveHandoffContext` rules, unchanged) and never accepted from a request body, header, or token claim.
>
> **No local `users` row, `user_sessions` row, role, or RBAC grant is required or created for a Tenant PIC approver.** The absence of a `users` id on a PIC decision is a valid state and must never be fabricated around.
>
> `decided_by_user_id` remains **only** as historical read compatibility for pre-amendment rows. After ratification, **no new `USER`-class decision row may be created** on this ledger: a staff user approving a quotation is not a customer decision (see A3).
>
> Maker-checker is evaluated on **identity equivalence across namespaces**, not on `users.id` alone (A6). Execution Scope creation stays `APPROVAL_ONLY` (F8 unchanged) and becomes **PIC-approval-only** downstream (A5).

Everything else in F6 — explicitness, version binding, the APPROVE|REJECT vocabulary, "never mutate the decided version", "caller-supplied identity is never authority" — is **preserved verbatim in substance**. The amendment changes only *who may be the actor* and *how that identity is stored*.

### 3.1 New frozen tokens introduced by this amendment

| Token | Value |
|---|---|
| `APPROVAL_ACTOR_CLASSES` | `TENANT_PIC` (prospective) · `USER` (historical, read-only) |
| `PIC_APPROVAL_EXCLUSIVE` | NEW USER-CLASS DECISION ROWS FORBIDDEN |
| `PIC_SESSION_CREDENTIAL` | BOUNDED_ATTESTED_NO_LOCAL_USER |
| `MAKER_CHECKER_RULE` | IDENTITY_EQUIVALENCE_NO_BORROW |
| `EXECUTION_SCOPE_CREATION_ORIGIN` | VALID_TENANT_PIC_APPROVAL_ONLY |
| `C6_AND_STAFF_BUILDING_SCOPE` | NOT_EXTENDED |
| `LEDGER_CHANGE` | ADDITIVE_ONLY_NO_BACKFILL_UPDATE |

Pre-existing tokens (`QUOTATION_AUTHORITY`, `VERSION_MUTATION`, `CUSTOMER_APPROVAL`, `EXECUTION_SCOPE_CREATION`, `EXECUTION_SCOPE_PER_APPROVED_VERSION`, `CR_HM_12_PRICING_RULE_AUTHORITY`, `FM_WORK_ORDER_REUSE`, `BAST_ACCEPTANCE_SEPARATE`, `PAYMENT_SEPARATE`) are **unchanged**.

### 3.2 Decision register (FROZEN if this amendment is ratified)

| ID | Rule | Also forbids |
|---|---|---|
| **A1** | The PIC approver acts through a **bounded, attested, purpose-specific session** minted from the existing BM Super App secure handoff. No local login. | password/OTP flows, cookie sessions, "portal accounts" |
| **A2** | **No local `users` row, role, session, or RBAC grant** is created for or required of a Tenant PIC. | `is_customer_kind` columns, shadow users, seeding staff-like users per tenant |
| **A3** | The `handyman_quotation_decisions` ledger stays the single decision record (approved: **reuse, not a new ledger**). Actor class is **explicit** and immutable per row. | a parallel `pic_quotation_decisions` table, dual sources of truth |
| **A4** | Only a `TENANT_PIC`-class decision row may **create** a row in `handyman_execution_scopes`. | staff-origin execution authority |
| **A5** | Staff may **not** approve or reject a quotation through administrative permission. The staff decide route is dispositioned in §10.4. | `tenant_company.manage` as approval authority |
| **A6** | Maker-checker compares **identity sets across namespaces** (PIC → its optional linked user, vs. stored creator users), enforced in DB where representable. | "different user id, same human" self-approval |
| **A7** | `customerRequestReadScope` (C6) and the BE-02G staff building guard are **not extended, not bypassed, not parameterized** for PIC traffic. PIC authority is a separate, non-staff predicate. | granting customers staff read walls |
| **A8** | Every ledger/persistence change is **additive with no UPDATE backfill**; historical rows stay valid and are never reinterpreted. | retroactive attribution, in-place actor rewriting |
| **A9** | The amendment is **prospective**: historical `USER`-class approvals (and the Execution Scopes they created) remain valid facts. | retroactive invalidation of live work |

## 4. Trust boundary — BM Super App → Handyman PIC session

**Trusted input:** exactly one thing — an HMAC signature over a canonical assertion, made with the per-integration secret that BM holds server-side (`HANDYMAN_HANDOFF_SECRET_<CODE>`, `readHandoffRuntimeConfig`). **Nothing else crosses the boundary as identity.**

**Handyman derives, never accepts:** tenant, PIC, building, space, occupancy validity, quotation, version, decision actor, idempotency identity. `resolveHandoffContext` (`handoff-context.service.ts:88-106`) already enforces company ACTIVE, building ACTIVE + client-matched, ACTIVE effective tenant-building context, **`requester.tenantCompanyId === company.id` and `requester.status === 'ACTIVE'`** for the PIC, and resolves the optional linked user **without creating a session** (`:99-105`, comment at `:89`: "no session created"). This amendment reuses that resolution **unchanged**; it adds no parallel occupancy master.

| # | Threat | Control | Precedent already in this repo |
|---|---|---|---|
| T1 | Caller claims to be a PIC in the request body | The session carries the server-resolved `tenant_pic_id`; the decision endpoint accepts **no** identity field (whitelist parse, unknown keys rejected) | `care-create-exchange.service.ts:26-31` exact body-key whitelist |
| T2 | Forged assertion | HMAC over `stableJson` canonical payload with the per-integration secret, `timingSafeEqual`, fail-closed 401 | `care-workspace.service.ts:86-89` |
| T3 | Stolen bearer token reused | hash-only storage, absolute expiry, per-call revocation check, `Cache-Control: no-store`; token never logged/echoed | `0429` guard + `care-workspace.service.ts:118-139` |
| T4 | Assertion replay mints a second session | `UNIQUE (integration_id, assertion_id)` tombstone → 23505 collapses into the uniform 401 | `0429`, `care-workspace.service.ts:143-147` |
| T5 | PIC revoked / tenant suspended mid-session | AFTER UPDATE trigger on `tenant_pics` (+ `tenant_companies`) revoking live sessions, **plus** per-call re-resolution; never rely on the trigger alone | `handyman_care_workspace_invalidate_actor` (`0429`) |
| T6 | Staff principal borrows a PIC session (or vice versa) | separate credential store, separate principal type, separate router, **no fallback between token kinds**; admission re-checks actor kind against the resolved PIC | CR-HM-CARE-WORKSPACE-01 §2 ("Identical header syntax does not make it a local User bearer token") |
| T7 | Cross-tenant: PIC of tenant A decides tenant B's quotation | v1.1: binding coherence R-1.1 (`decided_by_tenant_pic_id` = the ACTIVE binding's PIC, resolved in the ledger guard) **and** the binding's own B2 (`pic.tenant_company_id = request.tenant_company_id`); plus session `tenant_company_id` asserted equal to the request's | ADD-A §3.2/§5, §6.2 (mirrors `0427` no-borrow trigger) |
| T8 | Mixed-version fleet silently downgrades a PIC assertion to a legacy staff handoff | PIC traffic uses a **dedicated integration code** that exists only once PIC-capable release + provisioning landed; a legacy node has no such integration → 401 | `CR-HM-01_AMENDMENT_01` §3.6 |
| T9 | Infra/DB error treated as "not authorized" **or** as "authorized" | errors propagate; only explicit rejections become 401; 5xx never falls back to stale grants | `care-workspace.service.ts:148-150`, CARE-WORKSPACE §7 error table |

## 5. Session contract — normative requirements

Symbolic names below are **contract requirements, not implemented constants**. `PIC` denotes the Tenant PIC principal; `hcw_`/`hpw_` prefixes exist only to separate credential kinds in logs.

### 5.1 Admission (BM → Handyman)

1. `POST /api/v1/handyman/pic/session` accepts a **signed JSON assertion** in the request body with `x-hub-signature-256: sha256=<hex64>`; success is `201 { workspaceToken, expiresAt }`. No local-user middleware, no permission code, no RBAC grant participates in admission.
2. Assertion payload keys are **exactly**: `purpose`, `integrationCode`, `assertionId`, `issuedAt`, `expiresAt`, `representation`. Any missing/unknown key ⇒ uniform 401. `purpose` is the literal `HANDYMAN_PIC_WORKSPACE`; a care-workspace or represented-context handoff assertion must **never** validate as PIC admission, and vice versa (purpose isolation, per CARE-WORKSPACE §2).
3. `representation` keys are exactly `tenantCompanyId`, `buildingId`, and optional `tenantPicId`, `spaceId` — the **same field names and resolution rules as the existing handoff context** (no new claim vocabulary). `tenantPicId` is **required for admission to yield a deciding principal**: absent ⇒ the session may only read (see rule 15), never decide.
4. `issuedAt`/`expiresAt` must match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$` and round-trip; the assertion window is `issuedAt < now < expiresAt`, `expiresAt > issuedAt`, and **`expiresAt - issuedAt <= 300s`**. Future-issued, expired, or malformed ⇒ 401.
5. Signature is computed over `stableJson(assertion)` with the integration secret; the secret is only ever read from server config. `timingSafeEqual` on fixed-length buffers. Signature mismatch ⇒ 401 with no reason detail.
6. Integration must be `ACTIVE` **and** carry the PIC capability (see §5.4). Capability is provisioned by operations and is never derivable from a request.
7. Admission rate limiting reuses the existing local login-throttle convention with an **isolated namespace keyed on the socket address** (never a forwarded header); only a *failed* admission consumes quota; success resets it; a 429 rejection is not charged back to the same key.
8. Query parameters are rejected on admission (`Object.keys(req.query).length === 0`).

### 5.2 Identity assertion & bindings

9. Server-side resolution order, all inside one transaction, **authority locks before session locks** (the order the invalidation triggers use):
   `structural validity → HMAC + window → resolveHandoffContext(representation) → INSERT session row (replay tombstone) → return token`.
10. The session row stores: `id`, `integration_id`, `care-free` actor fields `tenant_company_id`, `tenant_pic_id`, `building_id`, `space_id`, `tenant_building_context_id`, `assertion_id`, `token_hash`, `created_at`, `expires_at`, `revoked_at`. It stores **no** user id and **no** permission snapshot.
11. Every stored context identity is **server-derived**: `tenant_pic_id` is the PIC resolved from `tenant_pics` (ACTIVE, same tenant), never the caller's UUID string.
12. Binding is (integration, tenant, PIC, building[, space]) — **one admission = one tenant-building context**. A PIC occupying two buildings needs two admissions; a session never spans tenants or buildings. This is deliberately narrower than the care workspace (which selects property per call) because a PIC's authority is occupancy-derived, not grant-derived.
13. Optional request narrowing (`requestId`) is **not** part of the credential: authorization is per resource on each call (rule 17). The cursor/token pair must not become a scope-widening input.

### 5.3 Token, expiry, replay, revocation

14. Token = `hpw_` + 32 random bytes base64url; stored **only** as `sha256` hex64 (`CHECK token_hash ~ '^[0-9a-f]{64}$'`); returned exactly once; never in logs, URLs, cursors, error messages, or response projections.
15. Session TTL ≤ **900s** from issuance (same bound as the care workspace), `CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '15 minutes')`. No sliding expiry, no refresh endpoint, no silent renewal. A decision-only session SHOULD be issued at the shortest TTL the portal UX tolerates (≤600s) — deployment knob, not a per-request claim.
16. Replay: `UNIQUE (integration_id, assertion_id)`; a duplicate insert collapses to the uniform 401. Session rows are immutable except the **first** revocation (`to_jsonb` comparison guard, DELETE refused).
17. **Every** authenticated call re-checks, in this order: absolute expiry against `clock_timestamp()`, `revoked_at IS NULL`, integration ACTIVE + capability, **current representation validity** (re-resolve and compare every snapshot field, then `FOR SHARE` locks on the `tenant_building_contexts` / `tenant_space_relationships` rows with `clock_timestamp()` freshness — the `isCurrentCareRepresentation` pattern, `care-representation.service.ts:31-88`), **and additionally** `tenant_pics.status = 'ACTIVE'`, `tenant_companies.status = 'ACTIVE'`, and `pic.tenant_company_id = session.tenant_company_id`. A row-lock wait must not authorize a token that expired while waiting.
18. Revocation surfaces: `DELETE /api/v1/handyman/pic/session` (Bearer, 204, idempotent for an unexpired revoked token; 401 for any other use; accepts no context fields) **and** automatic DB invalidation: a new `AFTER UPDATE` trigger on `tenant_pics` (PIC non-ACTIVE, tenant re-parent, or `user_id` change) and on `tenant_companies` (non-ACTIVE) sets `revoked_at = clock_timestamp()` for live sessions. Reactivation must never resurrect a session.
19. No fallback between credential kinds: the PIC router never consults `user_sessions`, care workspace sessions, or the handoff exchange store, and vice versa.

### 5.4 Integration capability (widening, not a new mechanism)

20. `handyman_handoff_integrations.actor_capability` (`0425`) gains one value: `TENANT_PIC`. Enum becomes `('NONE','CUSTOMER_CARE','TENANT_PIC')`. Because PostgreSQL has no `ALTER CONSTRAINT`, this is `DROP CONSTRAINT` + `ADD CONSTRAINT … CHECK` with `NOT VALID`-free validation — existing rows are `'NONE'` and satisfy any narrower-then-wider enum, so validation cannot fail. `actor_capability` stays `NOT NULL DEFAULT 'NONE'`.
21. An integration holding `TENANT_PIC` may attest **representations only**; it gains no care-actor capability, no property grants, and cannot create, price, issue, supersede, or expire a quotation. The capability is an *attestation right*, never a business permission.
22. **No new actor registry table.** A Tenant PIC is already an entity Handyman owns (`tenant_pics`); provisioning a second registry would create a parallel master and would violate the repo's own rule against parallel masters (CARE-WORKSPACE §1 "Reuse these sources without parallel masters"). Contrast the care actor, which has no local entity and therefore *does* need a registry.

## 6. Ledger design — additive, backfill-free, immutable-safe

### 6.1 `handyman_quotation_decisions` (migration `N+1`, `up` only, single statement batch)

```sql
ALTER TABLE handyman_quotation_decisions
  ADD COLUMN decision_actor_type TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN decided_by_tenant_pic_id UUID REFERENCES tenant_pics (id),
  ADD COLUMN decided_by_pic_session_id UUID REFERENCES handyman_pic_workspace_sessions (id),
  ADD COLUMN approval_binding_id UUID REFERENCES handyman_quotation_approval_bindings (id),
  ALTER COLUMN decided_by_user_id DROP NOT NULL,
  ADD CONSTRAINT handyman_quotation_decisions_actor_identity_check CHECK (
       (decision_actor_type = 'USER'
        AND decided_by_user_id IS NOT NULL
        AND decided_by_tenant_pic_id IS NULL
        AND decided_by_pic_session_id IS NULL)
    OR (decision_actor_type = 'TENANT_PIC'
        AND decided_by_user_id IS NULL
        AND decided_by_tenant_pic_id IS NOT NULL
        AND decided_by_pic_session_id IS NOT NULL)
  ),
  ADD CONSTRAINT handyman_quotation_decisions_binding_check CHECK (
       (decision_actor_type = 'USER'       AND approval_binding_id IS NULL)
    OR (decision_actor_type = 'TENANT_PIC' AND approval_binding_id IS NOT NULL)
  );
```

`approval_binding_id`, and the binding table it references, are specified in **`CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md`**, ratified in the same act as this revision: they exist because F-06 proved that the request lineage PIC cannot be the only possible source of an approver (ratified decisions 3+4). They land in **this same `ALTER`**, never in a later one (ADD-A M2) — otherwise an intermediate state exists in which a `TENANT_PIC` row is legal but unlinked to any authority.

| Clause | Why this and not otherwise |
|---|---|
| `ADD COLUMN … NOT NULL DEFAULT 'USER'` | The `DEFAULT` **is** the backfill: every existing row becomes an explicit `USER`-class historical fact with **zero UPDATE statements**. Constant-default adds are metadata-only in PostgreSQL ≥11, so no rewrite occurs — which matters because `handyman_quotation_decision_no_write` (a `BEFORE UPDATE OR DELETE` trigger, `0394`) would refuse any UPDATE-based backfill outright. Same shape as `0431` for payments, which added `recorded_by_actor_type TEXT NOT NULL DEFAULT 'USER'` over a guarded table. |
| Separate nullable actor columns, not an overloaded `decided_by_user_id` | A `tenant_pics.id` must never be written into a column whose FK says `users(id)`. Two namespaces, two columns, exactly-one CHECK — the `0431` rule, verbatim in mechanism. |
| `DROP NOT NULL` on `decided_by_user_id` | Required by A2 (no user for a PIC). Kept **named and populated** for historical rows so no consumer has to be retrained to read history. |
| `decided_by_pic_session_id` | Satisfies "explicit, immutable, auditable": the decision can be traced to the exact credential that authorized it, which is what makes revocation semantics meaningful after the fact. |
| `approval_binding_id` NOT NULL for `TENANT_PIC` rows (binding CHECK) | An approver must exist only through an act of authority that is separately auditable; the decision row keeps a direct pointer to that act, which is what makes the binding "unchangeable after the decision" observable without a join heuristic (ADD-A §5, R-1.3) |
| exactly-one CHECK (not `NUM_NONNULLS`-style) | PostgreSQL has no such operator; the disjunction is the repo idiom (`0431`, `0426`, `0427`). |
| **No** new permission code in this migration | Permission codes are a catalogue concern (`foundation-permission-catalogue.ts`) and are enumerated by the PART 01 registry gate. Reads/mutations for staff stay as-is; the PIC path is not RBAC-governed by design (A1/A2). |

### 6.2 Guard extension — the part that actually enforces A4/A5/A6

`0394`'s trigger is `BEFORE UPDATE OR DELETE`, so a `TG_OP = 'INSERT'` branch in the function would **never fire**. The migration must therefore **re-create the trigger with INSERT coverage** (contrast `0412:226-230`, where the payments guard already includes `INSERT`, which is why `0431` could add INSERT-time rules by replacing only the function):

```sql
CREATE OR REPLACE FUNCTION handyman_quotation_decision_guard() RETURNS trigger
LANGUAGE plpgsql AS $handyman_quotation_decision_guard$
DECLARE
  pic_tenant UUID; pic_status TEXT; pic_user UUID; binding_pic UUID;
  version_creator UUID; root_creator UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.decision_actor_type <> 'TENANT_PIC' THEN
      RAISE EXCEPTION 'Only an attested Tenant PIC may decide a Handyman quotation.'
        USING ERRCODE = '23514';
    END IF;
    -- R-1.1 (v1.1): the approver must be exactly the PIC its binding confers
    SELECT b.tenant_pic_id INTO binding_pic
      FROM handyman_quotation_approval_bindings b
      WHERE b.id = NEW.approval_binding_id AND b.status = 'ACTIVE';
    IF binding_pic IS NULL OR binding_pic <> NEW.decided_by_tenant_pic_id THEN
      RAISE EXCEPTION 'A PIC decision must name the PIC its approval binding confers.'
        USING ERRCODE = '23514';
    END IF;
    -- liveness and tenant membership are not inferable from a snapshot column
    SELECT p.tenant_company_id, p.status, p.user_id
      INTO pic_tenant, pic_status, pic_user
      FROM tenant_pics p WHERE p.id = NEW.decided_by_tenant_pic_id;
    IF pic_tenant IS NULL OR pic_tenant <> NEW.tenant_company_id
       OR pic_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'The deciding Tenant PIC must be ACTIVE and belong to the attributed tenant.'
        USING ERRCODE = '23514';
    END IF;
    -- maker-checker by identity equivalence (A6); pic_user may be NULL,
    -- which is precisely the residual risk MC4 records
    SELECT created_by_user_id INTO version_creator
      FROM handyman_quotation_versions WHERE id = NEW.quotation_version_id;
    SELECT q.created_by_user_id INTO root_creator
      FROM handyman_quotation_versions v
      JOIN handyman_quotations q ON q.id = v.quotation_id
      WHERE v.id = NEW.quotation_version_id;
    -- pic_user was already resolved by the single tenant_pics read above
    IF pic_user IS NOT NULL
       AND (pic_user = version_creator OR pic_user = root_creator) THEN
      RAISE EXCEPTION 'A Tenant PIC linked to the authoring user may not self-approve.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Handyman quotation decisions are immutable authoritative facts.';
END;
$handyman_quotation_decision_guard$;

DROP TRIGGER handyman_quotation_decision_no_write ON handyman_quotation_decisions;
CREATE TRIGGER handyman_quotation_decision_no_write
  BEFORE INSERT OR UPDATE OR DELETE ON handyman_quotation_decisions
  FOR EACH ROW EXECUTE FUNCTION handyman_quotation_decision_guard();
```

Notes the implementer must not "simplify":

- **Rename-by-replacement:** keep the *existing trigger name* so any operational runbook/test that names it stays accurate; only the timing list grows. `CREATE OR REPLACE FUNCTION` alone is **not** sufficient.
- **`ERRCODE '23514'`** is the repo's convention for these guards (`0427`, `0429`, `0430`) so tests can assert the failure kind, not just a 500.
- **v1.1 replaces** v1.0's "the decision PIC must equal the request lineage PIC" with R-1 (§6.1 above, ADD-A §5). The anti-fabrication property is **moved, not weakened**: no approver can be invented inside a decision call, because the decision still accepts no identity that is not already conferred by an `ACTIVE`, occupancy-verified, audited **binding** (R-1.1), and a binding may never contradict a PIC that BM already attested (R-1.2). What v1.0 made impossible for every lineage-less request, v1.1 makes possible only through an explicit act of authority with a named granter, an effective window, and a revocation history.
- The decide call therefore stays **identity-free in its input**. Widening the approver source must never become "pass a PIC id in the body"; ADD-A B11 is the testable form of that sentence.
- Historical rows are untouched; the INSERT branch only governs new writes. This is what makes the amendment prospective-only (A9) **structurally**, not by policy.
- A trigger body that reads `handyman_quotation_versions`/`tenant_pics` runs inside the same transaction as the decision insert, so it sees the locked version row (the service holds `lockVersionById` first, `handyman-quotation-decision.service.ts:155-163`) — no cross-table lock-ordering inversion, because both reads are of rows already locked FOR UPDATE by the caller.

### 6.3 Backfill & compatibility policy

| Question | Answer |
|---|---|
| Backfill statement? | **None.** The column default is the backfill (A8). |
| Retroactive PIC attribution? | **Forbidden.** Historical `USER` rows are not reinterpreted as tenant consent even where the request later gained a PIC. |
| Legacy reads | `decidedByUserId` stays present for `USER` rows; it becomes nullable in the public projection. Additive fields `decisionActorType`, `decidedByTenantPicId`, `decidedByPicSessionId` (exposed as read-only identifiers, no names). |
| `toPublicDecision` today (`handyman-quotation-decision.service.ts:83-99`) | Must stop being the sole projection: expose actor class first, then ids; never expose the session token, integration secrets, or PIC contact fields. |
| Snapshot/version leak | PART 00 recorded that `toPublicVersion` leaks `createdByUserId`; this amendment does not fix it (out of scope) but a new consumer surface must not repeat it. |
| Existing 54 quotation tests | The API-level decide tests currently authenticate a staff user and expect success. **They will fail by design** once A5 lands; they are the migration list in §10.5, not a regression to be fixed by re-granting staff approval. |

## 7. Execution Scope & downstream eligibility

### 7.1 Ledger-side additive change (same release, same migration)

```sql
ALTER TABLE handyman_execution_scopes
  ADD COLUMN created_by_actor_type TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN created_by_tenant_pic_id UUID REFERENCES tenant_pics (id),
  ADD COLUMN created_by_pic_session_id UUID REFERENCES handyman_pic_workspace_sessions (id),
  ALTER COLUMN created_by_user_id DROP NOT NULL,
  ADD CONSTRAINT handyman_execution_scopes_actor_identity_check CHECK (
       (created_by_actor_type = 'USER' AND created_by_user_id IS NOT NULL
        AND created_by_tenant_pic_id IS NULL AND created_by_pic_session_id IS NULL)
    OR (created_by_actor_type = 'TENANT_PIC' AND created_by_user_id IS NULL
        AND created_by_tenant_pic_id IS NOT NULL AND created_by_pic_session_id IS NOT NULL)
  );
```

`handyman_execution_scope_no_write` (`0395`) is likewise `BEFORE UPDATE OR DELETE`-only → any INSERT-time eligibility rule needs the same trigger-timing widening as §6.2.

### 7.2 Eligibility rules (A4/A5)

| Rule | Statement |
|---|---|
| **E1** | After ratification, a scope row may be inserted **only** by the APPROVE branch of a `TENANT_PIC`-class decision, in the same transaction (F8 atomicity preserved: `insertDecision` → `updateVersionLifecycle` → `insertScope`, `handyman-quotation-decision.service.ts:210-262`). |
| **E2** | The scope's `created_by_tenant_pic_id` must equal the decision's `decided_by_tenant_pic_id`; `quotation_decision_id NOT NULL` (`0395:34-35`) already forces the linkage, so no orphan scope can exist. |
| **E3** | Enforced twice: in the service (before insert) **and**, if ratified, in a `BEFORE INSERT` guard branch. The service check produces the error code; the DB branch is the anti-bypass floor for any future writer that forgets it. |
| **E4** | Read compatibility verified: no consumer joins `handyman_execution_scopes.created_by_user_id` to `users` (grep of `handyman-scope-assignments/`, `handyman-sla-status-api/`, `handyman-settlement/`, `handyman-financial-entitlements/`, `handyman-customer-transactions/`, `handyman-requests/handyman-service-request.repository.ts`) → making the column nullable cannot silently drop downstream rows. Any future join on it must be `LEFT` and actor-class aware. |
| **E5** | REJECT never creates a scope (F8 unchanged). A `USER`-class decision row cannot be created at all (§6.2), so no staff-origin scope can appear even accidentally. |

### 7.3 Downstream chains that must be re-certified, not rewritten

`0396` scope assignments, `0397`–`0405` arrival/work/evidence/QC/BAST, `0410`, `0416`, `0418`–`0422` reference `handyman_execution_scopes` and are **authoritatively downstream** (F10). They consume a scope; they never inspect the decision actor. Their behavior is unchanged **provided** E1–E4 hold; the certification PART re-runs their focused suites as regression evidence only.

## 8. Maker-checker by identity equivalence

Definitions, all drawn from stored facts:

```
M (maker set of version V, v1.1)
     = { handyman_quotations.created_by_user_id                   (root author)
       ∪ handyman_quotation_versions.created_by_user_id          (version author)
       ∪ handyman_quotation_approval_bindings.granted_by_user_id  (the granter) }
C (checker set of a row)    = { decided_by_tenant_pic_id }
                              ∪ { tenant_pics.user_id of that PIC, when NOT NULL }
```

| Rule | Statement |
|---|---|
| **MC1** | A decision is rejected when `M ∩ C ≠ ∅`. Because the two namespaces are disjoint, the **only** detectable same-human case is a PIC whose optional `user_id` link names an authoring user — which is exactly why A6 forbids evaluating on `users.id` alone. |
| **MC2** | MC1 is evaluated **both** in the service (to return a proper error) and in the ledger INSERT guard (§6.2) so that no future caller can bypass it. |
| **MC3** | Error surface: reuse the existing `HANDYMAN_QUOTATION_DECISION_CONFLICT` (409) rather than minting a new enumerable code — self-approval is "a decision that cannot be recorded against this version", the same diagnostic class as an idempotency/fingerprint conflict (`handyman-quotation-decision.service.ts:53-60`). |
| **MC0** | v1.1 adds the **binding granter** to `M` (ADD-A §6). This is what makes "a manager may select the signer" safe: selecting a signer who is the granter themselves — directly, or through that PIC's linked user — is refused at binding-write time **and** at decision-insert time |
| **MC4** | Residual risk recorded: when `tenant_pics.user_id IS NULL`, no stored fact can prove distinctness. Mitigation is prospective, at the only place the two namespaces touch: `tenant-pic` create/`syncUserId` must **refuse** linking a `user_id` that holds `tenant_company.manage` for that same tenant company (the repository already locks the tenant row and rejects link conflicts, `tenant-pic.repository.ts:47-74`, so a third check is idiomatic). Detection on existing rows is aggregate-only (§11 BLK-7). |
| **MC5** | The **issuer** of a version is not a stored column on `handyman_quotation_versions` (0391 has no `issued_by`/`issued_at`; the projection writes only `status`, `valid_until`, `updated_at` — `handyman-quotation.repository.ts:195-212`), so `M` is author-based, not presentation-based. Widening `M` to include the issuer requires a new column **and** an extension of `handyman_quotation_version_block_mutation`, whose guard is a *column list* (immutable-by-enumeration, `0391:79-113`) — any column not listed is silently mutable. Recorded as BLK-6. |

**Note on F7 (unchanged):** `lockVersionById`-family locking, `Idempotency-Key` **header** + sha256 fingerprint, one authoritative decision per version, conflicting replay rejected — all preserved. The amendment does not weaken them; it removes the actor-sameness assumption from the replay branch (see §10.3).

## 9. OpenAPI contract (delta to be implemented later; nothing in `docs/api/` changes here)

| Surface | Change | Kind |
|---|---|---|
| `POST /handyman/pic/session` | new; `x-hub-signature-256` header; body = §5.1 assertion; 201 `{workspaceToken, expiresAt}`; 401 uniform; 429 with `Retry-After`; `Cache-Control: no-store` | new path |
| `DELETE /handyman/pic/session` | new; `PicWorkspaceBearer`; 204 idempotent; 401 otherwise | new path |
| `GET /handyman/pic/requests/{handymanRequestId}` | new bounded read: request + presented version + lines/totals + own decision state; **no** property-wide history | new path |
| `POST /handyman/pic/quotation-versions/{quotationVersionId}/decision` | new; body exactly `{decision}`; `Idempotency-Key` header required; 201 decision (+ `executionScope`), 401, 404, 409 | new path |
| `GET /handyman/pic/quotation-versions/{quotationVersionId}/decision` | new; exact read of the caller's own decision | new path |
| `POST /handyman/quotations/{quotationId}/approval-binding` | new, **staff** surface (`authenticationMiddleware` + `tenant_company.manage` + BE-02G, per B8); body exactly `{tenantPicId, effectiveUntil?}`; 201 binding, 404 uniform for an ineligible PIC (B1-B5), 409 for a pinned thread (B13) or a lineage conflict (R-1.2) | new path |
| `DELETE /handyman/quotations/{quotationId}/approval-binding` | new, staff; always permitted (B15); 204 idempotent | new path |
| `GET /handyman/quotations/{quotationId}/approval-binding` | new, staff (`tenant_company.read`) + PIC read of the same fact through the portal read (C22); exposes ids, status, window, granter id only | new path |
| securitySchemes | new `PicWorkspaceBearer` (http bearer, distinct scheme) — **never** reuse the local `bearerAuth` scheme | additive |
| `HandymanQuotationDecisionRecord` (`openapi.yaml:82440`) | `decidedByUserId` → `nullable: true`; add `decisionActorType` (`enum: [USER, TENANT_PIC]`), `decidedByTenantPicId` (uuid, nullable), `decidedByPicSessionId` (uuid, nullable), `approvalBindingId` (uuid, nullable — v1.1, the authority under which a PIC signed); description rewritten to "actor class is explicit; a PIC row has no user id by design; `tenantPicId` remains the intake lineage snapshot and is never repurposed" | additive/relaxing |
| `HandymanExecutionScopeRecord` | `createdByUserId` → `nullable: true`; add `createdByActorType`, `createdByTenantPicId` | additive/relaxing |
| staff `POST /handyman/quotation-versions/{quotationVersionId}/decision` (`:5749-5778`) | dispositioned per §10.4; `GET` read of a historical decision stays available to `tenant_company.read` | behavior change |
| `POST /handoff/assertions`, `handyman-api` routes, care workspace routes | **unchanged** | none |
| `/webhooks` exposure, mount order, response envelope, `X-Request-ID` | **unchanged** | none |

## 10. Consumers that must move together (no-bypass list)

Every site that can currently write or interpret a quotation decision. A change that lands on the ledger **without** these rows shipped in the same release leaves a bypass.

| # | Site | Today | Required by this amendment |
|---|---|---|---|
| C1 | `handyman-quotation-decision.service.ts:126-315` | takes `actorUserId: string`; `assertUuid(actorUserId)`; passes it to ledger, scope, events; calls `assertQuotationThreadBuildingAccess` at `:163` | principal becomes a **discriminated** input (`{kind:'PIC', picId, sessionId}`); building-scope guard **replaced** (not extended) on the PIC branch; `USER` branch becomes read-only history (A5, A7) |
| C2 | `handyman-quotation-decision.service.ts:168-185` (replay) | replays on key+fingerprint+decision only — **no actor re-check** (PART 00 T-04) | must verify the replaying principal is the **same actor** (same PIC id, same tenant) before returning the original row; otherwise a stolen/other-tenant key could read another tenant's decision |
| C3 | `handyman-quotation-decision.service.ts:320-343` (`getHandymanQuotationDecision`) | staff read + BE-02G | staff read stays; the PIC read is a **separate** service+route; no shared predicate by ID substitution (CARE-WORKSPACE §8) |
| C4 | `handyman-quotation-decision.repository.ts:16-108` | column list without actor type | widen select/insert column lists + row types; INSERT-only, no UPDATE surface (0394) |
| C5 | `handyman-quotation-decision.types.ts:18-61` | `decidedByUserId: string` required in both record and insert types | discriminated `HandymanQuotationDecisionActor`; `New…` no longer carries a bare user id |
| C6 | `handyman-execution-scope.service.ts:99-129` (`buildExecutionScopeInput`), `:131-152` (`toPublicExecutionScope`) | `createdByUserId: string` | actor-aware input + projection; location derivation untouched |
| C7 | `handyman-execution-scope.repository.ts:15-101` | column list | widen; `insertScope` stays INSERT-only |
| C8 | `handyman-quotations-api.routes.ts:96-97` | staff `POST`/`GET` decision under `tenant_company.manage`/`.read` | `POST` soft-closed (§10.4); `GET` read retained for history |
| C9 | `handyman-quotations-api.controller.ts:263-287,289-300` | passes `req.auth.userId`; reads `Idempotency-Key` header | staff handler refuses; PIC handlers live in a **new** `handyman-pic-portal-api` module/router mounted without `authenticationMiddleware` |
| C10 | `handyman-lifecycle-api.routes.ts:36` | quotations explicitly out of scope | **verify stays true** — no second decide surface may appear there |
| C11 | `0395` consumers (`handyman-scope-assignment.repository.ts`, `handyman-sla-status-api.service.ts`, settlement/entitlement/transaction repositories, `0396`–`0422`) | read scopes, ignore decision actor | no change required; re-run focused suites as regression evidence (§7.3, E4) |
| C12 | `operational-events/index.ts:39,165` + `0080` | `actorUserId?: string \| null`, column nullable | PIC approvals journal with `actor_user_id = NULL` and put `decisionActorType`, `tenantPicId`, `sessionId` into `metadata`; event type strings `HANDYMAN_QUOTATION_APPROVED/_REJECTED` and `HANDYMAN_EXECUTION_SCOPE_CREATED` keep their names (PART 00 noted these are not in the frozen audit/notification vocabulary — that gap is *not* widened by inventing new ones) |
| C13 | `handyman-quotation-access.ts:23-41` (BE-02G) | staff building wall keyed on `actorUserId` | unchanged for staff; **never** invoked with a synthetic user id for a PIC |
| C14 | `handyman-service-request.repository.ts:184-234` (C6) | staff read wall; PIC branch nested inside `EXISTS (user_building_assignments …)` | **not extended, not reused as PIC authority** (A7; W03 PART 01 F-05). The PIC read predicate is new and assignment-free |
| C15 | `src/shared/errors.ts` | `ERROR_CODES` is a plain map (`:3`, `:1068-1069`) | additive codes: `HANDYMAN_PIC_WORKSPACE_UNAUTHORIZED`, `HANDYMAN_PIC_WORKSPACE_RESOURCE_NOT_FOUND` (no new decide error code per MC3) |
| C16 | `handyman-quotations-api` + snapshot builders exposing `createdByUserId` (PART 00 leak) | staff id visible | unchanged in this release; recorded so the PIC surface must not inherit the pattern |

### 10.4 Disposition of the staff decide route

Two options; **S1 is recommended**:

| Option | Mechanics | Cost |
|---|---|---|
| **S1 soft-close** | Route stays mounted; the service refuses `USER`-class decides with 409/`STAFF_APPROVAL_FORBIDDEN` semantics; response gains `Deprecation`/`Sunset` headers; removal is a later housekeeping PART | journey §8 ("tiga frontend existing memakai endpoint yang sama") is respected during migration; zero bypass because the ledger INSERT guard independently forbids `USER` rows |
| S2 hard removal | Delete route + OpenAPI path in the same release | breaks all three frontends at once; forces FE lockstep release |

Either way the DB-level INSERT rule (§6.2) means **no** staff approval can be recorded, so a soft-close is not a hole.

### 10.5 Explicitly-listed test/consumer migrations (evidence of blast radius, not a fix)

`tests/*quotation*` decision-path tests that authenticate a staff user and expect a successful APPROVE (PART 00 counted 54 quotation tests; the subset asserting decision behavior is the migration set), the `POST /handyman/requests/:id/quotation` → decide → scope chain fixtures, and any snapshot/audit assertion that reads `decidedByUserId` as always-present. They must be rewritten to a PIC principal, not patched to grant staff more permission.

## 11. Rollback & migration safety on an immutable ledger

| Rule | Statement |
|---|---|
| **R1** | `migrateDown` reverts **only the last applied migration**, inside one transaction (`src/database/migrate.ts:76-90`). So the ledger migration is only revertible while it is last — i.e. before the session/portal PARTs land. Plan: revert window = the migration PART itself. |
| **R2** | `up` contains **no UPDATE**, so it neither trips nor needs a pause on `handyman_quotation_decision_no_write` / `handyman_execution_scope_no_write`; it only replaces those triggers' timing lists (drop+create is metadata-only). |
| **R3** | `down` must **refuse** to destroy provenance: before dropping columns/constraints it must `RAISE EXCEPTION` when `EXISTS (SELECT 1 FROM handyman_quotation_decisions WHERE decision_actor_type <> 'USER')` (same for scopes). Note the precedent defect to avoid repeating: `0431.down()` drops the columns but never restores `recorded_by_user_id NOT NULL`, so a rollback there leaves a weaker schema than it started with. Our `down` either restores the NOT NULL or refuses. |
| **R4** | **Forward-fix-only** after the PIC path has written a row: rollback is a schema regression that would orphan authoritative facts, which A8/A9 forbid. Documented as the standing policy for this ledger. |
| **R5** | Constraint adds (`ADD CONSTRAINT … CHECK`) validate existing rows; each new CHECK here is satisfied by construction by every historical row (all have a non-null `decided_by_user_id`/`created_by_user_id` and NULL new columns). If any historical row violated, `up` fails **before** committing (whole migration is one transaction) → no partial schema. |
| **R6** | New `UNIQUE`/`NOT NULL` tightening (e.g. idempotency scoping, §12 BLK-8) must **never** ride along with this migration: it requires a staging measurement first, and a failing `ADD UNIQUE` on an immutable table has no UPDATE-based escape hatch. |
| **R7** | Lock ordering is contractual: **authority row → session row** (mirrors `handyman_care_workspace_invalidate_actor` vs `resolveActor`/`useSession`, and `lockCareCreateWorkspaceScope`'s comment). Violating it risks a deadlock against the revocation triggers. |
| **R8** | The session table's own guard must allow exactly one mutation (first revocation) and refuse DELETE, keeping replay tombstones forever (`0429` pattern) — otherwise revocation audits lose their evidence. |

## 12. Ratification requirements (blocking, by authority)

| # | Decision needed | Owner | Blocks |
|---|---|---|---|
| BLK-1 | **RESOLVED at v1.1** by ratified decisions 3+4 and `CR-HM-06_ADDENDUM_A_*` (late, audited, revocable approval binding). Original finding preserved for audit: ~~requests with `tenant_pic_id IS NULL` have no eligible approver~~. Residual consequence re-routed to BLK-GAP-1 (release sequencing) and BLK-BIND-BACKFILL (existing lineage-PIC threads needing a binding row). Original v1.0 finding, kept for audit: verified mainline, not an edge case — `handyman_service_requests.tenant_pic_id` is nullable (`0378:40`); the request inherits it from attribution (`handyman-service-request.service.ts:232`); and the care create-exchange whitelist is exactly `['tenantCompanyId','buildingId','spaceId']` (`care-create-exchange.service.ts:26-31`) — **a PIC cannot be bound at care-assisted creation at all**, while assisted intake is the journey's only creation path (§4.1). The v1.0 §6.2 coherence rule made this unpatchable at the ledger by design. v1.0 options (a) mandate a PIC at intake, (b) an offline-consent ledger, (c) defer approvals were **all rejected**; the ratified resolution is a fourth path — late, audited, revocable **approval binding** (`CR-HM-06_ADDENDUM_A_*`), which keeps intake optional (decision 3) and makes the binding, not the caller, the source of the approver (decision 4) | **CLOSED at v1.1** (product decisions 3+4 ratified); successors: BLK-GAP-1 + BLK-BIND-BACKFILL in ADD-A §8 | nothing — replaced by ADD-A §8 |
| BLK-2 | **A reusable PIC session needs its own freeze.** CR-HM-01 D7 keeps the one-time exchange as the only handoff credential; the care workspace obtained an explicit authority freeze for a bounded reusable session (CARE-WORKSPACE-01 PART 01 §2) *before* implementation. The PIC needs the equivalent: an authority paragraph naming the purpose, TTL, revocation and non-fallback rules — and an explicit statement that D4's "actor is never a PIC" is **not** being weakened (the PIC is resolved from Handyman's own master, not from a BM-asserted actor block) | Architecture | **03B** |
| BLK-3 | **Staging measurement before any population claim**: PIC-linked rate, `users` holding `tenant_company.manage` for the same tenant as their PIC link (MC4 detection), requests with NULL PIC, existing duplicate `idempotency_key` across tenants (BLK-7 precondition). Aggregate-only queries are already specified in `docs/e2e/W03_PART01_PIC_READINESS_AND_REGISTRY_GUARD.md` §3; the schema change itself does not depend on them, but BLK-1 sizing, MC4's backfill question, and BLK-8 do | DBA + Operations | BLK-1 sizing, BLK-7, MC4 remediation |
| BLK-4 | **Staff route disposition S1 vs S2** (§10.4) — three frontends share the endpoint (journey §8) | Product owner + FE owners | **03E** |
| BLK-5 | **SUPERSEDED at v1.1**: MC0/MC1' enforce the same property at the binding chokepoint (the granter is in `M`), so `tenant-pics` provisioning UX needs no new restriction. Detecting pre-existing captured links stays advisory and aggregate-only (BLK-3) | Product owner + Security | **03C** (DB rule) + **03E** (service rule) |
| BLK-6 | **Maker set authorship basis (MC5)**: accept creator-based `M`, or add `issued_by_user_id` to `handyman_quotation_versions` **and** extend `handyman_quotation_version_block_mutation`'s column list (an unlisted column is silently mutable — `0391:79-113`) | Architecture + CR-HM-06 owner | **03C** exit gate |
| BLK-7 | **Idempotency scoping (PART 00 T-06)**: `handyman_quotation_decisions_key_unique` is a **global** `UNIQUE (idempotency_key)` (`0394`), which is a cross-tenant 409 oracle. Proposed: replace with `UNIQUE (tenant_company_id, idempotency_key)`. Requires BLK-3's duplicate count to be zero, and per R6 must be its own migration | Architecture + DBA | **03F** |
| BLK-8 | **TTL/UX bound** (rule 15): whether the portal can complete a decision inside a ≤600s session, or needs the 900s ceiling; a per-decision single-use credential is the alternative if UX cannot tolerate re-admission | Product owner + BM | **03B** constants |
| BLK-9 | **PIC read surface scope**: which bounded reads the portal needs (rule 13 says the credential does not scope them). Over-reading (tenant-wide history) must be refused by contract now, not trimmed later | Product owner | **03D** route list |

## 13. Implementation sequencing (W-series PARTs; small, each independently revertible)

CR-HM-06's own frozen PART table (01–07B) is **not** resequenced: those PARTs are implemented and certified. These are follow-on W-series PARTs executed **under** the amended freeze, one concern each, each with a focused exit gate:

| PART | Scope | Explicitly NOT in scope | Exit gate |
|---|---|---|---|
| **03A** ✓ | Governance landing (DONE at `docs/e2e/W03_PART03A_LATE_PIC_BINDING_RATIFICATION.md`): ratified §12 BLK-1/BLK-2 decisions recorded; pointer lines added to `CR-HM-06_DECISION_FREEZE.md` §F6 and the journey OD table by their owners (§14.2) | any code | amendment marked RATIFIED with commit sha |
| **03B** | Session foundation: `handyman_pic_workspace_sessions` (+ replay tombstone, immutability guard, revocation triggers on `tenant_pics`/`tenant_companies`), `actor_capability` widening, `admitPicWorkspace`/`resolvePicWorkspacePrincipal`/revoke, `POST`/`DELETE /handyman/pic/session` | ledger, decision path, any RBAC grant | focused auth tests: replay, window, expiry-after-lock-wait, cross-tenant, revoked PIC mid-session, malformed/unknown keys, credential-kind separation, token-hash never echoed |
| **03B2** | Approval binding foundation (ADD-A §3): bindings table + guard, B1–B5 eligibility, B12 issue gate, B13–B16 pin/revoke, B18 after-decision freeze, staff write/read routes. No ledger change, no PIC decision path | any decision-path change | bind/refuse matrix, one-ACTIVE index, pin-while-ISSUED, revoke-always, after-decision freeze, R-1.2 lineage conflict, caller identity structurally ignored |
| **03C** | Ledger additive actor identity (both tables) + guard rewrite with INSERT branch + types/repository/projection | any behavior change on the staff path yet | migration tests on legacy parity: existing rows readable, `USER` INSERT now refused, coherence and no-borrow rules each have a red test |
| **03D** | PIC read surface (bounded `GET /handyman/pic/requests/:id` + own decision) | mutations | 404-uniformity, minimization, no-C6-reuse test (assert the new predicate does not reference `user_building_assignments`) |
| **03E** | PIC decide surface + MC1/MC2 maker-checker + replay actor check (C2) + `Deprecation` on staff route (S1) | scope-creation guard changes (already covered by 03C's rules — verify, don't duplicate), staff removal | end-to-end: admission → read → approve → scope exists; reject path; second-decision conflict; self-approval refused; `Idempotency-Key` header contract |
| **03F** | Downstream eligibility hardening + regression: E1–E3 DB-level guard ratified or explicitly waived; re-run focused suites of the `0396`–`0422` consumers | new downstream features | no bypass test: a forged INSERT of a scope with a `USER` decision must raise |
| **03G** | OpenAPI contract exposure for everything shipped in 03B–03F (three binding routes, PIC session + portal + decide paths, `approvalBindingId`, nullable actor fields) | new endpoints beyond what 03B–03F shipped | schema marks `approvalBindingId` read-only and `decidedByUserId` nullable; no duplicate route for the same fact (journey §8) |
| **03H** | Certification: W03 certification doc, debt-register update, regression of the `0396`–`0422` scope consumers | new scope | all PART gates green; mutation checks on every guard test (a mutant that drops a rule must fail the suite) |

Dependency: **03A ✓ (done at W03 PART 03A)** → 03B → 03B2 → 03C → (03D ∥ 03E) → 03F → 03G → 03H. 03B2 precedes 03C because the ledger's `approval_binding_id` FK must reference a table that already exists, and it precedes 03E because "bind before present" (ADD-A B12) is the rule that makes a PIC approver exist at all. `03C` is the only schema-behavior release for the ledgers; it must not be split from the guard rewrite, and it may not ride with BLK-7's constraint change (R6).

## 14. Explicit non-goals & integrity statement

### 14.1 Non-goals

- No auto-accept on expiry, no silence-equals-approval, no partial approval, no approval of a DRAFT version (F3/F6 unchanged).
- No payment, BAST, settlement, or QC consequences of approval (F11, journey §6–§7).
- No change to `docs/api/openapi.yaml`, `src/**`, migrations, seeds, permission catalogue, or tests in this PART.
- No new `handyman.*` permission code, no role, no default grant (A2 makes a PIC non-RBAC by construction).
- No extension or reuse of C6 or BE-02G for PIC principals (A7).
- No local `users`/`user_sessions` provisioning, no "customer kind" flag, no impersonation/act-as mechanism.
- No PIC actor registry table (§5.4 rule 22), no property-grant concept for PICs (occupancy is their basis), no bulk/broad read surface.
- No correction/repair surface for already-recorded decisions.
- No auto-binding, no default binding, no derived binding minted at read time, and no mutation of `handyman_service_requests.tenant_pic_id` — the binding authority lives entirely in `CR-HM-06_ADDENDUM_A_*` and its own new table.
- No measurement claims: population numbers stay UNVERIFIED (`W03_PART01_…` §3 supplies the queries; BLK-3 gates their use).

### 14.2 Pointer patch — status after ratification

Ratification applied the CR-HM-06 pointer as an **explicit, labelled revision**: the original F6 text remains in that file verbatim, marked superseded in part, with the revised block beside it. Nothing was edited away. The journey document is **not** touched — it is the product owner's business contract, and decisions 3+4 require no change to it (the journey never demanded a PIC at intake, so §4.1/§4.3 as written stay consistent with ADD-A).

| Target | Status |
|---|---|
| `CR-HM-06_DECISION_FREEZE.md` §F6 | **APPLIED** at v1.1 (labelled pointer + revised F6 block, original text retained) |
| journey v1.3 §9 OD table | **NOT APPLIED** — owner action; OD-7 (who may confer an approver after intake) is submitted for the product owner to accept or reject |

Patch text kept for the record:

```
CR-HM-06_DECISION_FREEZE.md, immediately under "## F6 — Customer approval":
  > **SUPERSEDED IN PART by CR-HM-06/A01 (docs/handyman/
  > CR-HM-06_AMENDMENT_01_TENANT_PIC_APPROVAL_ACTOR.md), §3 — actor class
  > widened to an attested Tenant PIC session. Ratified at `<sha>`; status
  > PROPOSED until then. Decision vocabulary, version binding, idempotency,
  > and "caller-supplied identity is never authority" are unchanged.**

(ganti `<sha>` di baris terakhir dengan commit sha tempat ratifikasi dicatat.)

docs/e2e/HANDYMAN_BUSINESS_JOURNEY_v1.3_FROZEN.md, OD table (§9):
  | OD-7 | Siapa yang berhak menyetujui bila request tidak memiliki PIC? | Terbuka (BLK-1) |
```

### 14.3 Amendment integrity statement

This record is governance/design only. It changes no runtime code, no migration, no OpenAPI document, no test, and no frozen document. Every structural claim above is traceable to a file:line at HEAD `21a7b47` (§1, §11 of `docs/e2e/W03_PART02_PIC_APPROVAL_CONTRACT_FREEZE.md`). Where a rule is a *proposal*, it is marked PROPOSED or listed in §12; where a consequence is uncomfortable (BLK-1, MC4 residual, MC5), it is stated rather than smoothed over.

**AMENDMENT 01 v1.1 RATIFIED AS CONTRACT — recorded in `CR-HM-06_DECISION_FREEZE.md` ("F6 — REVISED v1.1") together with `CR-HM-06_ADDENDUM_A_*`. Ratification is not certification: 03B–03G are unstarted, and BLK-GAP-1 (P0, release sequencing) must be answered by the product owner before 03E may close the staff approval path.**

## 15. References

- `docs/handyman/CR-HM-06_ADDENDUM_A_TENANT_PIC_BINDING_AUTHORITY.md` — **v1.1 dependency**: late Tenant PIC binding authority (B0–B20, R-1, MC0–MC5', M1–M6, C17–C24, ADD-A blockers).

- `docs/handyman/CR-HM-06_DECISION_FREEZE.md` — F6 (amended), F7/F8/F9 (unchanged), frozen tokens, PART sequence.
- `docs/handyman/CR-HM-01_AMENDMENT_01_CUSTOMER_CARE_ACTOR_HANDOFF.md` — D4–D8, §3.6 downgrade protection, §4 invariants.
- `docs/handyman/CR-HM-CARE-WORKSPACE-01_PART01_AUTHORITY_CONTRACT_FREEZE.md` — §1 no parallel masters, §2 admission/TTL/non-fallback, §7 routes/minimization/errors, §8 predicate separation.
- `docs/e2e/W03_QUOTATION_PIC_APPROVAL_RECONCILIATION.md` — PART 00 authority audit (T-01…T-06) + the F-05 correction note.
- `docs/e2e/W03_PART01_PIC_READINESS_AND_REGISTRY_GUARD.md` — R1–R4 readiness, F-05, aggregate-only queries, blocker register this amendment inherits.
- `docs/e2e/W03_PART02_PIC_APPROVAL_CONTRACT_FREEZE.md` — this amendment's evidence ledger, acceptance criteria, and blocker routing.
- Migrations: `0002`, `0080`, `0145`, `0148`, `0375`, `0378`, `0391`, `0394`, `0395`, `0425`, `0426`, `0427`, `0429`, `0430`, `0431`, `0432`.
- Modules: `handyman-quotations`, `handyman-quotations-api`, `handyman-care-workspace`, `handyman-care-actors`, `handyman-handoff`, `handyman-requests`, `tenant-pics`, `auth/rbac.middleware`, `operational-events`.
