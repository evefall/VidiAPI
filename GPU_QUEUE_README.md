# GPU Training Queue

## Overview

The ViDi Training API now includes **GPU queue serialization** to safely handle multiple concurrent training requests from different users. When multiple users submit training jobs simultaneously, they are automatically queued rather than conflicting with each other.

## Problem

The ViDi C DLL can only run one training job at a time per workspace. When multiple users connected to the server tried to start training simultaneously:
- Jobs would conflict and fail
- GPU resources would be used inefficiently
- Error handling was unclear

## Solution: Training Queue

A thread-safe `TrainingQueue` class serializes all training requests:

1. **Job Submission** (immediate)
   - Client submits training request via `POST /api/v1/training/start`
   - Server creates job with status `QUEUED`
   - Returns immediately with job ID for polling

2. **Queue Wait** (automatic)
   - If GPU is busy, job waits in queue
   - Message: "Waiting for GPU..."
   - Client polls status every 2 seconds to see when it starts
   - Maximum wait time: 50 minutes (configurable)

3. **GPU Acquired** (when previous job finishes)
   - Status changes to `RUNNING`
   - Training begins on the ViDi GPU
   - Progress updates every 5 seconds

4. **Completion** (when training finishes)
   - Status changes to `COMPLETED` or `FAILED`
   - GPU is automatically released
   - Next queued job can now start

## Job Status Flow

```
QUEUED
  ↓ (when GPU becomes available)
RUNNING
  ↓ (training complete)
COMPLETED (or FAILED if error)
```

## Implementation Details

### Server-side (training_service.py)

```python
class TrainingQueue:
    def acquire(job_id: str, max_wait_iterations: int = 600) -> bool:
        """Wait until GPU is free, then acquire for this job."""
        # Blocks in 5-second intervals until GPU is available
        # Returns False if timeout exceeded
        
    def release(job_id: str):
        """Release GPU and notify next waiting job."""
        # Called in finally block to guarantee cleanup

    def is_gpu_busy(engine: ViDiEngine, ws: str, stream: str) -> bool:
        """Check if any tool is currently training."""
        # Parses tool status XML to detect busy=true
```

### Client-side (app.js & index.html)

The web UI already displays queued jobs:

- **Jobs Tab**: Shows all jobs with status color-coding
  - Green badge: `RUNNING`
  - Yellow badge: `QUEUED`
  - Blue badge: `COMPLETED`
  - Red badge: `FAILED`

- **Polling**:
  - Fast polling (2 sec) when jobs are running or queued
  - Slow polling (8 sec) when idle
  - Automatic detection of active jobs

- **Sorting**:
  - Running jobs listed first
  - Queued jobs listed second
  - Completed/failed jobs listed after

## Usage Example

### Starting a Training Job

```bash
curl -X POST http://localhost:8000/api/v1/training/start \
  -H "Content-Type: application/json" \
  -d '{
    "workspace": "my_workspace",
    "stream": "default",
    "tool": "Analyze",
    "gpu_list": "",
    "artifact": "normal"
  }'
```

Response (immediate):
```json
{
  "id": "abc12345",
  "type": "training",
  "status": "queued",
  "progress": 0.0,
  "message": "Waiting for GPU...",
  "created_at": "2026-04-15T14:30:00",
  "started_at": null,
  "completed_at": null
}
```

### Polling Job Status

```bash
# Poll every 2-5 seconds
curl http://localhost:8000/api/v1/training/abc12345/status

# Response when queued:
{
  "id": "abc12345",
  "status": "queued",
  "progress": 0.0,
  "message": "Waiting for GPU..."
}

# Response when running:
{
  "id": "abc12345",
  "status": "running",
  "progress": 0.45,
  "message": "Training 45/100 epochs...",
  "started_at": "2026-04-15T14:32:00"
}

# Response when complete:
{
  "id": "abc12345",
  "status": "completed",
  "progress": 1.0,
  "message": "Training completed",
  "completed_at": "2026-04-15T14:45:00"
}
```

### Canceling a Job

Only `RUNNING` jobs can be canceled:

```bash
curl -X POST http://localhost:8000/api/v1/training/abc12345/cancel
```

If job is `QUEUED`, wait for it to start training before canceling.

## Testing the Queue

Run the included test script to simulate multiple concurrent training requests:

```bash
python test_training_queue.py
```

This script:
1. Starts 3 training jobs as fast as possible
2. Polls all jobs concurrently
3. Shows job status in real-time
4. Demonstrates queuing behavior

Expected output:
```
[HH:MM:SS] Job 1 (abc12345): queued   |   0%
[HH:MM:SS] Job 2 (def67890): queued   |   0%
[HH:MM:SS] Job 3 (ghi11111): queued   |   0%
[HH:MM:SS] Job 1 (abc12345): running  |   5%
[HH:MM:SS] Job 1 (abc12345): running  | 25%
[HH:MM:SS] Job 1 (abc12345): running  | 50%
[HH:MM:SS] Job 1 (abc12345): running  | 100%
[HH:MM:SS] Job 1 (abc12345): completed| 100%
[HH:MM:SS] Job 2 (def67890): running  |   5%
```

## Configuration

### Maximum Wait Time

Default: 600 iterations × 5 seconds = **50 minutes**

To change, modify in `training_service.py`:

```python
acquired = _training_queue.acquire(job.id, max_wait_iterations=120)  # 10 minutes
```

### Poll Interval

The queue polls GPU status every 5 seconds in the `acquire()` method.
To make it respond faster (uses more CPU):

```python
self._condition.wait(timeout=2.0)  # 2 seconds instead of 5
```

## Troubleshooting

### "GPU timeout - exceeded max wait time"

- Job waited 50 minutes without GPU becoming available
- Possible causes:
  - A previous training job is stuck or hung
  - Server process crashed but job status wasn't updated
  - GPU error caused training to hang indefinitely

**Solution**: 
- Cancel the previous job via the web UI
- Or restart the server

### Job stuck in "Waiting for GPU..." state

If polling shows a job permanently stuck:
- Check server logs for errors
- Check if any tool shows `busy="true"` in tool status XML
- Try restarting the server

### Multiple jobs running simultaneously

This shouldn't happen, but if observed:
- Close all browser tabs and reconnect
- Restart the server to reset queue state
- Verify git repo is up-to-date with latest code

## Performance Notes

- **Serialization overhead**: Jobs wait for GPU, not CPU-bound (minimal impact)
- **Concurrent clients**: Hundreds of clients can submit jobs; only GPU utilization is serialized
- **Memory**: Queue stores job metadata only (~1KB per job), not actual training data
- **Thread-safe**: Uses `threading.Condition` with proper locking

## Future Enhancements

Possible improvements for future versions:
- Priority queue (VIP users get served first)
- GPU affinity (specific jobs to specific GPUs)
- Time-based scheduling (schedule training for off-peak hours)
- Dynamic queue reordering
- Webhook notifications when job starts/completes

## See Also

- [VidiImportAnnotation README](VidiImportAnnotation/README.md)
- [Training Endpoints API](VidiImportAnnotation/docs/api.md)
- [Job Status Polling Guide](static/jobs-guide.md)
