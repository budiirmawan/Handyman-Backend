#!/usr/bin/env python3
"""Splice CR-BE-CONFIG-OPENAPI-01 PART 01 into docs/api/openapi.yaml.

Publish-only contract reconciliation: this script only inserts the fragments
that document ALREADY REGISTERED runtime routes. It never edits runtime code.

The splice is deliberately text-based (not a parse/re-dump) so the curated
comments and formatting of the 3.4 MB contract file survive untouched. Every
anchor is asserted to be unique before a byte is written, and the script is
idempotent-by-refusal: if the CR marker is already present it aborts.

Fragments (all relative to this script's directory):
  cr-be-config-openapi-01-part01-tags.yaml          -> end of `tags:`
  cr-be-config-openapi-01-part01-parameters.yaml    -> end of components.parameters
  cr-be-config-openapi-01-part01-paths-*.yaml       -> end of `paths:`
  cr-be-config-openapi-01-part01-schemas.yaml       -> end of components.schemas

SECTION 11 is special: `/workforce/{workforceId}/supervisor` already exists in
the contract with its GET operation, and re-declaring the path key would create
a duplicate YAML key. Its POST and PATCH are therefore spliced INTO the existing
path item rather than appended as a second path block.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
SPEC_PATH = REPO_ROOT / "docs" / "api" / "openapi.yaml"

CR_MARKER = "CR-BE-CONFIG-OPENAPI-01 PART 01"

TAGS_FRAGMENT = HERE / "cr-be-config-openapi-01-part01-tags.yaml"
PARAMETERS_FRAGMENT = HERE / "cr-be-config-openapi-01-part01-parameters.yaml"
SCHEMAS_FRAGMENT = HERE / "cr-be-config-openapi-01-part01-schemas.yaml"

# Concatenated in this order, then appended at the end of `paths:`.
PATH_FRAGMENTS = [
    "cr-be-config-openapi-01-part01-paths-01-organization.yaml",
    "cr-be-config-openapi-01-part01-paths-02-department.yaml",
    "cr-be-config-openapi-01-part01-paths-03-team.yaml",
    "cr-be-config-openapi-01-part01-paths-04-position.yaml",
    "cr-be-config-openapi-01-part01-paths-05-skill.yaml",
    "cr-be-config-openapi-01-part01-paths-06-shift.yaml",
    "cr-be-config-openapi-01-part01-paths-07-workforce-profiles.yaml",
    "cr-be-config-openapi-01-part01-paths-08-workforce-skills.yaml",
    "cr-be-config-openapi-01-part01-paths-09-workforce-shifts.yaml",
    "cr-be-config-openapi-01-part01-paths-10-workforce-buildings.yaml",
    # 11 is spliced into the existing path item — see REPORTING_LINE_FRAGMENT.
    "cr-be-config-openapi-01-part01-paths-12-external-workforce.yaml",
]

REPORTING_LINE_FRAGMENT = (
    "cr-be-config-openapi-01-part01-paths-11-workforce-reporting-lines.yaml"
)

# --- anchors -----------------------------------------------------------------
# Each anchor must match EXACTLY ONE line, otherwise the splice aborts.
TAGS_ANCHOR = (
    "# No global security requirement: public endpoints (health, login,"
)
PATHS_ANCHOR = "components:"
PARAMETERS_ANCHOR = "  responses:"
REPORTING_LINE_ANCHOR = "  /workforce/{supervisorId}/direct-reports:"


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
    for name in PATH_FRAGMENTS + [REPORTING_LINE_FRAGMENT]:
        if not (HERE / name).exists():
            raise SystemExit(f"missing fragment: {HERE / name}")

    tags = read(TAGS_FRAGMENT.name)
    parameters = read(PARAMETERS_FRAGMENT.name)
    schemas = read(SCHEMAS_FRAGMENT.name)
    reporting_line = read(REPORTING_LINE_FRAGMENT)
    paths = "".join(read(name) for name in PATH_FRAGMENTS)

    # 1. Paths — append at the end of `paths:`, i.e. immediately before the
    #    column-0 `components:` key. A blank line separates them.
    lines = text.splitlines(keepends=True)
    idx = unique_line_index(lines, PATHS_ANCHOR)
    lines.insert(idx, "\n" + paths + "\n")

    # 2. Reporting line writes — splice into the EXISTING path item.
    idx = unique_line_index(lines, REPORTING_LINE_ANCHOR)
    lines.insert(idx, reporting_line + "\n")

    text = "".join(lines)

    # 3. Parameters — append at the end of components.parameters, immediately
    #    before the components-level `responses:` key.
    lines = text.splitlines(keepends=True)
    idx = unique_line_index(lines, PARAMETERS_ANCHOR)
    lines.insert(idx, parameters)
    text = "".join(lines)

    # 4. Tags — append at the end of `tags:`, immediately before the trailing
    #    "no global security" comment that precedes `security: []`.
    lines = text.splitlines(keepends=True)
    idx = unique_line_index(lines, TAGS_ANCHOR)
    lines.insert(idx, tags + "\n")
    text = "".join(lines)

    # 5. Schemas — append at the end of the file (components.schemas is the
    #    final key of the document).
    if not text.endswith("\n"):
        text += "\n"
    text = text + "\n" + schemas

    SPEC_PATH.write_text(text, encoding="utf-8")
    print(f"spliced {CR_MARKER} into {SPEC_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
