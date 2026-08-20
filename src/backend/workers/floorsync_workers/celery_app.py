from celery import Celery
from celery.signals import worker_process_init, worker_process_shutdown

from floorsync_common.settings import settings
from floorsync_workers.database import dispose_worker_database, initialize_worker_database

celery_app = Celery(
    "floorsync",
    broker=settings.celery_broker_url,
    backend=settings.redis_url,
)


def _initialize_worker_process(**_: object) -> None:
    initialize_worker_database()


def _dispose_worker_process(**_: object) -> None:
    dispose_worker_database()


worker_process_init.connect(_initialize_worker_process, weak=False)
worker_process_shutdown.connect(_dispose_worker_process, weak=False)
