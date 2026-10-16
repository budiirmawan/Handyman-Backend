# CR-HM-BAST-SIGN-00 — Explicit Unresolved Product Decisions

## Overview
This document lists all product decisions that must be explicitly approved and cannot be assumed or defaulted. Each decision has options, a recommended default for this session, and a designated decision maker.

---

## Decision Table

> **GOVERNANCE CORRECTION — CR-HM-BM-CARE-AUTH-01.** The `Default (This Session)`
> column is an **Arena session default selected to unblock design work. It is not a
> business approval** and must not be treated as one. The only approval evidence for
> SD-01…SD-15 was self-declared inside this document; no Product Lead, Security Lead,
> Ops Lead or Legal sign-off exists anywhere in the repository. Their status is
> therefore **Proposed** (SD-11 remains **Pending** on Legal).
>
> **SD-16…SD-19 are the exception.** They restate established business and security
> principles of the TENANT/PIC ↔ CUSTOMER CARE BUILDING ↔ HANDYMAN baseline
> (provenance-only exchange tokens, no automatic commercial mutations, no direct
> Tenant account, session-derived recording identity). They carry no new policy
> invention, so they retain **Approved** and are binding design constraints.
>
> **Runtime consequence.** No Proposed or Pending decision may be built into runtime
> authority. Specifically, ECDSA/PSrE signature policy (SD-01, SD-03, SD-11, SD-13),
> optional-evidence relaxation (SD-05), step-up waiver and internal bypass (SD-06,
> SD-07) and warranty auto-start (SD-08) stay **out of any implemented authority**
> until a named decision maker records an explicit approval.
>
| Decision ID | Option A | Option B | Default (This Session) | Decision Maker | Status |
|---|---|---|---|---|---|
| **SD-01** | PSrE required for ALL customer contracts | PSrE optional; Option A (authenticated e-signature) default for all | **Option A default** — authenticated electronic approval without PSrE for standard contracts | Product Lead | Proposed |
| **SD-02** | Challenge nonce expiry: 5 minutes | Challenge nonce expiry: 15 minutes | **5 minutes** — balance security vs. UX; shorter expiry reduces replay window | Product Lead | Proposed |
| **SD-03** | Approved signature algorithms: ECDSA P-256 only | Approved: ECDSA P-256 / P-384 / RSA-2048 | **ECDSA P-256 / P-384** — broader algorithm support while maintaining security | Security Lead | Proposed |
| **SD-04** | rejectReason mandatory for REJECT | rejectReason optional (error if missing) | **Mandatory** — current constraint; ensures complete rejection records | Product Lead | Proposed |
| **SD-05** | Evidence record mandatory for ACCEPT | evidenceRecordId optional for ACCEPT | **Optional** — customer may ACCEPT without additional evidence beyond QC gate | Product Lead | Proposed |
| **SD-06** | Step-up verification for ALL ACCEPT requests | Step-up only for "high-risk" contracts (e.g., > threshold value) | **All external customers** — challenge-response for all; waivable for verified internal actors | Product Lead / Security Lead | Proposed |
| **SD-07** | Internal Customer Care bypass step-up | No bypass; challenge-response for ALL actors including internal | **Waivable for verified internal actors** — sessions with validated identity may skip challenge | Security Lead | Proposed |
| **SD-08** | Warranty auto-start on ACCEPT | ACCEPT → warranty immediately active | **ACCEPTed warrants further QC/verification before warranty auto-start** — warranty starts after separate warranty initialization flow | Ops Lead | Proposed |
| **SD-09** | VOID reason stored in event metadata only | VOID reason also stored as document column | **Event metadata only** — existing pattern from CR-HM-11 PART 01; preserves append-only history | Product Lead | Proposed |
| **SD-10** | Concurrent ACCEPT: last-write-wins vs error | Concurrent: reject second, or allow last-write-wins | **Error (409 concurrency conflict)** — BAST UPDATE optimistic concurrency ensures only one writer wins | Security Lead | Proposed |
| **SD-11** | PSrE integration path for existing ACCEPTed BASTs | No migration path; PSrE only for new BASTs | **Migration path: existing ACCEPTed BASTs remain valid; PSrE optional for new/updated contracts** — backward compatibility | Product Lead / Legal | Pending |
| **SD-12** | Multi-language challenge payload | Challenge payload in English only | **English** — consistent across all locales; i18n of payload not required (technical identifier) | Product Lead | Proposed |
| **SD-13** | Challenge signature format (JWS vs raw bytes) | JWS (JSON Web Signature) format for challengeSignature | **Raw bytes / base64url** — simpler; no JWS header parsing required on verification side | Security Lead | Proposed |
| **SD-14** | Idempotency key generation: frontend or backend | Frontend generates; backend generates and returns in challenge response | **Backend generates and returns in challenge response** — ensures uniqueness and avoids key collisions | Security Lead | Proposed |
| **SD-15** | Evidence record visibility in frontend | Full evidence record details visible to customer | **Summary only** — customer sees "Evidence linked: yes/no" but not full file metadata (security/privacy) | Product Lead / Legal | Proposed |

---



## Care Handoff Authority Corrections (Added per CR-HM-BM-CARE-HANDOFF-01)

These decisions explicitly document the CR-HM-BM-CARE-HANDOFF-01 business correction
model, ensuring the BAST authority design and the Care decision model are clearly
separated and their boundaries are authoritative.

| Decision ID | Option A | Option B | Default (This Session) | Decision Maker | Status |
|---|---|---|---|---|---|
| **SD-16** | Exchange token proves Tenant approval | Exchange token is provenance-only; does NOT prove Tenant approval | **Provenance-only** — token hash records consumption, not approval | Product Lead | Approved |
| **SD-17** | Care decision triggers BAST/quotation/VAR mutations | Care decision is neutrally recorded; no automatic commercial mutations | **Neutral recording** — Care decision does not trigger APPROVE/ACCEPT | Product Lead | Approved |
| **SD-18** | Tenant requires direct Handyman account | Tenant does not require direct Handyman account; Building Care mediates | **No direct Handyman account required** — Building Care is the bridge | Product Lead | Approved |
| **SD-19** | recordedByUserId from request body is authoritative | recordedByUserId derived from authenticated Backend session, not request body | **From authenticated session only** — request body not trusted | Product Lead | Approved |

### Decision Rationale Summary (Updated High-Priority)

#### New High-Priority Decisions (CR-HM-BM-CARE-HANDOFF-01)

1. **SD-16: Exchange Token Provenance** (Approved: Provenance-only)
   - The BM Super App handoff exchange token hash records which single-use token was
     consumed for audit provenance. It does NOT prove Tenant approval of any commercial
     entity (quotation, variation, BAST).
   - **Impact**: Prevents unsafe assumption that exchange token = Tenant approval.
     Care decision records store the token hash neutrally.

2. **SD-17: No Automatic Commercial Mutations** (Approved: Neutral recording)
   - Creating a Care decision record (CONFIRM/REJECT) does NOT automatically trigger:
     quotation APPROVE, variation APPROVE, or BAST ACCEPT.
   - Each commercial decision requires its own verifiable provenance chain.
   - **Impact**: Frontend and backend must not propagate Care decision creation as a
     signal for commercial mutations. Fail-closed when proof requirements are unmet.

3. **SD-18: No Direct Handyman Account Required** (Approved: Building Care mediates)
   - The Tenant/PIC does not require a direct Handyman account or credentials.
   - The Building Customer Care actor mediates the care flow via backend session.
   - Single-use exchange token binds the decision to the real Tenant/PIC without
     requiring Tenant login to Handyman.
   - **Impact**: Frontend workflow does not require Tenant Handyman authentication.
     Care decision recording works through Building Care–only mediation.

4. **SD-19: recordedByUserId from Authenticated Session** (Approved: Session-derived only)
   - The `recordedByUserId` in care decision records is derived from the authenticated
     Backend session, NOT from any value supplied in the request body.
   - Request-body `recordedByUserId` is explicitly NOT trusted.
   - **Impact**: Backend service always overrides any client-supplied value with the
     session-derived user ID. This prevents Care from impersonating Tenant.

### Updated Decision-Making Process

The decision-makers for these new SD-IDs are the same as the existing table:
- Product Lead: SD-16, SD-17, SD-18, SD-19
- Security Lead: (no new decisions assigned)

All four decisions are **Approved** for this session and marked as binding design
constraints. No code changes should proceed without these decisions resolved.
## Decision Rationale Summary

### High-Priority Decisions (Must Be Approved Before Implementation)

1. **SD-01: PSrE Necessity** (Proposed — session default, NOT business-approved: Option A default)
   - The recommended minimum secure model is Option A (authenticated electronic approval with recorded evidence) without requiring PSrE for every contract.
   - PSrE should remain as an optional pathway for high-value/government contracts where explicitly required by policy.
   - **Impact**: Frontend signature tool integration; backend validation logic supports both modes but defaults to authenticated e-signature.

2. **SD-02: Nonce Expiry** (Proposed — session default, NOT business-approved: 5 minutes)
   - Shorter expiry (5 min) reduces replay attack window but increases user friction (may need to re-fetch challenge).
   - Longer expiry (15 min) improves UX but increases security risk.
   - **Impact**: Frontend countdown timer; backend challenge storage/expire logic.

3. **SD-04: rejectReason Mandatory** (Proposed — session default, NOT business-approved: Mandatory)
   - Ensures complete rejection records for operational follow-up and legal compliance.
   - Optional would simplify UI but lose reason context.
   - **Impact**: REJECT form always requires text input; backend validation enforces non-empty.

4. **SD-10: Concurrent ACCEPT** (Proposed — session default, NOT business-approved: 409 Error)
   - optimistic concurrency via BAST UPDATE `WHERE status = expectedFromStatus` ensures only one writer wins.
   - Last-write-wins would risk inconsistent state; error forces explicit handling.
   - **Impact**: Frontend retry logic on 409; backend already has this guard from existing patterns.

### Medium-Priority Decisions

5. **SD-03: Signature Algorithms** (Proposed — session default, NOT business-approved: ECDSA P-256 / P-384)
   - Supports both P-256 (faster, smaller signatures) and P-384 (higher security margin).
   - P-256 only would limit some enterprise customers; RSA would require different verification logic.
   - **Impact**: E-signature tool configuration; backend verification supports both.

6. **SD-06 / SD-07: Step-Up Verification Scope** (Proposed — session default, NOT business-approved: All external, waivable internal)
   - External customers always go through challenge-response.
   - Internal Customer Care actors with fully validated SSO sessions may have challenge waived.
   - Prevents "insider threat" while maintaining UX for trusted internal users.
   - **Impact**: Middleware check `isInternalVerifiedActor` before skipping challenge.

7. **SD-08: Warranty Auto-Start** (Proposed — session default, NOT business-approved: Not immediate)
   - ACCEPT does NOT immediately auto-start warranty.
   - Separate warranty initialization flow required after ACCEPT.
   - **Impact**: Frontend workflow after ACCEPT — show "Warranty can be initialized separately" message.

### Lower-Priority Decisions (Can Be Refined Later)

8. **SD-11: PSrE Migration Path** (Pending — Legal; NOT business-approved)
   - Existing ACCEPTed BASTs remain valid without PSrE.
   - PSrE only for new contracts or contract renewals.
   - Decision can be refined after initial implementation.

9. **SD-12: Multi-Language Payload** (Proposed — session default, NOT business-approved: English only)
   - Technical payload in English; no i18n required.
   - Customer signs technical identifiers; not human-readable copy.
   - **Impact**: Simplifies backend; no locale-specific payload generation.

10. **SD-13: Challenge Signature Format** (Proposed — session default, NOT business-approved: Raw base64url)
    - Raw ECDSA signature in base64url; no JWS overhead.
    - Simpler verification; supported by all major e-signature toolkits.
    - **Impact**: Frontend signature tool integration uses base64url output.

11. **SD-14: Idempotency Key Generation** (Proposed — session default, NOT business-approved: Backend generates + returns)
    - Backend generates UUID v4 in challenge response; frontend stores and returns.
    - Ensures key uniqueness; frontend may generate own but risk of collision.
    - **Impact**: Challenge endpoint returns `challenge.idempotencyKey`; frontend passes it back.

12. **SD-15: Evidence Record Visibility** (Proposed — session default, NOT business-approved: Summary only)
    - Customer sees "Evidence linked: yes/no" but not file details, SHA256 digests, or upload metadata.
    - Full evidence details remain server-side.
    - **Impact**: Frontend sign-off panel shows evidence linkage status without exposing forensic details.

---

## Decision-Making Process

1. **All decisions documented here** — no assumptions carried forward as implicit defaults.
2. **Decision maker ASSIGNED PER DOMAIN (no approval recorded yet for SD-01…SD-15)**:
   - Product Lead: SD-01, SD-02, SD-04, SD-05, SD-06, SD-08, SD-10, SD-11 (partial), SD-12, SD-15
   - Security Lead: SD-03, SD-07, SD-13, SD-14
   - Ops Lead: SD-08
   - Legal (pending): SD-11 (migration path)
3. **This session default** — an Arena session default only. It can be (and for
   SD-01…SD-15 must be) revised or ratified by product/organization leadership
   BEFORE any of it becomes runtime authority.
4. **No decision is "assumed"** — every code change must account for the decided option, and the decision must be recorded in this document.
5. **Decisions can be revised** — if product/organization leadership revises a decision, the implementation must be updated accordingly (this is expected; the design is iterative).

## Final Note

The mandate explicitly states: "Do not commit business-policy assumptions as authoritative." This document ensures all policy decisions are made explicit, recorded, and traceable. No code changes should proceed without corresponding decisions resolved for affected SD-IDs.