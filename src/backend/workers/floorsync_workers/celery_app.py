from celery.signals import setup_logging, worker_process_init, worker_process_shutdown

from floorsync_common.observability import configure_logging
from floorsync_common.settings import settings
from floorsync_common.task_queue import create_task_queue
from floorsync_workers.database import dispose_worker_database, initialize_worker_database

celery_app = create_task_queue(
    include=("floorsync_workers.tasks.schedules",),
)


def _initialize_worker_process(**_: object) -> None:
    initialize_worker_database()


def _dispose_worker_process(**_: object) -> None:
    dispose_worker_database()


def _configure_worker_logging(**_: object) -> None:
    configure_logging(settings, service_name="floorsync-worker")


setup_logging.connect(_configure_worker_logging, weak=False)
worker_process_init.connect(_initialize_worker_process, weak=False)
worker_process_shutdown.connect(_dispose_worker_process, weak=False)
