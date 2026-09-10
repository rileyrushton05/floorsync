"""Keyset cursors for paginated collections.

A cursor records where the last page ended rather than how far into the collection it was, so rows
inserted or removed between requests cannot make a page repeat or skip an entry. Every collection
using these orders by a display column with the primary key as the final tie-breaker, keeping the
ordering total even when that column is not unique.
"""

import binascii
from base64 import urlsafe_b64decode, urlsafe_b64encode
from typing import Final
from uuid import UUID

_SEPARATOR: Final = "\x00"


def encode_cursor(sort_value: str, identifier: UUID) -> str:
    """Encode the ordering key of the last row on a page."""

    return urlsafe_b64encode(f"{sort_value}{_SEPARATOR}{identifier}".encode()).decode()


def decode_cursor(cursor: str | None) -> tuple[str, UUID] | None:
    """Decode a cursor, treating an unreadable one as the start of the collection.

    A cursor is an opaque continuation token rather than client input worth validating: a malformed
    one means a stale or hand-edited link, and restarting is friendlier than a 422.
    """

    if not cursor:
        return None
    try:
        raw = urlsafe_b64decode(cursor.encode()).decode()
        sort_value, _, identifier = raw.partition(_SEPARATOR)
        return sort_value, UUID(identifier)
    except (ValueError, UnicodeDecodeError, binascii.Error):
        return None
