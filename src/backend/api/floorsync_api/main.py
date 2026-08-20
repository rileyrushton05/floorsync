from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from floorsync_api.routers.health import router as health_router
from floorsync_api.routers.live_updates import router as live_updates_router

app = FastAPI(title="FloorSync API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health_router)
app.include_router(live_updates_router)
