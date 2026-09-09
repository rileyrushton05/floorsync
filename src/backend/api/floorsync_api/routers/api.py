from fastapi import APIRouter

from floorsync_api.features.auth.router import router as authentication_router
from floorsync_api.features.machines.router import categories_router
from floorsync_api.features.machines.router import router as machines_router
from floorsync_api.features.schedules.router import router as schedules_router
from floorsync_api.features.simulation.router import router as simulation_router

router = APIRouter(prefix="/api/v1")
router.include_router(authentication_router)
router.include_router(categories_router)
router.include_router(machines_router)
router.include_router(schedules_router)
router.include_router(simulation_router)

# Include domain routers here. System health remains unversioned because it is an
# operational endpoint rather than part of the product API.
