"""ViDi Client Control Panel — FastAPI backend.

A local web app that acts as a control panel for a remote ViDi Training Server.
Proxies requests to the remote server and serves a browser-based UI.
"""

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

import aiofiles
import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pydantic_settings import BaseSettings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

class ClientSettings(BaseSettings):
    vidi_server_host: str = "10.0.0.102"
    vidi_server_port: int = 8042
    upload_share_path: str = ""
    local_port: int = 8080

    model_config = {"env_prefix": "VIDI_CLIENT_"}

    @property
    def vidi_base_url(self) -> str:
        return f"http://{self.vidi_server_host}:{self.vidi_server_port}"


settings = ClientSettings()

# Mutable runtime overrides (reset on restart)
_runtime_host: Optional[str] = None
_runtime_port: Optional[int] = None
_runtime_share: Optional[str] = None


def _base_url() -> str:
    host = _runtime_host or settings.vidi_server_host
    port = _runtime_port or settings.vidi_server_port
    return f"http://{host}:{port}"


def _share_path() -> str:
    return _runtime_share if _runtime_share is not None else settings.upload_share_path


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

_client: Optional[httpx.AsyncClient] = None


async def vidi_request(method: str, path: str, **kwargs) -> dict:
    url = f"{_base_url()}{path}"
    try:
        resp = await _client.request(method, url, **kwargs)
        resp.raise_for_status()
        return resp.json()
    except httpx.ConnectError:
        raise HTTPException(502, f"Cannot reach ViDi server at {_base_url()}")
    except httpx.TimeoutException:
        raise HTTPException(504, "ViDi server request timed out")
    except httpx.TransportError as e:
        raise HTTPException(502, f"Connection error: {type(e).__name__}")
    except httpx.HTTPStatusError as e:
        ct = e.response.headers.get("content-type", "")
        detail = e.response.json() if "json" in ct else e.response.text
        raise HTTPException(e.response.status_code, detail=detail)


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _client
    _client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=120.0))
    log.info("ViDi Client started — remote server: %s", _base_url())
    yield
    await _client.aclose()
    log.info("ViDi Client stopped")


app = FastAPI(title="ViDi Client Control Panel", version="1.0.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Settings endpoints
# ---------------------------------------------------------------------------

class SettingsUpdate(BaseModel):
    vidi_server_host: Optional[str] = None
    vidi_server_port: Optional[int] = None
    upload_share_path: Optional[str] = None


@app.get("/api/settings")
async def get_settings():
    return {
        "vidi_server_host": _runtime_host or settings.vidi_server_host,
        "vidi_server_port": _runtime_port or settings.vidi_server_port,
        "upload_share_path": _share_path(),
        "vidi_base_url": _base_url(),
    }


@app.put("/api/settings")
async def update_settings(body: SettingsUpdate):
    global _runtime_host, _runtime_port, _runtime_share
    if body.vidi_server_host is not None:
        _runtime_host = body.vidi_server_host
    if body.vidi_server_port is not None:
        _runtime_port = body.vidi_server_port
    if body.upload_share_path is not None:
        _runtime_share = body.upload_share_path
    return await get_settings()


@app.get("/api/settings/test-connection")
async def test_connection():
    t0 = time.monotonic()
    try:
        result = await vidi_request("GET", "/api/v1/health")
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {"connected": True, "latency_ms": latency_ms, **result}
    except HTTPException as e:
        latency_ms = round((time.monotonic() - t0) * 1000)
        return {"connected": False, "latency_ms": latency_ms, "error": str(e.detail)}


# ---------------------------------------------------------------------------
# Status / GPU
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    return await vidi_request("GET", "/api/v1/health")


@app.get("/api/gpu")
async def gpu_info():
    return await vidi_request("GET", "/api/v1/gpu")


# ---------------------------------------------------------------------------
# Workspaces
# ---------------------------------------------------------------------------

class CreateWorkspaceBody(BaseModel):
    name: str
    tool_name: str = "Analyze"
    tool_type: str = "red"
    stream_name: str = "default"
    path: Optional[str] = None


class OpenWorkspaceBody(BaseModel):
    path: str


@app.get("/api/workspaces")
async def list_workspaces():
    return await vidi_request("GET", "/api/v1/workspaces")


@app.post("/api/workspaces")
async def create_workspace(body: CreateWorkspaceBody):
    return await vidi_request("POST", "/api/v1/workspaces", json=body.model_dump(exclude_none=True))


@app.post("/api/workspaces/{name}/open")
async def open_workspace(name: str, request: Request):
    """Open an existing workspace from disk."""
    body_data = await request.json()
    body = OpenWorkspaceBody(**body_data)
    return await vidi_request("POST", f"/api/v1/workspaces/{name}/open", json=body.model_dump())


@app.post("/api/workspaces/{name}/close")
async def close_workspace(name: str):
    return await vidi_request("POST", f"/api/v1/workspaces/{name}/close")


# ---------------------------------------------------------------------------
# Import (server paths)
# ---------------------------------------------------------------------------

class ImportFromDirBody(BaseModel):
    workspace: str
    stream: str = "default"
    tool: str = "Analyze"
    tool_type: str = "red"
    image_dir: str
    label_dir: Optional[str] = None
    annotation_format: str = "yolo_seg"
    defect_class_name: str = "bad"
    class_map: Optional[dict[str, str]] = None


@app.post("/api/import/from-directory")
async def import_from_directory(body: ImportFromDirBody):
    return await vidi_request("POST", "/api/v1/import/from-directory", json=body.model_dump(exclude_none=True))


# ---------------------------------------------------------------------------
# Import (local upload)
# ---------------------------------------------------------------------------

@app.post("/api/import/upload")
async def upload_and_import(
    workspace: str = Form(...),
    tool: str = Form("Analyze"),
    tool_type: str = Form("red"),
    annotation_format: str = Form("yolo_seg"),
    defect_class_name: str = Form("bad"),
    images: list[UploadFile] = File(...),
    labels: Optional[list[UploadFile]] = File(None),
):
    share = _share_path()
    if not share:
        raise HTTPException(400, "upload_share_path not configured. Set it in Settings.")

    batch_dir = os.path.join(share, datetime.now().strftime("%Y%m%d_%H%M%S"))
    img_dir = os.path.join(batch_dir, "images")
    os.makedirs(img_dir, exist_ok=True)

    for f in images:
        dst = os.path.join(img_dir, f.filename)
        async with aiofiles.open(dst, "wb") as out:
            while chunk := await f.read(1024 * 256):
                await out.write(chunk)

    body = {
        "workspace": workspace,
        "tool": tool,
        "tool_type": tool_type,
        "image_dir": img_dir,
        "annotation_format": annotation_format,
        "defect_class_name": defect_class_name,
    }

    if labels:
        lbl_dir = os.path.join(batch_dir, "labels")
        os.makedirs(lbl_dir, exist_ok=True)
        for f in labels:
            dst = os.path.join(lbl_dir, f.filename)
            async with aiofiles.open(dst, "wb") as out:
                while chunk := await f.read(1024 * 256):
                    await out.write(chunk)
        body["label_dir"] = lbl_dir

    return await vidi_request("POST", "/api/v1/import/from-directory", json=body)


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

class StartTrainingBody(BaseModel):
    workspace: str
    stream: str = "default"
    tool: str = "Analyze"
    gpu_list: str = ""
    artifact: str = "normal"


class ExportBody(BaseModel):
    workspace: str
    output_path: str


@app.post("/api/training/start")
async def start_training(body: StartTrainingBody):
    return await vidi_request("POST", "/api/v1/training/start", json=body.model_dump())


@app.get("/api/training/{job_id}/status")
async def training_status(job_id: str):
    return await vidi_request("GET", f"/api/v1/training/{job_id}/status")


@app.post("/api/training/{job_id}/cancel")
async def cancel_training(job_id: str):
    return await vidi_request("POST", f"/api/v1/training/{job_id}/cancel")


@app.post("/api/training/export")
async def export_runtime(body: ExportBody):
    return await vidi_request("POST", "/api/v1/training/export", json=body.model_dump())


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

@app.get("/api/jobs")
async def list_jobs():
    return await vidi_request("GET", "/api/v1/jobs")


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    return await vidi_request("GET", f"/api/v1/jobs/{job_id}")


# ---------------------------------------------------------------------------
# Static files (MUST be last — catches all unmatched routes)
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory="static", html=True), name="static")
