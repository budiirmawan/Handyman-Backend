#!/usr/bin/env python3
"""Splice CR-BE-CONFIG-OPENAPI-01 PART 02 into docs/api/openapi.yaml.

Publish-only contract reconciliation: this script only inserts the fragments
that document ALREADY REGISTERED runtime routes (vendor master, asset
category/type, utility type configuration, form template version, finding
classification/severity). It never edits runtime code.

The splice is deliberately text-based (not a parse/re-dump) so the curated
comments and formatting of the 3.6 MB contract file survive untouched. Every
anchor is asserted to be unique before a byte is written, and the script is
idempotent-by-refusal: if the CR marker is already present it aborts.

Fragments (all relative to this script's directory):
  cr-be-config-openapi-01-part02-tags.yaml          -> end of `tags:`
  cr-be-config-openapi-01-part02-parameters.yaml    -> end of components.parameters
  cr-be-config-openapi-01-part02-paths-*.yaml       -> end of `paths:`
  cr-be-config-openapi-01-part02-schemas.yaml       -> end of components.schemas

Every PART 02 path key was verified absent from the contract before this
splice, so each fragment contributes whole path blocks and no existing path
item is re-declared.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
SPEC_PATH = REPO_ROOT / "docs" / "api" / "openapi.yaml"

CR_MARKER = "CR-BE-CONFIG-OPENAPI-01 PART 02"

TAGS_FRAGMENT = HERE / "cr-be-config-openapi-01-part02-tags.yaml"
PARAMETERS_FRAGMENT = HERE / "cr-be-config-openapi-01-part02-parameters.yaml"
SCHEMAS_FRAGMENT = HERE / "cr-be-config-openapi-01-part02-schemas.yaml"

# Concatenated in this order, then appended at the end of `paths:`.
PATH_FRAGMENTS = [
    "cr-be-config-openapi-01-part02-paths-01-vendors.yaml",
    "cr-be-config-openapi-01-part02-paths-02-vendor-categories.yaml",
    "cr-be-config-openapi-01-part02-paths-03-vendor-pics.yaml",
    "cr-be-config-openapi-01-part02-paths-04-vendor-buildings.yaml",
    "cr-be-config-openapi-01-part02-paths-05-vendor-capabilities.yaml",
    "cr-be-config-openapi-01-part02-paths-06-vendor-workforce.yaml",
    "cr-be-config-openapi-01-part02-paths-07-vendor-compliance.yaml",
    "cr-be-config-openapi-01-part02-paths-08-vendor-licenses.yaml",
    "cr-be-config-openapi-01-part02-paths-09-asset-categories.yaml",
    "cr-be-config-openapi-01-part02-paths-10-asset-types.yaml",
    "cr-be-config-openapi-01-part02-paths-11-utility-type-configurations.yaml",
    "cr-be-config-openapi-01-part02-paths-12-form-template-versions.yaml",
    "cr-be-config-openapi-01-part02-paths-13-finding-classifications.yaml",
    "cr-be-config-openapi-01-part02-paths-14-finding-severities.yaml",
]

# --- anchors -----------------------------------------------------------------
# Each anchor must match EXACTLY ONE line, otherwise the splice aborts.
TAGS_ANCHOR = (
    "# No global security requirement: public endpoints (health, login,"
)
PATHS_ANCHOR = "components:"
PARAMETERS_ANCHOR = "  responses:"


def read(name: str) -> str:
    return (HERE / name).read_text(encoding="utf-8")


def unique_line_index(lines: list[str], needle: str) -> int:
    matches = [i for i, line in enumerate(lines) if line.rstrip("\n") == needle]
    if len(matches) != 1:
        raise SystemExit(
            f"anchor {needle!r} matched {len(matches)} lines; expected exactly 1"
        )
    return matches[0]


def main() -> int:
    text = SPEC_PATH.read_text(encoding="utf-8")

    if CR_MARKER in text:
        raise SystemExit(f"{SPEC_PATH} already contains {CR_MARKER!r}; refusing to re-splice")

    for required in (TAGS_FRAGMENT, PARAMETERS_FRAGMENT, SCHEMAS_FRAGMENT):
        if not required.exists():
            raise SystemExit(f"missing fragment: {required}")
    for name in PATH_FRAGMENTS:
        if not (HERE / name).exists():
            raise SystemExit(f"missing fragment: {HERE / name}")

    tags = read(TAGS_FRAGMENT.name)
    parameters = read(PARAMETERS_FRAGMENT.name)
    schemas = read(SCHEMAS_FRAGMENT.name)
    paths = "".join(read(name) for name in PATH_FRAGMENTS)

    # 1. Paths — append at the end of `paths:`, i.e. immediately before the
    #    column-0 `components:` key. A blank line separates them.
    lines = text.splitlines(keepends=True)
    idx = unique_line_index(lines, PATHS_ANCHOR)
    for name in PATH_FRAGMENTS:
        key = read(name).splitlines()
        for line in key:
            if line.startswith("  /"):
                if line + "\n" in lines:
                    raise SystemExit(f"path key already present in {SPEC_PATH}: {line.strip()}")
    lines.insert(idx, "\n" + paths + "\n")
    text = "".join(lines)

    # 2. Parameters — append at the end of components.parameters, immediately
    #    before the components-level `responses:` key.
    lines = text.splitlines(keepends=True)
    idx = unique_line_index(lines, PARAMETERS_ANCHOR)
    lines.insert(idx, parameters)
    text = "".join(lines)

    # 3. Tags — append at the end of `tags:`, immediately before the trailing
    #    "no global security" comment that precedes `security: []`.
    lines = text.splitlines(keepends=True)
    idx = unique_line_index(lines, TAGS_ANCHOR)
    lines.insert(idx, tags + "\n")
    text = "".join(lines)

    # 4. Schemas — append at the end of the file (components.schemas is the
    #    final key of the document).
    if not text.endswith("\n"):
        text += "\n"
    text = text + "\n" + schemas

    SPEC_PATH.write_text(text, encoding="utf-8")
    print(f"spliced {CR_MARKER} into {SPEC_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
