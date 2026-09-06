"""Simulated time, decoupled from wall-clock time.

The clock is what turns a static timeline into something that plays. It knows
nothing about jobs or machines, which keeps it testable on its own and reusable
for any other timeline the product later wants to replay.
"""

from dataclasses import dataclass


@dataclass(slots=True)
class PlaybackClock:
    """A play head over a bounded span of simulated time.

    Attributes:
        duration: Length of the span, normally a timeline's makespan. Time is
            clamped to ``[0, duration]``.
        current_time: Position of the play head.
        speed: Simulated time units advanced per unit of real time passed to
            :meth:`tick`. Must be positive.
        playing: Whether :meth:`tick` advances the play head.
        loop: Whether reaching the end rewinds to zero instead of pausing.
    """

    duration: float
    current_time: float = 0.0
    speed: float = 1.0
    playing: bool = False
    loop: bool = False

    def __post_init__(self) -> None:
        """Validate the span and clamp the initial position into it."""
        if self.duration < 0:
            raise ValueError("Clock duration cannot be negative.")
        if self.speed <= 0:
            raise ValueError("Clock speed must be positive.")
        self.current_time = min(max(self.current_time, 0.0), self.duration)

    def play(self) -> None:
        """Start advancing. Restarts from zero if the play head is at the end."""
        if self.at_end:
            self.current_time = 0.0
        self.playing = True

    def pause(self) -> None:
        """Stop advancing, leaving the play head where it is."""
        self.playing = False

    def toggle(self) -> None:
        """Pause if playing, play if paused."""
        if self.playing:
            self.pause()
        else:
            self.play()

    def seek(self, time: float) -> None:
        """Jump the play head to ``time``, clamped into the span.

        Seeking does not change whether the clock is playing, so a scrubber can
        drag through a running simulation without stopping it.
        """
        self.current_time = min(max(time, 0.0), self.duration)

    def seek_fraction(self, fraction: float) -> None:
        """Jump the play head to a fraction of the span, for a scrubber bar."""
        self.seek(self.duration * min(max(fraction, 0.0), 1.0))

    def step(self, delta: float) -> None:
        """Advance the play head by ``delta`` simulated units, ignoring speed.

        This is the frame-stepping control, separate from :meth:`tick`, so a
        "next frame" button does not have to reason about the speed multiplier.
        """
        self.seek(self.current_time + delta)

    def tick(self, real_delta: float) -> float:
        """Advance by ``real_delta`` of real time scaled by :attr:`speed`.

        Args:
            real_delta: Real time elapsed since the previous tick. Negative
                values are ignored so a clock never runs backwards by accident.

        Returns:
            The simulated time actually advanced, which is less than requested
            when the play head reaches the end of a non-looping span.
        """
        if not self.playing or real_delta <= 0:
            return 0.0

        before = self.current_time
        target = before + real_delta * self.speed

        if target < self.duration:
            self.current_time = target
            return self.current_time - before

        if self.loop and self.duration > 0:
            self.current_time = target % self.duration
            return real_delta * self.speed

        self.current_time = self.duration
        self.playing = False
        return self.current_time - before

    def set_speed(self, speed: float) -> None:
        """Set the playback rate.

        Raises:
            ValueError: If ``speed`` is not positive.
        """
        if speed <= 0:
            raise ValueError("Clock speed must be positive.")
        self.speed = speed

    def reset(self, duration: float | None = None) -> None:
        """Rewind to zero, pause, and optionally adopt a new span."""
        if duration is not None:
            if duration < 0:
                raise ValueError("Clock duration cannot be negative.")
            self.duration = duration
        self.current_time = 0.0
        self.playing = False

    @property
    def at_end(self) -> bool:
        """Return whether the play head has reached the end of the span."""
        return self.current_time >= self.duration

    @property
    def progress(self) -> float:
        """Return the play head position as a fraction of the span."""
        if self.duration <= 0:
            return 1.0
        return self.current_time / self.duration
