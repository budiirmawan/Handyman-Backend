# CR-HM-10 — Evidence / QC / Defect-Rectification — FINAL CERTIFICATION

Date: 2026-09-29 (Asia/Jakarta)
Branch: `arena/01a0e01e-handyman-backend`
Base commit: `094c3fd` (CR-HM-10 PART 06)

Governance reference: `CR-HM-10_START_GOVERNANCE.md` (FROZEN,
commit `4e2a2a2`).

## Certification record

```text
CR_HM_10_STATUS=COMPLETE
CR_HM_10_BLOCKERS=0
CR_HM_10_IMPLEMENTATION_DEFECTS=0
EVIDENCE_STAGE_CHECK_BOUNDARY=FROZEN-7
FM_COUPLING=NO
```

## Delivered parts

| Part | Commit | Deliverable |
| --- | --- | --- |
| Governance | `4e2a2a2` | start governance (FROZEN decisions D1–D10, 7-PART split, 0 blockers) |
| PART 02 | `bf53f80` | persistence foundation: ONE migration 0403 (8 tables `handyman_evidence_records` + `_files` + `_record_events`, `handyman_qc_runs` + `_run_items` + `_run_events`, `handyman_defect_records` + `_defect_events`); frozen CHECK vocabularies (7 evidence stages / 3 media kinds / 3 QC statuses / 4 outcomes / 4 defect statuses); partial-unique ONE-OPEN-per-scope index; (parent,event_type,idempotency_key) idempotency uniques; append-only triggers (files + 3 event tables); identity-mutation + head-no-DELETE guards; client-consistency + defect-provenance plpgsql triggers; capture_time CHECK ≤ NOW()+5min; domain-table firewall sweeps = 0 |
| PART 03 | `2b1a15e` | EVIDENCE commands: CREATE record (7-stage bounded; server-verified session binding), FILE_ADD (MIME/size/SHA-256/storage-key/capture-skew server-validated; pre-FINALIZE only), FINALIZE (locks the file set) + Lead-gated scope/detail reads |
| PART 04 | `7a23bd6` | QC commands: OPEN (ONE OPEN per scope; 409 on second), ITEM_SET (frozen 4-outcome vocabulary, upsert with append-only event history), FINISH (SERVER-evaluated PASSED/FAILED) + run/item read models; reopen forbidden (fresh OPEN = new row) |
| PART 05 | `98977d8` | DEFECT commands: OPEN_DEFECT (optional server-verified run/item provenance), START/RECORD_RECTIFICATION, REQUEST_REINSPECTION (loop), PASS_REINSPECTION (terminal VERIFIED, locked) + defect read models; zero commercial coupling |
| PART 06 | `094c3fd` | thin HTTP/OpenAPI: 16 bounded paths / 19 operations (10 commands + 6 reads), authentication-only middleware, whitelist parsers rebuilt, bounded serializers, OpenAPI parity swept |
| PART 07 | (this commit) | final certification (this document) + staleness-bound guard correction in the PART 02 suite (below) |

## Focused certification suites — 30/30 PASS

| Suite | Part | Tests |
| --- | --- | --- |
| `tests/handyman-evidence-qc.test.ts` | 02 | 6 |
| `tests/handyman-evidence-commands.test.ts` | 03 | 7 |
| `tests/handyman-qc-commands.test.ts` | 04 | 7 |
| `tests/handyman-defect-commands.test.ts` | 05 | 5 |
| `tests/handyman-evidence-qc-api.test.ts` | 06 | 5 |

5 suites, 30 tests, 0 failures (real migrated PostgreSQL 18.4,
`node --test` concurrency 1). Each PART suite passed in full at its
own landing. During certification, ONE staleness-bound guard in the
PART 02 suite surfaced: t6 asserted the PART 06 HTTP sibling module
(`src/modules/handyman-evidence-qc-api/`) did NOT exist — correct at
the PART 02 head, but lawfully false at the certification HEAD (the
FROZEN roadmap mandated exactly that later addition). The guard was
narrowed to its DURABLE frozen invariants, both still asserted and
re-verified: (a) the domain module ships NO controller/routes ever
(exact 5-file set incl. the PART 03 service); (b) the HTTP surface
exists EXCLUSIVELY as the `-api` sibling — the only two directory
entries allowed under the `handyman-evidence-qc*` namespace.
Test-precision flaw, NOT a runtime defect: NO runtime code was
changed during certification.

## Frozen invariants verified at certification

1. **Evidence stage boundary** — the DB CHECK admits EXACTLY the 7
   frozen stages (BEFORE/DURING/AFTER/QC/DEFECT/RECTIFICATION/
   MATERIAL); service rejects WARRANTY/BAST out-of-vocabulary input
   (400); the CHECK freezes the boundary (BAST/WARRANTY are
   RESERVED for later CRs, never string-mutated here).
2. **Evidence immutability** — files and all 3 event tables are
   append-only (trigger-blocked UPDATE/DELETE); record head identity
   (client/scope/session/stage), QC run identity (client/scope/
   session/checklist identity), and defect provenance (client/
   scope/run/item) are trigger-guarded immutables post-write; head
   DELETE is blocked on all three aggregates.
3. **FINALIZE lock** — the file set stays mutable ONLY until one
   FINALIZE event exists (implicit lifecycle — no status column);
   post-FINALIZE FILE_ADD/FINALIZE = bounded 409 ALREADY_FINALIZED;
   replay with the same key returns the SAME rows.
4. **Evidence file policy** — MIME mapped to the bounded
   evidence-engine mirror per media kind (PHOTO/DOCUMENT/VIDEO),
   size ≤ 52,428,800, SHA-256 64-hex digest required, managed
   storage-key discipline (server-detected, UNIQUE-enforced,
   conflict = 409), capture_time ≤ server-now + 5 minutes (service
   400 + DB CHECK backstop).
5. **QC ONE-OPEN window + server evaluation** — ONE OPEN run per
   scope (partial-unique index; second = 409); ITEM_SET is bounded
   to the frozen 4 outcomes, upserts per (run, item_key) while the
   append-only event chain keeps the full set-history; FINISH
   computes the terminal status SERVER-SIDE (PASSED iff every item
   is PASS or NA; any DEFECT or NOT_CHECKED → FAILED); runs are
   never reopened — a fresh OPEN mints a new row (additive history).
6. **Defect ladder** — OPENED → RECTIFYING → RECTIFIED → VERIFIED
   via the frozen 5-event vocabulary; REINSPECTION loops RECTIFIED →
   RECTIFYING; VERIFIED is locked (every later mutation = 409);
   defect run/item provenance is server-verified against the scope
   (cross-scope/cross-run = bounded 400, DB trigger backstop).
7. **Idempotent replay** — per (parent, event_type,
   idempotency_key); same key + same shape returns the SAME rows
   (`replayed: true`) without re-applying mutations; same key +
   different shape = bounded 409 conflict; every command is one
   transaction with a head row-lock (`SELECT … FOR UPDATE`).
8. **Authority** — every command/read: authenticated actor →
   client-access wall (403 BUILDING_ACCESS_DENIED) → scope 404 →
   CURRENT authoritative Crew Lead binding (403 *_NOT_AUTHORIZED —
   helper members insufficient); bounded error map
   400/401/403/404/409 end-to-end (HTTP proven in API tests).
9. **Zero commercial coupling — ZERO FM** — column-level and
   source-level sweeps re-verified at certification: no
   amount/currency/price/charge/billing/payment/invoice/rate column
   or token on any of the 8 tables, module sources, or `-api`
   payloads; the evidence storage seam is a VALUE binding
   (storage-key discipline only, never ORM); no FM FK graph and no
   FM module import (storage infra boundary excepted, as FROZEN);
   defect/QC state NEVER adjusts the CR-HM-09 settled basis.
10. **Thin HTTP/OpenAPI** — authentication-only middleware (no
    permission vocabulary invented); whitelist parsers rebuild
    bodies from scratch; authority-shaped keys (actorUserId/
    clientId/status/timestamps) structurally IGNORED (HTTP-walk
    proven); storage keys surfaced at append only, absent on reads;
    OpenAPI parity exact (16 paths / 19 operations / 3 parameters /
    27 schemas); exactly one router registration.

## Handoff

- **CR-HM-02 closure** — the sector evidence-intake seam's forward
  binding is delivered: a HANDYMAN_REQUEST may reference an
  intake-stage (BEFORE) Handyman evidence record once this module's
  evidence aggregate exists (value binding only; CR-HM-02 stays
  READ-ONLY).
- **CR-HM-11 (BAST & Customer Acceptance)** — consumes the
  Lead-gated read models (evidence records/files, QC runs + items,
  defect states) as SEQUENCED truth ONLY; acceptance gating policy
  belongs entirely to CR-HM-11.
- **CR-HM-13/17/18** — settled-basis consumers: this CR NEVER
  adjusts the CR-HM-09 FINAL_CHARGE_READY basis; defects/QC publish
  truthful states, financial computation stays with the financial
  CRs.
