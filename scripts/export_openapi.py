"""Export the FastAPI application's OpenAPI contract as a tracked JSON document.

Run ``make openapi`` after an API contract change. ``make openapi-check`` is
appropriate for CI: it regenerates the contract and fails if the tracked file
was not updated.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BACKEND_SOURCE_DIRECTORIES = (
    REPOSITORY_ROOT / "src/backend/common",
    REPOSITORY_ROOT / "src/backend/api",
    REPOSITORY_ROOT / "src/backend/workers",
)
OUTPUT_PATH = REPOSITORY_ROOT / "docs/openapi.json"


def main() -> None:
    """Create the schema from the application factory without external services."""
    for source_directory in reversed(BACKEND_SOURCE_DIRECTORIES):
        sys.path.insert(0, str(source_directory))

    from floorsync_api.main import create_application
    from floorsync_common.settings import Settings

    application = create_application(Settings(environment="test"))
    schema = application.openapi()
    OUTPUT_PATH.write_text(
        json.dumps(schema, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_PATH.relative_to(REPOSITORY_ROOT)}")


if __name__ == "__main__":
    main()
