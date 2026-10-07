#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 02 — splice Security OpenAPI fragments into openapi.yaml.

Publish-only: every path added here is already registered in
src/modules/**/*.routes.ts (BE-12A/B/C/D/E/F/H, BE-21A/B). The script is
idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"
FRAG_PATHS = ROOT / "scripts/cr-be-mob-01-part02-openapi-fragment.yaml"
FRAG_SCHEMAS = ROOT / "scripts/cr-be-mob-01-part02-openapi-schemas.yaml"

TAG = """  - name: Security
    description: >-
      CR-BE-MOB-01 PART 02 — existing BE-12 Security and BE-21A/B Incident
      operational contract for mobile. Security Posts, Patrol Routes and
      Patrol Route Points (the checkpoints) are operational context over the
      BE-04 structure — no second location hierarchy and no checkpoint
      master. A Patrol Execution is the Security view of a BE-07 generated
      task (`id` = `taskId`); start/complete delegate to the shared BE-07
      task-execution engine and patrol assignment is the published BE-07
      task-assignment surface. Checkpoint confirmation is by canonical
      `pointId` — there is no checkpoint QR/identifier authority. Patrol
      checklist bindings only start the shared BE-07 checklist execution;
      responses, completion, evidence and verification stay on the published
      BE-07 operations. Security findings bind a Security source to an
      authoritative BE-09 Finding (workflow keyed by `findingId`), and field
      reporting for a standalone event is the BE-21A/BE-21B Incident chain.
      Building isolation (BE-02G) and default-deny RBAC are enforced on
      every route. This tag invents no patrol engine, no checkpoint domain
      and no "occurrence" domain.
"""

PARAMS = """    SecurityPostIdPath:
      name: id
      in: path
      required: true
      description: Security Post id (BE-12A).
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolRouteIdPath:
      name: id
      in: path
      required: true
      description: Patrol Route id (BE-12B).
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolRoutePointIdPath:
      name: id
      in: path
      required: true
      description: Patrol Route Point (checkpoint) id (BE-12B).
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolScheduleBindingIdPath:
      name: id
      in: path
      required: true
      description: Patrol Schedule Binding id (BE-12C).
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolExecutionIdPath:
      name: id
      in: path
      required: true
      description: Patrol Execution id — the BE-07 generated task id.
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolPointIdPath:
      name: pointId
      in: path
      required: true
      description: Patrol Route Point (checkpoint) id being confirmed.
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolPointVisitIdPath:
      name: id
      in: path
      required: true
      description: Patrol Point Visit id (BE-12D).
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolChecklistBindingIdPath:
      name: id
      in: path
      required: true
      description: Patrol Checklist Binding id (BE-12E).
      schema: { $ref: "#/components/schemas/Uuid" }
    PatrolChecklistExecutionIdPath:
      name: id
      in: path
      required: true
      description: BE-07 checklist execution id started from a patrol binding.
      schema: { $ref: "#/components/schemas/Uuid" }
    SecurityFindingIdPath:
      name: id
      in: path
      required: true
      description: Security finding link id (not the BE-09 finding id).
      schema: { $ref: "#/components/schemas/Uuid" }
    IncidentIdPath:
      name: id
      in: path
      required: true
      description: Incident id (BE-21A foundation).
      schema: { $ref: "#/components/schemas/Uuid" }
    OperationalIncidentIdPath:
      name: id
      in: path
      required: true
      description: Operational Incident id — the shared BE-21A Incident id.
      schema: { $ref: "#/components/schemas/Uuid" }
"""

TAG_ANCHOR = "  - name: Housekeeping\n"
PARAM_ANCHOR = """    HousekeepingEvidenceSourceIdPath:
      name: sourceId
      in: path
      required: true
      description: Source record id matching sourceType.
      schema: { $ref: "#/components/schemas/Uuid" }
"""


def main() -> None:
    text = SPEC.read_text()
    if "operationId: listBuildingPatrolExecutions" in text:
        print("already spliced")
        return

    if TAG_ANCHOR not in text:
        raise SystemExit("Housekeeping tag anchor not found")
    text = text.replace(TAG_ANCHOR, TAG + TAG_ANCHOR, 1)

    if PARAM_ANCHOR not in text:
        raise SystemExit("Housekeeping parameter anchor not found")
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
    print("spliced security OpenAPI")


if __name__ == "__main__":
    main()
