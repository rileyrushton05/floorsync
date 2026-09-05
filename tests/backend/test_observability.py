import json
import logging
from dataclasses import FrozenInstanceError, dataclass

import pytest

from floorsync_common.observability import ContextFilter, JsonFormatter
from floorsync_common.outcomes import ExpectedOutcome


def test_json_formatter_includes_stable_context_and_event_fields() -> None:
    record = logging.LogRecord(
        name="floorsync.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="request finished",
        args=(),
        exc_info=None,
    )
    record.event = "example_event"
    ContextFilter(environment="test", service_name="floorsync-api").filter(record)

    payload = json.loads(JsonFormatter().format(record))

    assert payload["level"] == "INFO"
    assert payload["message"] == "request finished"
    assert payload["event"] == "example_event"
    assert payload["service"] == "floorsync-api"
    assert payload["environment"] == "test"
    assert payload["request_id"] is None


def test_expected_outcomes_are_identifiable_and_immutable() -> None:
    @dataclass(frozen=True, slots=True)
    class ExampleOutcome(ExpectedOutcome):
        reason: str

    outcome = ExampleOutcome(reason="expected")

    assert isinstance(outcome, ExpectedOutcome)
    with pytest.raises(FrozenInstanceError):
        outcome.reason = "changed"
