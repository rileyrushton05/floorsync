from collections.abc import Sequence

from celery import Celery

from floorsync_common.settings import settings


def create_task_queue(*, include: Sequence[str] = ()) -> Celery:
    """Create a process-local Celery client or worker application."""

    queue = Celery(
        "floorsync",
        broker=settings.celery_broker_url,
        backend=settings.redis_url,
        include=list(include),
    )
    queue.conf.task_track_started = True
    return queue
