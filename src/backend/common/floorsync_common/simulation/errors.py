"""Errors raised when instance and schedule data do not agree."""


class SimulationError(Exception):
    """Base class for every error raised by the simulation package."""


class InstanceFormatError(SimulationError):
    """Raise when an instance document is missing fields or is malformed."""


class ScheduleFormatError(SimulationError):
    """Raise when a solution document is missing fields or is malformed."""


class ScheduleMismatchError(SimulationError):
    """Raise when a schedule does not describe the instance it is applied to.

    The usual causes are a machine sequence naming a job that never visits that
    machine, a sequence that is the wrong length, or a job whose operations are
    only partly sequenced.
    """


class CyclicScheduleError(SimulationError):
    """Raise when job precedence and machine sequencing imply a deadlock.

    A cycle means no start times exist that satisfy both constraint sets, so the
    schedule is infeasible rather than merely suboptimal.
    """
