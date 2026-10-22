"""Turn the bytes of an uploaded file into an import plan, whatever format it is in.

Decodes the JSON once (exact decimals, no duplicate keys, no NaN), tells the format apart by
content, hands the document to that format's reader, then applies the checks every plan must pass
before anything else may rely on it. Nothing here touches the database.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, DecimalException
from typing import NoReturn, assert_never

from floorsync_common.imports.formats.benchmarks import BenchmarkImportService
from floorsync_common.imports.formats.floorsync import FLOORSYNC_VERSION, FloorSyncImportService
from floorsync_common.imports.plan import ImportFormat, ImportIssue, ImportIssueCode
from floorsync_common.imports.results import FileUnreadable, PlanRead, ReadFileResult
from floorsync_common.imports.validation import ImportValidationService
from floorsync_common.seed.flexible import is_flexible_payload


class ImportParsingService:
    """Reads an uploaded file into a plan, or says why it cannot."""

    @staticmethod
    def read_file(raw: bytes) -> ReadFileResult:
        """Turn an uploaded file into a plan, or say why it cannot be.

        The format is told apart by content, not by filename. Pure: it never touches the database,
        so the caller runs it before opening a transaction.
        """

        if not raw.strip():
            return _unreadable(ImportIssueCode.EMPTY_FILE, "The file is empty.")
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            return _unreadable(ImportIssueCode.NOT_UTF8, "The file is not UTF-8 text.")

        if _nests_deeper_than(text, _MAX_NESTING):
            return _unreadable(
                ImportIssueCode.TOO_DEEPLY_NESTED, "The file nests too deeply to read."
            )
        try:
            document = json.loads(
                text,
                # Exact decimals for energy and salary, never binary floats (api-conventions.md).
                parse_float=Decimal,
                parse_constant=_reject_non_finite,
                object_pairs_hook=_object_without_duplicate_keys,
            )
        except _DuplicateKey as error:
            return _unreadable(
                ImportIssueCode.DUPLICATE_KEY,
                f"The key {error.key!r} appears twice in one object, so it is unclear which value "
                "was meant.",
            )
        except json.JSONDecodeError as error:
            return _unreadable(
                ImportIssueCode.NOT_JSON,
                f"The file is not valid JSON: {error.msg} (line {error.lineno}, column "
                f"{error.colno}).",
            )
        except DecimalException:
            # `parse_float=Decimal` on a number like 1e999999999999999999999.
            return _unreadable(
                ImportIssueCode.NOT_JSON, "The file contains a number too large to read."
            )
        except ValueError as error:
            # NaN or Infinity, or Python's own limits, such as an integer thousands of digits long.
            return _unreadable(ImportIssueCode.NOT_JSON, f"The file is not valid JSON: {error}.")
        except RecursionError:
            return _unreadable(
                ImportIssueCode.TOO_DEEPLY_NESTED, "The file nests too deeply to read."
            )

        if not isinstance(document, dict):
            return _unreadable(
                ImportIssueCode.NOT_AN_OBJECT,
                "The file must contain one JSON object, not a list or a value.",
            )

        if document.get("format") == ImportFormat.FLOORSYNC:
            read = FloorSyncImportService.read(document)
            machines_at, jobs_at = "machines", "jobs"
        elif is_flexible_payload(document):
            read = BenchmarkImportService.read_flexible_jobshop(document)
            machines_at, jobs_at = "operations", "precedences"
        elif "data" in document:
            # Also checks its declared counts itself, before building anything from them.
            read = BenchmarkImportService.read_jobshop(document)
            machines_at, jobs_at = "machines", "jobs"
        else:
            return _unreadable(
                ImportIssueCode.UNKNOWN_FORMAT,
                "The file is not a format FloorSync imports. A FloorSync file starts with "
                f'"format": "{ImportFormat.FLOORSYNC}" and "version": {FLOORSYNC_VERSION}; a '
                "benchmark file is a ScheduleOpt job-shop or flexible job-shop instance.",
            )

        # Every format ends here, so these hold for any plan this returns.
        match read:
            case PlanRead(plan=plan):
                issues = ImportValidationService.check_size(
                    machines=len(plan.machines),
                    jobs=len(plan.jobs),
                    rows=ImportValidationService.rows_written(plan),
                    machines_at=machines_at,
                    jobs_at=jobs_at,
                ) or ImportValidationService.check_text(plan)
                return FileUnreadable(issues=issues) if issues else read
            case FileUnreadable():
                return read
            case _:
                assert_never(read)


# Checked before decoding rather than left to `json.loads` raising RecursionError: whether and
# where that happens depends on the Python version (3.14 bounds C recursion by stack size, so a
# deep file can decode fully and surface as plain invalid JSON). 1000 is the default recursion
# limit, and no real import nests more than a handful of levels.
_MAX_NESTING = 1000
# A whole string literal (so brackets inside it are skipped), or one bracket.
_STRING_OR_BRACKET = re.compile(r'"(?:\\.|[^"\\])*"|[\[\]{}]')


def _nests_deeper_than(text: str, limit: int) -> bool:
    depth = 0
    for match in _STRING_OR_BRACKET.finditer(text):
        token = match.group()[0]
        if token in "[{":
            depth += 1
            if depth > limit:
                return True
        elif token in "]}":
            depth -= 1
    return False


def _unreadable(code: ImportIssueCode, message: str) -> FileUnreadable:
    return FileUnreadable(issues=(ImportIssue(code, message),))


class _DuplicateKey(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


def _object_without_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    document: dict[str, object] = {}
    for key, value in pairs:
        if key in document:
            raise _DuplicateKey(key)
        document[key] = value
    return document


def _reject_non_finite(constant: str) -> NoReturn:
    raise ValueError(f"{constant} is not a JSON number")
