#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 05 — QR operational-context boundary.

Documentation-only. This script does NOT add a path, schema, target type or
resolver behaviour. It annotates the two EXISTING, already-published QR
operations with:

  * the frozen QR payload convention (opaque BE-05H identifier value);
  * `x-required-permission` / `x-building-scoped`, matching what the router
    already enforces (no anonymous resolution);
  * `x-qr-supported-target-types` — exactly the implemented
    MOBILE_QR_TARGET_TYPES constant (ASSET);
  * `x-qr-target-type-boundary` — the operational contexts that are NOT
    resolvable by scan, each marked MISSING with the authoritative
    canonical-id read a client must use instead.

The Asset QR contract itself (paths, schemas, enums, responses) is preserved
byte-for-byte. The script is idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"

MOBILE_QR_ANCHOR = """      operationId: resolveMobileQr
      summary: Resolve a QR/identifier from mobile
      description: >
        BE-25F mobile QR resolution contract. Resolves an opaque identifier
        (QR label, tag, barcode) through the existing BE-05H Asset Identifier
        authority and returns the discriminated target with Building /
        Functional-Location context, Asset / Equipment context where
        applicable, and available mobile action hints. Requires
        `asset_identifier.read`.

        Access is restricted to the BE-02G accessible set: an identifier whose
        Asset's Building is not accessible yields the SAME 404 as an unknown
        value (existence is hidden). No separate QR engine; the existing
        resolve endpoint remains unchanged.
"""

MOBILE_QR_REPLACEMENT = """      operationId: resolveMobileQr
      summary: Resolve a QR/identifier from mobile
      description: >
        BE-25F mobile QR resolution contract. Resolves an opaque identifier
        (QR label, tag, barcode) through the existing BE-05H Asset Identifier
        authority and returns the discriminated target with Building /
        Functional-Location context, Asset / Equipment context where
        applicable, and available mobile action hints. Requires
        `asset_identifier.read`.

        Access is restricted to the BE-02G accessible set: an identifier whose
        Asset's Building is not accessible yields the SAME 404 as an unknown
        value (existence is hidden). No separate QR engine; the existing
        resolve endpoint remains unchanged.

        CR-BE-MOB-01 PART 05 — frozen QR payload convention. The scanned
        payload is the OPAQUE `identifier_value` of a row in the BE-05H
        `asset_identifiers` registry (`identifierType` QR / TAG / BARCODE /
        LEGACY). It is deliberately meaningless: no Client, Building, URL or
        security data is encoded, so a label read by anyone leaks nothing. It
        is NOT a canonical UUID and NOT a structured deep link. The identifier
        registry is asset-scoped — identifiers are registered only through
        `POST /assets/{assetId}/identifiers` — therefore ASSET is the only
        target type this operation can ever return today
        (`x-qr-supported-target-types`).

        Scanning is never anonymous: the caller must present a valid session
        and hold `asset_identifier.read`, and the result is filtered by the
        caller's accessible Buildings. The backend records no GPS coordinate
        and performs no geofence check — scan position is not an input to,
        or an output of, this contract.

        Operational contexts that are NOT scan-resolvable are listed in
        `x-qr-target-type-boundary`. For each of them the client must use the
        authoritative canonical-id read named there; the backend must not be
        asked to guess, and such a target must never be mapped onto ASSET.
      x-required-permission: asset_identifier.read
      x-building-scoped: true
      x-qr-supported-target-types: [ASSET]
      x-qr-target-type-boundary:
        - targetType: LOCATION
          status: MISSING
          reason: >-
            BE-04 Floor / Area / Room / Space rows have a `code` that is
            unique per parent, but there is no location identifier registry
            and no resolve-by-identifier route. Nothing exists to resolve a
            scanned label to a location.
          authority: BE-04 Structure
          canonicalIdReads:
            [getBuildingHierarchy, listBuildingFloors, getFloor, getArea,
             getRoom, getSpace]
        - targetType: FUNCTIONAL_LOCATION
          status: MISSING
          reason: >-
            Same as LOCATION — BE-04 Functional Locations carry no identifier
            registry. The context projection is already published.
          authority: BE-04 Functional Locations
          canonicalIdReads:
            [getFunctionalLocation, getFunctionalLocationContext,
             listBuildingFunctionalLocations]
        - targetType: CHECKPOINT
          status: MISSING
          reason: >-
            BE-12B patrol route points are identified by canonical UUID plus
            sequence and location FKs; they carry no identifier value.
            Checkpoint confirmation is therefore by canonical `pointId`
            (`recordPatrolPointVisit`), not by scan.
          authority: BE-12B Patrol Route Points + BE-12D Patrol Execution
          canonicalIdReads:
            [listPatrolRoutePoints, getPatrolExecution, listPatrolPointVisits]
        - targetType: WORK_ORDER
          status: MISSING
          reason: >-
            BE-08 Work Orders have a human-readable `workOrderNumber` but no
            identifier registry and no resolve-by-number route. Mobile reaches
            a Work Order through its assignment feed or canonical id.
          authority: BE-08 Work Order
          canonicalIdReads:
            [listMobileAssignments, getWorkOrder, listBuildingWorkOrders]
"""

ASSET_ANCHOR = """      operationId: resolveAssetByIdentifier
      summary: Resolve an asset identifier (QR-ready)
      description: >
        Resolves a printed/label identifier (QR) to its asset. The asset's
        Building must be within the caller's accessible scope.
        Requires `asset_identifier.read`.
"""

ASSET_REPLACEMENT = """      operationId: resolveAssetByIdentifier
      summary: Resolve an asset identifier (QR-ready)
      description: >
        Resolves a printed/label identifier (QR) to its asset. The asset's
        Building must be within the caller's accessible scope.
        Requires `asset_identifier.read`.

        CR-BE-MOB-01 PART 05 — this is the single identifier authority behind
        `resolveMobileQr`; the payload is the same opaque BE-05H
        `identifier_value`. The registry is asset-scoped, so no other
        operational context (location, functional location, patrol checkpoint,
        Work Order) can be resolved here. Unchanged by PART 05.
      x-required-permission: asset_identifier.read
      x-building-scoped: true
      x-qr-supported-target-types: [ASSET]
"""


def main() -> None:
    text = SPEC.read_text()
    if "x-qr-target-type-boundary" in text:
        print("already annotated")
        return

    if MOBILE_QR_ANCHOR not in text:
        raise SystemExit("resolveMobileQr anchor not found")
    text = text.replace(MOBILE_QR_ANCHOR, MOBILE_QR_REPLACEMENT, 1)

    if ASSET_ANCHOR not in text:
        raise SystemExit("resolveAssetByIdentifier anchor not found")
    text = text.replace(ASSET_ANCHOR, ASSET_REPLACEMENT, 1)

    SPEC.write_text(text)
    print("annotated QR operational-context boundary")


if __name__ == "__main__":
    main()
