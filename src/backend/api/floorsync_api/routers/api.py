from fastapi import APIRouter

from floorsync_api.features.auth.router import router as authentication_router
from floorsync_api.features.jobs.definitions_router import (
    job_definition_router,
    job_definitions_router,
)
from floorsync_api.features.jobs.router import router as jobs_router
from floorsync_api.features.machines.router import categories_router
from floorsync_api.features.machines.router import router as machines_router
from floorsync_api.features.operations.router import job_operations_router
from floorsync_api.features.operations.router import router as operations_router
from floorsync_api.features.schedules.router import router as schedules_router
from floorsync_api.features.simulation.router import router as simulation_router

router = APIRouter(prefix="/api/v1")
router.include_router(authentication_router)
router.include_router(categories_router)
router.include_router(job_definition_router)
router.include_router(job_definitions_router)
router.include_router(job_operations_router)
router.include_router(jobs_router)
router.include_router(machines_router)
router.include_router(operations_router)
router.include_router(schedules_router)
router.include_router(simulation_router)

# Include domain routers here. System health remains unversioned because it is an
# operational endpoint rather than part of the product API.
