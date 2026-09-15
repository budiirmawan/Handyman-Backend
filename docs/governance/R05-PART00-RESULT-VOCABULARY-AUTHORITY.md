# R05 PART 00 — Dynamic Checklist Result Vocabulary Authority
# Existing Authority & Contract Gap Review (NO CODING)

## BASELINE GATES

```
BRANCH    = arena/01a09121-asentra-backend
HEAD      = 7cfd4458a17fe7e89e124dc57795c629ba3ca2cc
REMOTE HEAD = 7cfd4458a17fe7e89e124dc57795c629ba3ca2cc
TREE      = clean (0 changed files)
```

HEAD == EXPECTED HEAD and working tree is clean. Proceed.

---

## 1. CHECKLIST ENGINE

Sources inspected:
- `src/database/migrations/0069_create_checklist_templates.ts`
- `src/database/migrations/0070_create_checklist_executions.ts`
- `src/database/migrations/0071_create_uom_measurements.ts`
- `src/modules/checklist-administration/checklist-administration.types.ts`
- `src/modules/checklist-administration/checklist-administration.validation.ts`
- `src/modules/checklist-executions/checklist-execution.service.ts`

```
ITEM TYPES              = 'CHECK' | 'BOOLEAN' | 'TEXT' | 'NUMBER'   (CHECK constraint)
RESULT COLUMN TYPE      = checklist_item_responses.result TEXT      (NO CHECK/enum)
RESULT ALLOWED VALUES   = UNRESTRICTED — any string or NULL accepted by service
VALUE COLUMN TYPE       = checklist_item_responses.value JSONB
                          - CHECK/BOOLEAN → boolean  (isValidResponseValue)
                          - NUMBER        → number
                          - TEXT          → string
                          (there is no 'SELECT' item type in checklists)
UOM SUPPORT             = YES — checklist_items.uom_id (FK units_of_measure),
                          minimum_value NUMERIC, maximum_value NUMERIC,
                          decimal_precision INTEGER
MIN/MAX SUPPORT         = YES at DDL level (CHECK minimum_value <= maximum_value)
                          — NOT enforced in write-path evaluation; write service
                          only type-checks (typeof==='number').
EXPECTED VALUE SUPPORT  = NO — no expected_value, target_value, reference_value
                          column on checklist_items.
N/A SUPPORT             = NO — no N/A flag, no result enum member, no NULL-skip
                          option on the item. null value is simply an
                          unanswered item; required-item completion check
                          treats NULL responses as missing.
OPTION SET SUPPORT      = NO — no checklist_item_options table; no JSONB options
                          column; no way to author a bounded list of allowed
                          answer strings. CHECKLIST ITEM TYPES DO NOT INCLUDE
                          'SELECT' or any multiple-choice analog.
PASS/FAIL EVALUATION    = NO — backend does not compute PASS/FAIL from value
                          vs min/max/UOM or against any reference. The
                          `result` column is written verbatim from the client
                          payload (entry.result ?? null) with zero server
                          validation. It is effectively a free-text tag the
                          caller can set to anything ('PASS','FAIL','OK',
                          'YA','TIDAK','B','K','R', arbitrary).
BUSINESS SEMANTIC METADATA = NO — no semantic_category, evaluation_rule,
                              severity, finding_policy, requires_note,
                              requires_evidence_by_result column on
                              checklist_items. (Evidence requirements live in
                              a separate cross-cutting evidence_requirements
                              table attached at target type/id with no
                              result-value predicate.)
```

Classification of raw response examples ("YA","TIDAK","B","K","R","OK","NOT_OK",
"NORMAL","ABNORMAL", "YES","NO","GOOD","REPAIR","REPLACE","PASS","FAIL","N/A"):

**D. free-form text** — they cannot be modelled as governed metadata (A),
schema enum (B), or domain code (C) because:
- DDL: `result TEXT` has no CHECK constraint;
- service: `saveChecklistResponses` writes `entry.result ?? null` directly
  with no whitelist, no normalization, no evaluation;
- administration: the item create/update input schemas contain no option set,
  no result vocabulary, no expected-value field;
- item types include no SELECT/MULTI_CHOICE;

therefore any such value reaching the database is a caller-supplied string
with no authoritative mapping. Option **E (not supported)** also applies to
options-as-metadata: the engine cannot even declare that an item is
constrained to {YA, TIDAK}.

---

## 2. FORM ENGINE

Sources inspected:
- `src/database/migrations/0063_create_source_forms.ts`
- `src/database/migrations/0064_create_form_templates.ts`
- `src/database/migrations/0065_create_form_sections_fields.ts`
- `src/database/migrations/0066_create_form_template_versions.ts`
- `src/database/migrations/0067_create_form_instances_responses.ts`
- `src/database/migrations/0068_create_form_conditions_repeatables.ts`
- `src/database/migrations/0071_create_uom_measurements.ts`
- `src/modules/form-administration/form-administration.types.ts`
- `src/modules/form-administration/form-administration.validation.ts`
- `src/modules/form-instances/form-instance.service.ts`
- `src/modules/form-template-versions/form-template-version.routes.ts`

```
FIELD TYPES            = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'DATE' |
                         'DATETIME' | 'BOOLEAN' | 'SELECT'   (CHECK constraint)
SELECT OPTION AUTHORITY = MISSING — no form_field_options table; no JSONB
                          options/optionSet column on form_fields or on
                          form_template_version_fields. The ADMIN
                          CreateFieldInput/UpdateFieldInput schemas accept
                          uomId/min/max/precision but no options array.
OPTION VALUE/LABEL MODEL = NOT MODELED — there is no persisted option id,
                           code, label, sort_order, or semantic metadata.
BOOLEAN SEMANTICS       = Primitive boolean only (value JSONB typeof ===
                          'boolean'). No configurable true/false label, no
                          third state, no tie to pass/fail.
NUMBER + UOM SUPPORT    = form_fields has uom_id/minimum_value/maximum_value/
                          decimal_precision (added in migration 0071, same
                          CHECK as checklist). Values accepted as number
                          JSON; range is NOT evaluated server-side on write.
MIN/MAX SUPPORT         = Stored as metadata; enforcement at write time is
                          type-only (typeof==='number'). No out-of-range
                          rejection.
EXPECTED VALUE SUPPORT  = NO — no expected/reference/target value column.
RESULT/EVALUATION SUPPORT = NO — form_responses has only (value JSONB); no
                          `result` column exists on form_responses at all.
                          No pass/fail, no normal/abnormal, no evaluation
                          output is authored by the form engine.
N/A SUPPORT             = NO — no N/A flag, no N/A result value, no option-
                          level isNa marker. null value means unanswered.
BUSINESS SEMANTIC METADATA = NO — no semantic category, no evaluation rule,
                              no finding policy, no requires_note by option.
                              Only evidence_requirements (target-scoped,
                              not option- or result-scoped) exist
                              orthogonally.
```

SELECT options classification: **missing / unverified**. The field_type
'SELECT' exists and is accepted at write-time as a string value, but the
backend never defines what the allowed set is, never validates submitted
values against any list, and never persists options version-to-version.
The platform effectively treats SELECT as "free-form string with a
different UI hint."

---

## 3. MEASUREMENT SEMANTICS

```
MEASUREMENT VALUE AUTHORITY = PARTIAL
  - form_fields / checklist_items: uom_id (FK units_of_measure),
    minimum_value, maximum_value, decimal_precision (migration 0071).
  - units_of_measure: client-scoped code/name/symbol/category.
  - Response value is stored as number (NUMBER type) in JSONB.
  - Write validation: typeof === 'number' only; min/max are NOT enforced.
REFERENCE VALUE AUTHORITY = MISSING
  - No expected_value / target_value / reference_value column exists on
    form_fields or checklist_items.
MIN/MAX AUTHORITY = PARTIAL
  - Stored at template (not version) level; not enforced on write.
UOM AUTHORITY = READY (template-level)
  - Client-managed register exists; FK is in place.
  - CRITICAL GAP: the form-template-version snapshot
    (form_template_version_fields) created at PUBLISH does NOT include
    uom_id / minimum_value / maximum_value / decimal_precision (see
    form-template-version.routes.ts INSERT column list). Historical form
    instances therefore do NOT pin the UOM/range that was active at
    execution time.
EVALUATION AUTHORITY = MISSING
  - No backend function computes pass/fail, within-range, normal/abnormal
    from (value, uom, min, max). The only place range is used is the
    DDL CHECK that minimum <= maximum on the template definition.
  - Existing housekeeping-report aggregates hard-code 'PASS'/'FAIL'/
    'REWORK_REQUIRED' by reading quality_audits.result — a separate,
    hard-coded enum on a separate quality_audits table
    (migration 0118), not derived from checklist/form responses.
```

CRITICAL: There is no server-side logic that treats an out-of-range numeric
value as FAIL (or anything else). Report-side semantics such as "value
outside min/max → non-compliant" would be Reporting-invented and must not
be introduced.

---

## 4. N/A SEMANTICS

```
N_A REPRESENTATION = NOT SUPPORTED
  - No 'N/A' or 'NOT_APPLICABLE' enum member in result CHECKs (there is
    no result enum for checklists and no result column at all for forms).
  - No boolean is_na / not_applicable flag on responses.
  - No option-level N/A marker in template metadata (no option table).
  - null value is reserved for "unanswered" by the required-item
    completion logic and is therefore NOT a safe N/A encoding.
  - A free-text result === 'N/A' is physically writable but is not a
    governed value (the backend won't treat it differently, and other
    clients could write 'N.A.', 'NA', 'TIDAK TERSEDIA', etc.).
N_A REASON        = NOT SUPPORTED (no na_reason column; notes is a generic
                    free-text field on checklist_item_responses only, not
                    N/A-specific; no reason is required).
AUTHORITATIVE     = NO
```

---

## 5. CONDITION VOCABULARY

Existing generic concepts in the platform relevant to result semantics:

| Concept | Where | Scope |
|---|---|---|
| PASS / FAIL / REWORK_REQUIRED | `quality_audits.result` (migration 0118) with CHECK constraint | Housekeeping quality audits only; not applied to checklist_item_responses or form_responses. |
| Pass/fail aggregates | `housekeeping-reports.repository.ts` lines 185-187, 118, 141 | Read-side count aggregation over quality_audits; not authoring semantics for the form/checklist engines. |
| Open/In-progress/rework/verified/closed finding statuses | `findings` table (migrations 0090, 0094) | Finding lifecycle state; NOT a response vocabulary. |
| Compliant / non-compliant | — | NOT modeled. |
| Normal / abnormal | — | NOT modeled. |
| Good / dirty / damaged | — | NOT modeled. |
| Yes / no (as semantic) | — | NOT modeled (only BOOLEAN primitive exists, with no domain label). |
| Repair / replace | — | NOT modeled. |
| B / K / R | — | NOT modeled. |
| YA / TIDAK | — | NOT modeled. |
| OK / NOT_OK | — | NOT modeled. |
| Observation / exception | — | Finding classification/severity exists in migration 0091; not attached to individual responses. |

There is **no unified condition/result enum** and no metadata hook to attach
one to a checklist item or form field. Any Reporting aggregation that groups
e.g. "YA" with "YES" or "B" with "PASS" would be fabrication.

---

## 6. DOMAIN-SPECIFIC EXAMPLES

Two domains were inspected (within the audit limit):

### 6a. Housekeeping (inspection/report)
- `src/modules/housekeeping-reports/housekeeping-report.repository.ts` — reads
  checklists/form instances via generic tables; aggregates
  `quality_audits.result IN ('PASS','FAIL','REWORK_REQUIRED')` for supervisor
  quality audits (a separate entity, NOT checklist_item_responses.result).
- Stores: raw answer via generic `checklist_item_responses` / `form_responses`
  (free-form); separate supervisor decision on `quality_audits.result` is
  enum-backed.
- Finding linkage: `housekeeping_finding_links` binds a Finding to a
  housekeeping source (DAILY_CLEANING / TOILET_INSPECTION / PUBLIC_AREA_INSPECTION
  / SUPERVISOR_INSPECTION) by source_type+source_id. The finding is created
  by a caller, NOT auto-derived from a response value.
- Domain characterization: **(1) raw answer only** at the checklist/form
  response layer; **(3) finding generated separately** via housekeeping
  links; no (2) semantic result, (4) calculated pass/fail at response
  level, (5) generic condition value, (6) measurement evaluation.

### 6b. Patrol / Security
- `src/modules/patrol-executions/*` — patrol route + point visits; point
  visits record visitedAt/visitedBy/status (VISITED/INACTIVE) and attach
  checklist_executions via bindings, but the engine uses generic
  checklist_item_responses for inspection answers.
- Finding linkage: `security_finding_links` binds Finding to
  PATROL_EXECUTION / PATROL_CHECKLIST / SECURITY_DAILY_ACTIVITY /
  SHIFT_HANDOVER / SECURITY_POST — again manually created, not auto-derived.
- Domain characterization: **(1) raw answer only** at the response layer;
  **(3) finding generated separately**. No B/K/R or YA/TIDAK coding exists
  in backend domain logic.

Engineering-daily-operations inspected for completeness and only exposes
read lists of tasks/work orders/findings; it does not author response
semantics.

---

## 7. VERSIONING

```
CHECKLIST RESULT VERSIONING = N/A (no result metadata to version)
  - Checklist templates have no version concept at all; edits to
    checklist_items (label, item_type, required, uom_id, min/max)
    mutate the row in place. Existing checklist_item_responses point to
    checklist_item_id by FK, so a template edit changes what future
    responses mean and can retroactively alter the semantics of a
    historical response read alongside the current item definition.
FORM OPTION VERSIONING = MISSING / BROKEN FOR MEASUREMENT METADATA
  - Form templates DO have versions (form_template_versions + sections +
    fields snapshot on publish via form-template-version.routes.ts).
  - BUT the versioned snapshot (form_template_version_fields) only copies
    code/label/field_type/required/display_order/placeholder/help_text/status.
    It does NOT snapshot uom_id/minimum_value/maximum_value/decimal_precision
    (migration 0071 added these to form_fields only, and no subsequent
    migration or publish logic copies them into the version snapshot).
  - There is also no options table to snapshot, so SELECT semantics have
    nothing to version.
HISTORICAL LABEL STABILITY = MISSING
  - Checklist: no version → labels mutate in place → HISTORICAL LABELS GAP.
  - Form: code/label are snapshotted at publish → labels for versioned
    fields are stable for already-published versions; however any
    newly-published version re-snapshots current labels, and older
    form_instances pinned to older version_ids retain their labels.
HISTORICAL SEMANTIC STABILITY = MISSING
  - Checklist: item_type / required / uom / range can be edited on the
    live row → historical executions can be reinterpreted.
  - Form: field_type/required are snapshotted; UOM/range are NOT; there is
    no semantic category / evaluation / option set to version.
```

**Classification: HISTORICAL SEMANTICS GAP** for checklists AND for form
measurement metadata (UOM/min/max/precision not snapshotted on publish).

---

## 8. FINDING RELATIONSHIP

Sources: migrations 0090, 0092, 0109, 0116, 0128; engineering/housekeeping/
security finding link tables.

```
RESULT → FINDING BEHAVIOR = manually created / unrelated
```

- `findings` rows are created explicitly with reported_by_user_id; they
  optionally reference a source (source_type IN ('FORM_INSTANCE',
  'CHECKLIST_EXECUTION', 'WORK_ORDER')) via generic source binding, and
  domain-specific link tables (engineering_finding_links,
  housekeeping_finding_links, security_finding_links) carry domain context.
- No backend trigger, service method, or policy automatically creates a
  Finding when a checklist_item_response or form_response is saved with a
  particular value/result. There is no "finding_policy" or "auto_finding"
  metadata on items/fields.
- Therefore: a raw response value of "ABNORMAL", "NOT_OK", "R", "TIDAK",
  false BOOLEAN, out-of-range number, etc. does NOT imply a Finding exists.
  Reporting must rely ONLY on explicit Finding linkage (join to findings
  via source_type/source_id or the domain-specific link tables).

---

## 9. READINESS MATRIX

| CAPABILITY | STATUS |
|---|---|
| Raw checklist response | READY (value JSONB typed per item_type; result column is raw string)|
| Checklist allowed options | MISSING (no option set; no SELECT item type) |
| Checklist stable option codes | MISSING |
| Checklist display labels | PARTIAL (label snapshotted only implicitly because responses point to item_id; labels can be mutated in place → historical drift) |
| Checklist semantic category | MISSING |
| Checklist evaluation | MISSING (result free-text, unvalidated, uncomputed) |
| Checklist N/A | MISSING |
| Form SELECT options | MISSING (field_type exists but no option register, no validation) |
| Form stable option codes | MISSING |
| Form display labels | READY for versioned forms (snapshotted in form_template_version_fields at publish); MISSING for unversioned semantics |
| Form semantic category | MISSING |
| Measurement actual | READY (NUMBER stored as numeric JSON; type-validated)|
| Measurement reference/range | PARTIAL (min/max on template; no expected/reference value; range not enforced on write; range NOT snapshotted in form version)|
| Measurement UOM | PARTIAL (uom FK on template; NOT snapshotted in form version → historical-drift risk) |
| Measurement evaluation | MISSING (no pass/fail or normal/abnormal computation)|
| Historical result semantics | MISSING (no checklist version; form version omits UOM/range; no semantic metadata exists to version) |
| Finding linkage | READY (findings.source_type/source_id + domain link tables; explicit, never inferred) |

---

## 10. REPORTING REQUIREMENT TRACE

Reporting needs (verbatim):

| Need | Status |
|---|---|
| RAW RESPONSE (exact recorded value) | READY — expose `checklist_item_responses.value::jsonb` and `form_responses.value::jsonb` verbatim. |
| DISPLAY LABEL (user-facing value) | MISSING for SELECT (no label register); READY for BOOLEAN/NUMBER/TEXT (render as-is). For checklists, the *item label* is partially stable but the *response value* for CHECK/BOOLEAN/TEXT/NUMBER has no separate display label. |
| SEMANTIC CATEGORY | MISSING — backend does not provide one; Reporting MUST NOT invent. |
| EVALUATION | MISSING — backend does not compute one; Reporting MUST NOT infer from min/max or from free-text result. |
| MEASUREMENT (actual/reference/UOM) | PARTIAL — actual is READY; UOM readable from template (with historical-drift caveat on forms); no reference value exists. |
| EXCEPTION/FINDING | READY via Finding linkage tables — Reporting must join findings via source_type/source_id + domain link tables, never infer from result. |

---

## 11. DECISION

**C. RESULT VOCABULARY DATA/CONTRACT GAP**

Primary rationale:
1. Checklist engine has no SELECT/MULTI_CHOICE item type and no allowed-values
   metadata; the `result` column is a free-text tag with no enum, no
   validation, and no server-side evaluation. Examples like YA/TIDAK/B/K/R/OK/
   NOT_OK/NORMAL/ABNORMAL/PASS/FAIL cannot be distinguished, validated,
   mapped, or rendered with labels authoritatively.
2. Form engine declares a 'SELECT' field_type but has no option register
   (no form_field_options, no JSONB options column). SELECT values are
   accepted as free strings with no validation.
3. Measurement metadata (UOM, min, max, precision) is not snapshotted into
   `form_template_version_fields` at publish, so historical form instances
   cannot read the UOM/range that applied when the instance was executed.
4. Checklists have no versioning at all; label/uom/min/max/item_type/required
   mutate in place, creating historical-semantics drift.
5. There is no expected/reference value, no evaluation engine, no N/A
   concept, no semantic-category metadata, no result-driven finding policy.
6. Domain modules (housekeeping, security/patrol, engineering) do not add
   response semantics — they only attach manually-created Findings to
   sources. Housekeeping's apparent PASS/FAIL/REWORK_REQUIRED vocabulary
   lives on a separate `quality_audits` table with a hard-coded CHECK,
   not on checklist/form responses.

UNIVERSAL B/K/R → PASS/FAIL MAPPING IS EXPLICITLY PROHIBITED.
Likewise YA/TIDAK → YES/NO, OK/NOT_OK → PASS/FAIL, NORMAL/ABNORMAL →
compliant/non-compliant, or any other cross-vocabulary collapse is
prohibited unless/until template metadata (R05-G1 or a later governance
part) defines the mapping authoritatively. Reporting, renderers, and
downstream projections MUST treat option codes as opaque stable
identifiers and MUST NOT invent equivalences.

Option D ("MULTIPLE DOMAIN SEMANTICS — NO UNIVERSAL NORMALIZATION") is NOT
chosen because no domain-level semantic model exists to expose at the
per-response layer; the response layer is uniformly free-text. The
finding-linkage/quality-audit vocabularies are small, scoped, and clearly
separated; they are not substitutes for per-response semantics.

---

## 12. SMALLEST BACKEND CLOSURE (recommendation only — NO CODING)

This is the smallest addition that (a) closes the gaps Reporting actually
hits, (b) does not build a universal normalization engine, (c) avoids
domain hardcoding, (d) preserves history, and (e) is version-stable. It is
described here for scoping; implementation is explicitly out of scope for
R05 PART 00.

```
BACKEND GAP ID = R05-G1 (Response Option & Evaluation Metadata)
OBJECTIVE =
  Give checklist items and form fields an explicit, version-stable way to
  declare allowed values, their display labels, optional stable codes, and
  optional client-selected semantic tags — without inventing a universal
  PASS/FAIL or normal/abnormal vocabulary and without forcing B/K/R → P/F
  equivalence. Evaluation (pass/fail) and finding auto-creation remain
  explicitly OUT OF SCOPE for R05 PART 01.
AUTHORITATIVE ENTITY TO EXTEND/ADD =
  1. ADD TABLE checklist_item_options (id, checklist_item_id, code,
        label, display_order, status) — only consulted when a new column
        checklist_items.option_set_type = 'FIXED' (default 'FREE'). Existing
        TEXT/NUMBER/BOOLEAN/CHECK items continue to operate unchanged.
     ADD COLUMN checklist_items:
        option_set_type TEXT NOT NULL DEFAULT 'FREE'
          CHECK (option_set_type IN ('FREE','FIXED')),
        is_na_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        na_requires_note BOOLEAN NOT NULL DEFAULT FALSE,
        (expected_value / semantic_category / evaluation / finding_policy
         are DEFERRED.)
  2. ADD TABLE form_field_options (id, form_field_id, code, label,
        display_order, status).
     ADD COLUMN form_fields:
        option_set_type TEXT NOT NULL DEFAULT 'FREE'
          CHECK (option_set_type IN ('FREE','FIXED')),
        is_na_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        na_requires_note BOOLEAN NOT NULL DEFAULT FALSE.
  3. EXTEND form_template_version_fields (and publish snapshot logic in
     form-template-version.routes.ts / form-administration) to SNAPSHOT:
        uom_id, minimum_value, maximum_value, decimal_precision,
        option_set_type, is_na_allowed, na_requires_note
     AND ADD form_template_version_field_options (one row per selected
        option at time of publish, referencing version_field_id, carrying
        stable code + label + display_order + status).
  4. EXTEND checklist write path saveChecklistResponses to validate
     response values against checklist_item_options when
     option_set_type='FIXED', and to accept {value, isNa:boolean, naReason}
     for items where is_na_allowed=true (or equivalent).
  5. EXTEND form write path saveFormResponses to validate SELECT values
     against form_template_version_field_options for the instance's
     version, and accept {value, isNa, naReason} when allowed.
  6. Do NOT add a universal semantic-category enum in this closure.
     Semantic meaning continues to come from (a) stable option code,
     (b) template identity, (c) domain code reading its own templates.
MIGRATION REQUIRED = YES
   - New tables checklist_item_options, form_field_options,
     form_template_version_field_options.
   - ALTER TABLE checklist_items ADD option_set_type, is_na_allowed,
     na_requires_note.
   - ALTER TABLE form_fields ADD option_set_type, is_na_allowed,
     na_requires_note.
   - ALTER TABLE form_template_version_fields ADD uom_id, minimum_value,
     maximum_value, decimal_precision, option_set_type, is_na_allowed,
     na_requires_note (nullable; backfill from current form_fields for
     already-published versions, accepting that historical UOM/range
     cannot be perfectly reconstructed for pre-closure versions).
   - ALTER TABLE checklist_item_responses ADD is_na BOOLEAN, na_notes TEXT
     (nullable); NOT overloading `notes` or using sentinel result strings.
   - ALTER TABLE form_responses ADD is_na BOOLEAN, na_notes TEXT,
     occurrence_id (already exists).
WRITE PATH IMPACT =
   - saveChecklistResponses: option validation + isNa handling when flag
     is set; otherwise zero change to existing FREE items.
   - saveFormResponses: SELECT value validation against versioned option
     set + isNa handling.
   - Admin create/update item/field: accept options[] when option_set_type
     = FIXED; persist options rows; forbid options on NUMBER/TEXT/
     BOOLEAN/CHECK if appropriate (or allow BOOLEAN-override semantics
     as a deliberate choice).
READ PATH IMPACT =
   - Existing read endpoints and checklist-execution-summary continue to
     return raw value/result verbatim; new optional columns
     (selectedOptionCode, selectedOptionLabel, isNa, naReason) exposed
     only to clients that opt in; Reporting R05 work reads the versioned
     option metadata for display labels.
HISTORICAL EXECUTION IMPACT =
   - Pre-closure executions/instances: value/result retained as-is; new
     columns null. option_set_type defaults to 'FREE' so existing
     responses remain valid. Historical form instances created before
     the version-field uom/option snapshot will have NULL for those
     snapshotted fields; Reporting treats them as "metadata unknown,
     expose raw value only" — fail-closed.
MAX PRACTICAL FILES = ~10-14
   - 3 migrations (options tables + column adds; snapshot backfill;
     response columns).
   - 2 admin types/validation/repository/service files (checklist-admin
     and form-admin each) ≈ 4 files.
   - 2 write-service updates (checklist-execution.service,
     form-instance.service).
   - 2 types files for new option rows.
   - 1 form-template-version publish-snapshot update.
   - Repository updates (no new engine module).
   - No Reporting changes in this closure (Reporting reads only).
FOCUSED TEST =
   - Option validation at write (FIXED set rejects unknown code; FREE set
     accepts any value as today).
   - N/A happy/sad paths: isNa=true requires naReason iff flag set; N/A
     clears value; cannot set isNa when is_na_allowed=false.
   - Form publish snapshots options + uom/min/max/precision; editing
     live field post-publish does not mutate already-published version.
   - Historical response (pre-migration) reads back raw with null option
     fields.
   - Backfill of form_template_version_fields uom/range for already-
     published versions is idempotent.
   - Required-item logic interacts correctly with isNa (N/A satisfies
     required if allowed).
WHAT REMAINS DEFERRED =
   - Expected/reference value, semantic categories (compliant/abnormal/
     repair/replace/etc.), server-side evaluation (pass/fail at write
     time), auto-Finding from result, result-driven evidence/notes
     requirement, any universal result enum, any translation of B/K/R
     into PASS/FAIL, any Reporting-side normalization, KPI/SLA/risk
     derivations. All are explicitly out of scope until a future
     governance part justifies them with concrete policy/template
     metadata; they must NOT be inferred from raw values.
```

---

## EXCLUSIONS OBSERVED

No Reporting implementation, renderer, executor attribution, dashboard,
frontend/mobile, KPI, SLA, overdue, or risk code was touched or produced.
No domain hardcoding (no Graha-Mampang-specific enum). No translation of
B/K/R into PASS/FAIL. No translation of YES/NO into compliant/non-compliant.
No migrations or code changes were applied; this document is governance
only. STOP.
