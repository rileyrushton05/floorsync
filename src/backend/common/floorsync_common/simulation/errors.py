"""Errors raised when schedule and simulation data do not agree."""


class SimulationError(Exception):
    """Base class for every error raised by the simulation package."""


class InstanceFormatError(SimulationError):
    """Raise when a benchmark instance document is missing fields or malformed."""


class ScheduleFormatError(SimulationError):
    """Raise when a benchmark solution document is missing fields or malformed."""


class ScheduleMismatchError(SimulationError):
    """Raise when schedule data does not describe the work it is applied to.

    For a FloorSync schedule this means the dependency cache references an entry
    outside the loaded schedule, or carries an unknown reason. For a benchmark
    instance it means a machine sequence names an absent job, is the wrong
    length, or leaves operations unsequenced.
    """


class CyclicScheduleError(SimulationError):
    """Raise when precedence and machine queueing imply a deadlock.

    A cycle means no start times exist that satisfy every constraint, so the
    schedule is infeasible rather than merely suboptimal.
    """


class SimulationTimelineError(SimulationError):
    """Raise when a simulation's event log cannot be replayed.

    Causes are a naive timestamp where a timezone-aware one is required, a
    speed-setting event with no speed recorded, or an unknown event type.
    """
