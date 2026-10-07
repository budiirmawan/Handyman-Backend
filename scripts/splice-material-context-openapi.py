#!/usr/bin/env python3
"""CR-BE-MOB-01 PART 04 — splice Work Order material context fragments.

Publish-only: every path added here is already registered in
src/modules/**/*.routes.ts (BE-16A item master, BE-16B warehouse master,
BE-16H asset ↔ spare-part binding). The Work Order material usage / stock /
approved-quantity / verification surfaces were already published by earlier
waves and are not touched. The script is idempotent.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "docs/api/openapi.yaml"
FRAG_PATHS = ROOT / "scripts/cr-be-mob-01-part04-openapi-fragment.yaml"
FRAG_SCHEMAS = ROOT / "scripts/cr-be-mob-01-part04-openapi-schemas.yaml"

TAG = """  - name: Inventory Master
    description: >-
      CR-BE-MOB-01 PART 04 — existing BE-16A Inventory Item master, BE-16B
      Warehouse master and BE-16H Asset ↔ spare-part binding **reads**: the
      reference data a mobile field picker needs before issuing material
      against a Work Order. It is reference data only and carries no stock,
      price or workflow. The Work Order material chain itself was already
      published and is deliberately not repeated here: issue/usage under
      `Work Order Material Usage` (`recordWorkOrderMaterialUsage`,
      `listWorkOrderMaterialUsages`, `getWorkOrderMaterialUsage`,
      `getWorkOrderMaterialCostSummary`), the authoritative ledger and
      availability under `Inventory Stock` (stock movements STOCK_IN /
      STOCK_OUT and stock balances), the approved-quantity chain under
      `Material Requests` (`quantity`, `approvedQuantity`, `receivedQuantity`,
      `remainingQuantity`) plus `Work Order Procurement Binding`, and
      supervisor verification under `Work Orders`
      (`getWorkOrderVerification` / `submitWorkOrderVerification` /
      `closeWorkOrder…`, over the BE-07 review primitive). Building isolation
      (BE-02G) and default-deny RBAC are enforced on every route. This tag
      invents no material workflow, no inventory engine, no verification
      engine and no mobile-specific API.
"""

PARAMS = """    AssetSparePartIdPath:
      name: id
      in: path
      required: true
      description: Asset ↔ spare-part Item binding id (BE-16H).
      schema: { $ref: "#/components/schemas/Uuid" }
"""

TAG_ANCHOR = "  - name: Engineering\n"
PARAM_ANCHOR = """    EngineeringShiftHandoverIdPath:
      name: id
      in: path
      required: true
      description: Engineering shift handover id (BE-10J).
      schema: { $ref: "#/components/schemas/Uuid" }
"""


def main() -> None:
    text = SPEC.read_text()
    if "operationId: listClientInventoryItems" in text:
        print("already spliced")
        return

    if TAG_ANCHOR not in text:
        raise SystemExit("Engineering tag anchor not found")
    text = text.replace(TAG_ANCHOR, TAG + TAG_ANCHOR, 1)

    if PARAM_ANCHOR not in text:
        raise SystemExit("Engineering parameter anchor not found")
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
    print("spliced work order material context OpenAPI")


if __name__ == "__main__":
    main()
