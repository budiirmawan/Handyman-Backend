#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 03 — splice Engineering OpenAPI fragments into openapi.yaml.

Publish-only: every path added here is already registered in
src/modules/**/*.routes.ts (BE-10A/B/C/D/E/F/G/H/J/K). The script is
idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"
FRAG_PATHS = ROOT / "scripts/cr-be-mob-01-part03-openapi-fragment.yaml"
FRAG_SCHEMAS = ROOT / "scripts/cr-be-mob-01-part03-openapi-schemas.yaml"

TAG = """  - name: Engineering
    description: >-
      CR-BE-MOB-01 PART 03 — existing BE-10 Engineering field / reading
      contract for mobile. Every BE-10 record is a binding or read model over
      an existing authority, never a second engine: equipment inspection and
      engineering checklist bindings start a shared BE-07 checklist execution;
      meter-reading and log-sheet bindings start a shared BE-07 form instance
      and write into BE-07 `form_responses`; planned maintenance (BE-10G)
      references a BE-07 Schedule, BE-07 generated Tasks and a BE-08 Work
      Order; corrective maintenance is a BE-10F breakdown plus a linked BE-08
      Work Order. PM/CM field execution is therefore the already published
      BE-08 Work Order action set and the BE-07 task operations — this tag
      adds no execution path. Evidence is the published BE-07 evidence API on
      the returned execution id (`executionType` CHECKLIST_EXECUTION or
      FORM_INSTANCE); supervisor review is the published review / mobile
      verification / Work Order verification surface; finding workflow stays
      on BE-09 keyed by `findingId`. Building isolation (BE-02G) and
      default-deny RBAC are enforced on every route. This tag invents no
      diagnosis or test-result domain, no per-reading review workflow, and no
      mobile-specific engineering API.
"""

PARAMS = """    InspectionBindingIdPath:
      name: id
      in: path
      required: true
      description: Equipment inspection binding id (BE-10B).
      schema: { $ref: "#/components/schemas/Uuid" }
    InspectionExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 checklist execution id started from an inspection binding.
      schema: { $ref: "#/components/schemas/Uuid" }
    MeterReadingBindingIdPath:
      name: id
      in: path
      required: true
      description: Meter reading binding id (BE-10C).
      schema: { $ref: "#/components/schemas/Uuid" }
    MeterReadingExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 form instance id started from a meter reading binding.
      schema: { $ref: "#/components/schemas/Uuid" }
    LogSheetBindingIdPath:
      name: id
      in: path
      required: true
      description: Equipment log sheet binding id (BE-10D).
      schema: { $ref: "#/components/schemas/Uuid" }
    LogSheetExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 form instance id for one log sheet row.
      schema: { $ref: "#/components/schemas/Uuid" }
    EngineeringChecklistBindingIdPath:
      name: id
      in: path
      required: true
      description: Engineering checklist binding id (BE-10E).
      schema: { $ref: "#/components/schemas/Uuid" }
    EngineeringChecklistExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 checklist execution id started from an engineering binding.
      schema: { $ref: "#/components/schemas/Uuid" }
    BreakdownIdPath:
      name: id
      in: path
      required: true
      description: Breakdown / corrective event id (BE-10F).
      schema: { $ref: "#/components/schemas/Uuid" }
    MaintenanceBindingIdPath:
      name: id
      in: path
      required: true
      description: Planned maintenance binding id (BE-10G).
      schema: { $ref: "#/components/schemas/Uuid" }
    EngineeringFindingIdPath:
      name: id
      in: path
      required: true
      description: Engineering finding link id (not the BE-09 finding id).
      schema: { $ref: "#/components/schemas/Uuid" }
    EngineeringShiftHandoverIdPath:
      name: id
      in: path
      required: true
      description: Engineering shift handover id (BE-10J).
      schema: { $ref: "#/components/schemas/Uuid" }
"""

TAG_ANCHOR = "  - name: Security\n"
PARAM_ANCHOR = """    OperationalIncidentIdPath:
      name: id
      in: path
      required: true
      description: Operational Incident id — the shared BE-21A Incident id.
      schema: { $ref: "#/components/schemas/Uuid" }
"""


def main() -> None:
    text = SPEC.read_text()
    if "operationId: startMeterReadingExecution" in text:
        print("already spliced")
        return

    if TAG_ANCHOR not in text:
        raise SystemExit("Security tag anchor not found")
    text = text.replace(TAG_ANCHOR, TAG + TAG_ANCHOR, 1)

    if PARAM_ANCHOR not in text:
        raise SystemExit("Security parameter anchor not found")
    text = text.replace(PARAM_ANCHOR, PARAM_ANCHOR + PARAMS, 1)

    needle = "\ncomponents:\n"
    idx = text.rfind(needle)
    if idx < 0:
        raise SystemExit("components: not found")
    paths = FRAG_PATHS.read_text()
    text = text[:idx] + "\n" + paths + "\n" + text[idx + 1 :]

    if not text.endswith("\n"):
        text += "\n"
    text = text + "\n" + FRAG_SCHEMAS.read_text()
    if not text.endswith("\n"):
        text += "\n"

    SPEC.write_text(text)
    print("spliced engineering OpenAPI")


if __name__ == "__main__":
    main()
