from celery import Celery

from floorsync_common.settings import settings

celery_app = Celery(
    "floorsync",
    broker=settings.celery_broker_url,
    backend=settings.redis_url,
)
