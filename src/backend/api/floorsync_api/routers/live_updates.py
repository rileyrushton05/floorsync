from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter(tags=["live-updates"])


@router.websocket("/ws")
async def live_updates(websocket: WebSocket) -> None:
    """Keep a neutral WebSocket transport available while event design is undecided."""
    await websocket.accept()
    await websocket.send_json({"type": "connected"})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        return
