from fastapi import APIRouter

from floorsync_api.features.auth.router import router as authentication_router

router = APIRouter(prefix="/api/v1")
router.include_router(authentication_router)

# Include domain routers here. System health remains unversioned because it is an
# operational endpoint rather than part of the product API.
