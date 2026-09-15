#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 01 — splice Housekeeping OpenAPI fragments into openapi.yaml."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"
FRAG_PATHS = ROOT / "scripts/cr-be-mob-01-part01-openapi-fragment.yaml"
FRAG_SCHEMAS = ROOT / "scripts/cr-be-mob-01-part01-openapi-schemas.yaml"

TAG = """  - name: Housekeeping
    description: >-
      CR-BE-MOB-01 PART 01 — existing BE-11 Housekeeping operational contract
      for mobile. Daily cleaning is a read view of BE-07 generated tasks;
      execution writes remain `startTask` / `completeTask` / `cancelTask`.
      Toilet and public-area inspections bind a Cleaning Area to a BE-07
      checklist template and start a shared checklist execution. Supervisor
      inspection and quality audit provide pass/fail/rework decisions via the
      BE-07 review primitive. Housekeeping findings bind HK sources to a
      BE-09 Finding (rework stays on finding operations). Evidence is a
      BE-11I binding over BE-07 evidence metadata. Building isolation
      (BE-02G) is enforced on every route. This tag does not invent a
      housekeeping engine, reinspection lifecycle, or consumable stock-out.
"""

PARAMS = """    DailyCleaningIdPath:
      name: id
      in: path
      required: true
      description: Daily cleaning id — the BE-07 generated task id.
      schema: { $ref: "#/components/schemas/Uuid" }
    CleaningAreaIdPath:
      name: id
      in: path
      required: true
      description: Cleaning Area id.
      schema: { $ref: "#/components/schemas/Uuid" }
    ToiletInspectionBindingIdPath:
      name: id
      in: path
      required: true
      description: Toilet inspection binding id.
      schema: { $ref: "#/components/schemas/Uuid" }
    ToiletInspectionExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 checklist execution id started from a toilet binding.
      schema: { $ref: "#/components/schemas/Uuid" }
    PublicAreaInspectionBindingIdPath:
      name: id
      in: path
      required: true
      description: Public-area inspection binding id.
      schema: { $ref: "#/components/schemas/Uuid" }
    PublicAreaInspectionExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 checklist execution id started from a public-area binding.
      schema: { $ref: "#/components/schemas/Uuid" }
    SupervisorInspectionIdPath:
      name: id
      in: path
      required: true
      description: Supervisor inspection id.
      schema: { $ref: "#/components/schemas/Uuid" }
    QualityAuditIdPath:
      name: id
      in: path
      required: true
      description: Quality audit id.
      schema: { $ref: "#/components/schemas/Uuid" }
    HousekeepingFindingIdPath:
      name: id
      in: path
      required: true
      description: Housekeeping finding link id (not the BE-09 finding id).
      schema: { $ref: "#/components/schemas/Uuid" }
    HousekeepingEvidenceSourceTypePath:
      name: sourceType
      in: path
      required: true
      schema: { $ref: "#/components/schemas/HousekeepingEvidenceSourceType" }
    HousekeepingEvidenceSourceIdPath:
      name: sourceId
      in: path
      required: true
      description: Source record id matching sourceType.
      schema: { $ref: "#/components/schemas/Uuid" }
"""


def main() -> None:
    text = SPEC.read_text()
    if "operationId: listBuildingDailyCleaning" in text:
        print("already spliced")
        return

    marker = "      Location and asset references use canonical backend ids only; Building\n      isolation (BE-02G) is enforced on every route (cross-Building access →\n      403 BUILDING_ACCESS_DENIED; unknown/inaccessible QR → the same 404 as\n      unknown, hiding existence).\n"
    if marker not in text:
        raise SystemExit("tag insertion marker not found")
    text = text.replace(marker, marker + "\n" + TAG, 1)

    paths = FRAG_PATHS.read_text()
    if not text.endswith("\n"):
        text += "\n"
    # insert paths immediately before components:
    needle = "\ncomponents:\n"
    idx = text.rfind(needle)
    if idx < 0:
        raise SystemExit("components: not found")
    text = text[:idx] + "\n" + paths + "\n" + text[idx + 1 :]

    # parameters after TeamIdPathParam block
    param_anchor = "    TeamIdPathParam:\n      name: teamId\n      in: path\n      description: Team id.\n      required: true\n      schema:\n        $ref: \"#/components/schemas/Uuid\"\n"
    if param_anchor not in text:
        raise SystemExit("TeamIdPathParam block not found")
    text = text.replace(param_anchor, param_anchor + PARAMS, 1)

    schemas = FRAG_SCHEMAS.read_text()
    if not text.endswith("\n"):
        text += "\n"
    text = text + "\n" + schemas
    if not text.endswith("\n"):
        text += "\n"
    SPEC.write_text(text)
    print("spliced housekeeping OpenAPI")


if __name__ == "__main__":
    main()
