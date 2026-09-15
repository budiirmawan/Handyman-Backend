#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 08 — align the PART 01 Housekeeping annotations.

The PART 08 cross-contract regression found that the `x-required-permission` /
`x-building-scoped` convention introduced in PART 02 was never applied to the
PART 01 Housekeeping surface, so "RBAC preserved" and "tenant/Building scope
preserved" were not uniformly verifiable across the CR.

This is documentation only: each permission below is the exact code the BE-11
router already enforces via `requirePermission`, and every one exists in the
seeded permission catalogue. No path, schema, response or behaviour changes.
Idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"

PERMISSION_BY_OPERATION = {
    # BE-11C daily cleaning (read view of BE-07 tasks)
    "listBuildingDailyCleaning": "daily_cleaning.read",
    "getDailyCleaning": "daily_cleaning.read",
    "listCleaningAreaDailyCleaning": "daily_cleaning.read",
    # BE-11D cleaning assignment (reuse of BE-07 task assignment)
    "assignDailyCleaning": "cleaning_assignment.manage",
    "listDailyCleaningAssignments": "cleaning_assignment.read",
    "listWorkforceDailyCleaning": "cleaning_assignment.read",
    "listTeamDailyCleaning": "cleaning_assignment.read",
    # BE-11E toilet inspection binding
    "createToiletInspectionBinding": "toilet_inspection.manage",
    "updateToiletInspectionBinding": "toilet_inspection.manage",
    "startToiletInspectionExecution": "toilet_inspection.manage",
    "listToiletInspectionBindings": "toilet_inspection.read",
    "getToiletInspectionBinding": "toilet_inspection.read",
    "getToiletInspectionExecution": "toilet_inspection.read",
    # BE-11F public-area inspection binding
    "createPublicAreaInspectionBinding": "public_area_inspection.manage",
    "updatePublicAreaInspectionBinding": "public_area_inspection.manage",
    "startPublicAreaInspectionExecution": "public_area_inspection.manage",
    "listPublicAreaInspectionBindings": "public_area_inspection.read",
    "getPublicAreaInspectionBinding": "public_area_inspection.read",
    "getPublicAreaInspectionExecution": "public_area_inspection.read",
    # BE-11G supervisor inspection (BE-07 review primitive)
    "createSupervisorInspection": "supervisor_inspection.manage",
    "submitSupervisorInspectionDecision": "supervisor_inspection.manage",
    "listSupervisorInspections": "supervisor_inspection.read",
    "getSupervisorInspection": "supervisor_inspection.read",
    # BE-11K quality audit
    "createQualityAudit": "quality_audit.manage",
    "updateQualityAudit": "quality_audit.manage",
    "completeQualityAudit": "quality_audit.manage",
    "listQualityAudits": "quality_audit.read",
    "getQualityAudit": "quality_audit.read",
    # BE-11H housekeeping finding link (workflow stays BE-09)
    "createHousekeepingFinding": "housekeeping_finding.manage",
    "listHousekeepingFindings": "housekeeping_finding.read",
    "getHousekeepingFinding": "housekeeping_finding.read",
    # BE-11I housekeeping evidence binding (over BE-07 evidence)
    "submitHousekeepingEvidence": "housekeeping_evidence.manage",
    "listHousekeepingEvidenceRequirements": "housekeeping_evidence.read",
    "listHousekeepingEvidence": "housekeeping_evidence.read",
}


def main() -> None:
    text = SPEC.read_text()
    lines = text.split("\n")
    out: list[str] = []
    annotated = 0

    for line in lines:
        out.append(line)
        stripped = line.strip()
        if not stripped.startswith("operationId: "):
            continue
        operation_id = stripped[len("operationId: ") :].strip()
        permission = PERMISSION_BY_OPERATION.get(operation_id)
        if permission is None:
            continue
        indent = line[: len(line) - len(line.lstrip())]
        # Idempotency: skip when already annotated.
        out.append(f"{indent}x-required-permission: {permission}")
        out.append(f"{indent}x-building-scoped: true")
        annotated += 1

    if "x-required-permission: daily_cleaning.read" in text:
        print("already aligned")
        return

    if annotated != len(PERMISSION_BY_OPERATION):
        raise SystemExit(
            f"expected {len(PERMISSION_BY_OPERATION)} Housekeeping operations, annotated {annotated}"
        )

    SPEC.write_text("\n".join(out))
    print(f"aligned {annotated} Housekeeping operations")


if __name__ == "__main__":
    main()
