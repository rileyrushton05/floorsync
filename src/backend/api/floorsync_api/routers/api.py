from fastapi import APIRouter

router = APIRouter(prefix="/api/v1")

# Include domain routers here. System health remains unversioned because it is an
# operational endpoint rather than part of the product API.
