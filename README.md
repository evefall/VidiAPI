# ViDi Training API

Complete REST API for Cognex ViDi Deep Learning control via FastAPI + web UI.

## Features

✅ **Web Control Panel**
- Browser-based workspace management
- Remote import of good/bad images (Red Analyze, Blue Locate)
- Real-time training monitoring with progress bars
- GPU queue for multi-user safety

✅ **Workspace Management**
- Create, open, close workspaces
- Auto-open workspaces on server restart
- Stream and tool configuration

✅ **Image Import**
- Upload via web UI or file system paths
- Good/Bad classification for Red Analyze tool
- Bounding box annotations for Blue Locate tool
- Support for .jpg, .png, .bmp, .tif, .gif and more
- Swedish character support (å, ä, ö)

✅ **Training**
- Start asynchronous training jobs
- Monitor progress in real-time
- Cancel running training
- **GPU Queue Serialization** — Multiple users queue jobs safely

✅ **Export**
- Export trained workspaces as .vrws runtime files
- Ready for deployment to production ViDi systems

## Quick Start

### Prerequisites

- Windows 10/11 with Python 3.9+
- Cognex ViDi 4.0 with C API (vidi_80.dll)
- ViDi server running (default: 10.0.0.102:8042)

### Installation

```bash
# Clone repo with submodules
git clone --recursive https://github.com/evefall/VidiAPI.git
cd VidiAPI

# Install dependencies
pip install -r requirements.txt

# Start server
python run_server.py

# Start web client (separate terminal)
python run_client.py
```

Server: http://localhost:8000
Client: http://localhost:8001

### Docker (Optional)

```dockerfile
FROM python:3.11-slim-windows
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
CMD ["python", "run_server.py"]
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Web UI (Browser)                         │
│  - Workspace management                                     │
│  - Import images (good/bad)                                │
│  - Training control & monitoring                            │
│  - Job queue visualization                                  │
└────────────┬────────────────────────────────────────────────┘
             │ HTTP/JSON
             ↓
┌─────────────────────────────────────────────────────────────┐
│                  FastAPI Server                             │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Training Queue (NEW)                                │   │
│  │ - Serializes training requests                      │   │
│  │ - Prevents GPU conflicts                            │   │
│  │ - Queues multi-user jobs                            │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ Routers ─────────────────────────────────────────────┐ │
│  │ • /workspace/* — Create, open, close workspaces     │ │
│  │ • /import/*    — Upload and process images          │ │
│  │ • /training/*  — Start, status, cancel, export      │ │
│  │ • /jobs/*      — List and track all jobs            │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Services ────────────────────────────────────────────┐ │
│  │ • training_service    — GPU queue + training logic  │ │
│  │ • import_service      — Image processing             │ │
│  │ • job_manager         — Job tracking                 │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ ViDi Engine (ctypes) ────────────────────────────────┐ │
│  │ • Thread-safe wrapper for vidi_80.dll               │ │
│  │ • Workspace lifecycle management                     │ │
│  │ • Training control (start, wait, cancel)            │ │
│  │ • Status queries & exports                           │ │
│  └────────────────────────────────────────────────────────┘ │
└────────────┬────────────────────────────────────────────────┘
             │ ctypes/Windows API
             ↓
┌─────────────────────────────────────────────────────────────┐
│            ViDi C API (vidi_80.dll)                         │
│            Cognex VisionPro Deep Learning                   │
└────────────┬────────────────────────────────────────────────┘
             │
             ↓
    ┌─────────────────┐
    │ GPU (Training)  │
    └─────────────────┘
```

## File Structure

```
VidiAPI/
├── VidiImportAnnotation/          # Server submodule
│   ├── app/
│   │   ├── main.py                # FastAPI app, auto-open workspaces
│   │   ├── models/
│   │   │   └── schemas.py         # Pydantic request/response models
│   │   ├── routers/
│   │   │   ├── workspace.py
│   │   │   ├── import.py
│   │   │   └── training.py
│   │   ├── services/
│   │   │   ├── training_service.py   # ← NEW: GPU queue logic
│   │   │   ├── import_service.py
│   │   │   └── job_manager.py
│   │   └── vidi/
│   │       ├── engine.py          # ViDi DLL wrapper (thread-safe)
│   │       └── ctypes_bindings.py # C API bindings
│   └── requirements.txt
│
├── static/                         # Web UI
│   ├── app.js                      # Handles queued status polling
│   ├── index.html
│   └── style.css
│
├── vidi_client.py                  # FastAPI reverse proxy
├── run_client.py                   # Start client server
├── run_server.py                   # Start main server
│
├── GPU_QUEUE_README.md             # ← NEW: Queue documentation
├── test_training_queue.py          # ← NEW: Queue testing
└── README.md                       # This file
```

## GPU Queue (NEW)

When multiple users submit training requests simultaneously, they automatically queue instead of conflicting:

```
User 1 submits → Job A starts immediately (RUNNING)
User 2 submits → Job B queues (QUEUED)
User 3 submits → Job C queues (QUEUED)

After Job A finishes:
  Job B starts (QUEUED → RUNNING)
  Job C waits
  
After Job B finishes:
  Job C starts (QUEUED → RUNNING)
```

**Key Benefits:**
- ✅ No GPU conflicts between users
- ✅ Jobs process in FIFO order
- ✅ Real-time queue monitoring via web UI
- ✅ Automatic timeout after 50 minutes
- ✅ Graceful cancellation

**See:** [GPU_QUEUE_README.md](GPU_QUEUE_README.md) for detailed documentation and usage examples.

## API Examples

### Create Workspace

```bash
curl -X POST http://localhost:8000/api/v1/workspace/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my_workspace",
    "tool_name": "Analyze",
    "tool_type": "red",
    "stream_name": "default"
  }'
```

### Import Good Images (Red Analyze)

```bash
curl -X POST http://localhost:8000/api/v1/import/directory \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "my_workspace",
    "image_dir": "C:\\data\\good_images",
    "tool_type": "red"
  }'
```

### Import Bad Images with Annotations (Red Analyze)

```bash
curl -X POST http://localhost:8000/api/v1/import/directory \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "my_workspace",
    "image_dir": "C:\\data\\bad_images",
    "label_dir": "C:\\data\\bad_labels",
    "tool_type": "red",
    "annotation_format": "yolo_seg"
  }'
```

### Start Training (Auto-queued if GPU busy)

```bash
curl -X POST http://localhost:8000/api/v1/training/start \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "my_workspace",
    "artifact": "normal"
  }'

# Returns immediately with job ID
# Status will be "queued" if GPU is busy
```

### Poll Training Progress

```bash
curl http://localhost:8000/api/v1/training/abc12345/status

# Response:
# {
#   "id": "abc12345",
#   "status": "running|queued|completed|failed",
#   "progress": 0.45,
#   "message": "Training in progress..."
# }
```

## Configuration

### Server Settings

Edit `VidiImportAnnotation/app/config.py`:

```python
class Settings:
    workspace_base_path = "C:\\ViDi\\workspaces"
    vidi_api_addr = ""  # Empty = auto-detect
    vidi_api_port = ""  # Empty = auto-detect
    max_file_size = 100 * 1024 * 1024  # 100 MB
```

### Client Settings

Edit `vidi_client.py`:

```python
class ClientSettings:
    vidi_server_host = "10.0.0.102"
    vidi_server_port = 8042
    upload_share_path = r"\\server\share\uploads"
```

## Job Status Codes

| Status | Meaning | Next Step |
|--------|---------|-----------|
| `queued` | Waiting for GPU to become available | Wait (monitor in Jobs tab) |
| `running` | Training actively in progress | Monitor progress |
| `completed` | Training finished successfully | Export model (.vrws) |
| `failed` | Training encountered an error | Check error message, try again |
| `cancelled` | Job was manually cancelled by user | Start new job |

## Troubleshooting

### "Workspace not found"

- Workspace may not exist or is not open
- **Solution**: Create workspace in Workspaces tab, or use auto-open

### "GPU timeout - exceeded max wait time"

- Job waited 50 minutes without getting GPU
- **Solution**: Cancel stuck job, restart server if needed

### Swedish characters not supported (å, ä, ö)

- Should work automatically (fixed in recent version)
- Uses Windows ANSI (mbcs) encoding for paths
- **Solution**: Ensure file paths use UTF-8, server will convert

### Job polling shows no updates

- Polling interval may be too slow
- **Solution**: Click Jobs tab to refresh, or check server logs

## Development

### Running Tests

```bash
# Test GPU queue with 3 concurrent jobs
python test_training_queue.py

# Run pytest suite (if available)
pytest VidiImportAnnotation/tests/
```

### Building for Production

```bash
# Build server Docker image
docker build -f Dockerfile -t vidi-api:latest .

# Run in container
docker run -p 8000:8000 vidi-api:latest
```

### Debugging

Enable debug logging:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

Check server logs:
- Windows Event Viewer: Application logs
- Console output when running `python run_server.py`

## Contributing

Improvements welcome! Key areas:
- Priority queue support
- Multi-GPU scheduling
- Prometheus metrics export
- Advanced status XML parsing

## License

MIT — See LICENSE file

## Support

- 📚 Docs: [GPU_QUEUE_README.md](GPU_QUEUE_README.md)
- 🐛 Issues: [GitHub Issues](https://github.com/evefall/VidiAPI/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/evefall/VidiAPI/discussions)

## Related Repositories

- [VidiImportAnnotation](https://github.com/evefall/VidiImportAnnotation) — Main server submodule
- [VidiAPI](https://github.com/evefall/VidiAPI) — This repo (wrapper + client)

---

**Version**: 2.0 (GPU Queue Serialization)  
**Last Updated**: April 15, 2026  
**Status**: Production Ready ✅
