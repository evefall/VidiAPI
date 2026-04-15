# GPU Training Queue - Visual Flow Guide

## Request Timeline (Multiple Users Scenario)

```
TIME    USER 1              USER 2              USER 3            GPU STATE
─────────────────────────────────────────────────────────────────────────────

00:00   [Submit Job A]                                              IDLE
        Status: QUEUED → RUNNING
        msg: "Training started..."

00:05                       [Submit Job B]                          BUSY
                            Status: QUEUED
                            msg: "Waiting for GPU..."

00:10                                           [Submit Job C]      BUSY
                                                Status: QUEUED
                                                msg: "Waiting for GPU..."

00:15   [Job A]                                                     BUSY
        45% progress
        "Training 45/100..."

00:30   [Job A]                                                     BUSY
        95% progress
        "Training 95/100..."

00:35   [Job A COMPLETED] ──→ Release GPU                           IDLE
        Status: COMPLETED                                           ↓
                                                                  ACQUIRE
        ────────────────────────────────→ [Job B] RUNNING ← ──── [User 2]
                                          0% progress
                                          "Training started..."

00:50                       [Job B]                                 BUSY
                            75% progress
                            "Training 75/100..."

01:05                       [Job B COMPLETED] ──→ Release GPU       IDLE
                            Status: COMPLETED                       ↓
                                                                  ACQUIRE
                                                    ────────────→ [Job C] RUNNING
                                                                  0% progress

01:20                                           [Job C]             BUSY
                                                50% progress

01:35                                           [Job C COMPLETED]   IDLE
                                                Status: COMPLETED
```

## State Diagram

```
                    ┌─────────────────────────────────────────┐
                    │        Job Creation (QUEUED)            │
                    │  Client submits /training/start          │
                    │  Returns immediately with Job ID         │
                    └──────────────────┬──────────────────────┘
                                       │
                        ┌──────────────┴─────────────────┐
                        │                                │
                        ↓                                ↓
            ┌──────────────────────┐      ┌──────────────────────┐
            │   GPU is FREE        │      │   GPU is BUSY        │
            │   ↓                  │      │   ↓                  │
            │ Immediately acquire │      │ Wait in Queue        │
            │ Move to RUNNING      │      │ Poll every 5s        │
            └──────┬───────────────┘      │ Max wait: 50 min     │
                   │                      └──────┬───────────────┘
                   │                             │
                   └─────────────┬───────────────┘
                                 │
                                 ↓
                    ┌─────────────────────────────────────────┐
                    │         RUNNING (Training)              │
                    │                                         │
                    │  ViDi tool status: busy="true"          │
                    │  Progress: 0% → 100%                    │
                    │  Poll every 5 seconds                   │
                    └──────────────────┬──────────────────────┘
                                       │
                        ┌──────────────┴──────────────────┐
                        │                                 │
                        ↓                                 ↓
            ┌──────────────────────┐      ┌──────────────────────┐
            │  COMPLETED           │      │  FAILED              │
            │  ↓                   │      │  ↓                   │
            │ Success              │      │ Training Error       │
            │ Progress = 100%      │      │ Error Message Set    │
            │ Save workspace       │      │ Release GPU          │
            │ Release GPU ✓        │      │ Release GPU ✓        │
            └──────────────────────┘      └──────────────────────┘
```

## Code Flow in run_training()

```python
def run_training(engine: ViDiEngine, job: Job):
    """Execute training with GPU queue serialization."""
    
    try:
        # 1. WAIT IN QUEUE (if GPU busy)
        job_manager.update(job.id, message="Waiting for GPU...")
        acquired = _training_queue.acquire(job.id)  # ← BLOCKS HERE if GPU busy
        
        if not acquired:
            raise RuntimeError("GPU timeout")
        
        # 2. GPU ACQUIRED → START TRAINING
        job_manager.update(job.id, status=JobStatus.RUNNING)
        engine.start_training(ws, stream, tool)  # Non-blocking start
        job_manager.update(job.id, message="Training started...")
        
        # 3. POLL UNTIL DONE
        while True:
            result = engine.wait_training(ws, stream, tool, timeout_ms=5000)
            xml = engine.get_tool_status_xml(ws, stream)
            info = _parse_training_status(xml, tool)
            
            job_manager.update(
                job.id,
                progress=info["progress"],
                message=info["description"]
            )
            
            if not info["busy"]:
                break  # Training complete
        
        # 4. SAVE & MARK COMPLETE
        engine.save_workspace(ws)
        job_manager.update(
            job.id,
            status=JobStatus.COMPLETED,
            progress=1.0
        )
        
    except Exception as e:
        # ERROR HANDLING
        job_manager.update(
            job.id,
            status=JobStatus.FAILED,
            error=str(e)
        )
    
    finally:
        # 5. ALWAYS RELEASE GPU (allows next job to start)
        _training_queue.release(job.id)  # ← CRITICAL for queue to work
```

## Thread Synchronization (Concurrency)

```
                    Thread Pool (Worker Threads)
    ┌───────────────────────────────────────────────────────┐
    │                                                       │
    │  Thread-1 (Job A)       Thread-2 (Job B)             │
    │  ├─ acquire(A) ──╮      ├─ acquire(B) ──╮           │
    │  │ SUCCESS ✓    │      │ WAITS HERE  │            │
    │  └─ train()     │      │ wait() wait() │            │
    │   └─ release(A) │      │ ...         │            │
    │                │      └─ SUCCESS ✓  │ (notified)  │
    │                │          train()   │            │
    │                └──→ Condition.notify_all()         │
    │                        release(B)  │            │
    │                                   └──→ SUCCESS ✓
    │
    └───────────────────────────────────────────────────────┘
    
    TrainingQueue (Shared State)
    ┌───────────────────────────────────────────────────────┐
    │  _active_job_id: Optional[str] = "Job-A"            │
    │  _lock: threading.Lock()                             │
    │  _condition: threading.Condition()                   │
    │                                                       │
    │  State transitions:                                  │
    │    None (IDLE) → "Job-A" (RUNNING)                  │
    │    "Job-A" (RUNNING) → None (IDLE)                  │
    │    None (IDLE) → "Job-B" (RUNNING)                  │
    └───────────────────────────────────────────────────────┘
```

## Web UI Job Display

```
┌─────────────────────────────────────────────────────────────────────┐
│                         JOBS TAB (Real-time)                        │
├────────┬──────────┬──────────┬──────────┬─────────────┬─────────────┤
│ Job ID │ Type     │ Status   │ Progress │ Message     │ Time        │
├────────┼──────────┼──────────┼──────────┼─────────────┼─────────────┤
│ abc123 │ training │ 🟢 RUNNING│ 45%     │ Training... │ 14:32:15    │
│ def456 │ training │ 🟡 QUEUED │ 0%      │ Waiting for │ 14:32:10    │
│        │          │          │         │ GPU...      │             │
│ ghi789 │ training │ 🟡 QUEUED │ 0%      │ Waiting for │ 14:32:05    │
│        │          │          │         │ GPU...      │             │
│ xyz111 │ import   │ ✅ COMPLETE│ 100%   │ Import done │ 14:30:00    │
│ xyz222 │ training │ ✅ COMPLETE│ 100%   │ Training    │ 14:28:50    │
│        │          │          │         │ completed   │             │
│ xyz333 │ training │ ❌ FAILED │ 85%     │ GPU Error   │ 14:27:00    │
└────────┴──────────┴──────────┴──────────┴─────────────┴─────────────┘

Legend:
  🟢 RUNNING  - Currently training (GPU acquired)
  🟡 QUEUED   - Waiting for GPU (in queue)
  ✅ COMPLETE - Finished successfully
  ❌ FAILED   - Training error occurred
```

## Polling Strategy (Client)

```javascript
// Smart polling based on job states
async function loadJobs() {
    const jobs = await api.get('/api/jobs');
    
    // Check if any jobs are active
    const hasActive = jobs.some(j => 
        j.status === 'running' || j.status === 'queued'
    );
    
    // Fast poll (2s) when jobs active
    // Slow poll (8s) when idle
    const interval = hasActive ? 2000 : 8000;
    scheduleNextPoll(interval);
}
```

```
Polling Timeline:
────────────────────────────────────────────────────────────────

No jobs running:
Poll every 8s ─────┬────────────────────────────────────────
                 (Refresh)

User submits training:
Poll every 2s ─┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──...─┬──┬──┐
              │  │  │  │  │  │  │  │  │  │      │  │  │
            Q→R  15% 30% 45% ...     100% [DONE]

Switch to slow polling:
Poll every 8s ─────┬────────────────────────────────────────
                (Refresh occasionally)
```

## Network Diagram

```
┌──────────────────┐
│  Browser         │ User 1, User 2, User 3
│  Web UI          │ (any number of concurrent users)
└────────┬─────────┘
         │ HTTP REST
         │ POST /api/v1/training/start
         │ GET  /api/v1/training/{job_id}/status
         │ (polling every 2-8 seconds)
         ↓
┌──────────────────────────────────────────────┐
│  FastAPI Server (Single Process)             │
│                                              │
│  ┌────────────────────────────────────────┐ │
│  │ TrainingQueue (Singleton)              │ │
│  │ ├─ _lock: threading.Lock()             │ │
│  │ ├─ _condition: threading.Condition()   │ │
│  │ ├─ _active_job_id: Optional[str]       │ │
│  │ ├─ acquire(job_id) → bool              │ │
│  │ └─ release(job_id) → None              │ │
│  └────────────────────────────────────────┘ │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │ JobManager (Singleton)               │  │
│  │ └─ job_dict[job_id] = Job(...)       │  │
│  └──────────────────────────────────────┘  │
│                                              │
│  ┌──────────────────────────────────────┐  │
│  │ Worker Threads (run_training)        │  │
│  │ ├─ Thread-1: Job A                   │  │
│  │ ├─ Thread-2: Job B (waiting)         │  │
│  │ └─ Thread-3: Job C (waiting)         │  │
│  └──────────────────────────────────────┘  │
└────────────┬───────────────────────────────┘
             │ ctypes/Win32
             ↓
┌──────────────────────────────────────────┐
│  ViDi DLL (vidi_80.dll)                  │
│  ├─ vidi_training_tool_train2()          │
│  ├─ vidi_training_tool_wait()            │
│  ├─ vidi_training_stream_list_tools()    │
│  └─ (More C functions...)                │
└────────────┬───────────────────────────┘
             │
             ↓
        ┌─────────┐
        │ GPU     │
        │ (NVIDIA)│
        │ CUDA    │
        └─────────┘
```

## Error Scenarios

### Scenario 1: Job Timeout

```
User 1 submits Job A (gets stuck)
↓
User 2 submits Job B
↓ (waits 5 seconds at a time)
User 2's Job B: "Waiting for GPU..."
↓
[50 minutes pass...]
↓
TIMEOUT!
↓ 
Job B status: FAILED
Job B error: "GPU timeout - exceeded max wait time"
↓
Recommendation: Cancel Job A (manually or via UI), restart server
```

### Scenario 2: Training Error

```
Job C is RUNNING
↓
ViDi tool encounters error (e.g., memory error)
↓
Engine detects error in status XML
↓
Raises RuntimeError("Training error: {...}")
↓
Job C: status=FAILED, error="Training error: ..."
↓
Finally block executes: _training_queue.release(job.id)
↓
Next queued job can now acquire GPU ✓
```

### Scenario 3: Server Crash

```
Job A: RUNNING
Job B: QUEUED
↓
Server crashes/restarts
↓
Jobs lost (in-memory only)
↓
On restart: _training_queue state reset to IDLE
↓
⚠️ Job A status unknown on ViDi server
⚠️ Job B appears to disappear from API
↓
Recommendation: Check workspace status, manually cancel if needed
Note: Use database persistence (future enhancement) to survive restarts
```

## Performance Metrics

```
Queue Overhead:
├─ Memory per job: ~1 KB (metadata only)
├─ Lock contention: Minimal (lock held <1ms)
├─ CPU usage: Negligible (not training)
└─ GPU throughput: No impact (serialization only)

Typical Latencies:
├─ Job submission: < 100 ms
├─ Status poll: < 50 ms (when not training)
├─ GPU acquisition: < 5 s (polling interval)
├─ Training start: < 1 s (after GPU acquired)
└─ Max queue wait: 50 minutes (configurable)
```

## Configuration Parameters

```python
# In training_service.py:

class TrainingQueue:
    # Max poll iterations before timeout
    MAX_WAIT_ITERATIONS = 600         # 600 × 5s = 50 minutes
    
    # Poll interval (seconds)
    POLL_TIMEOUT = 5.0                # Check every 5 seconds
    
    # For future: queue size limit
    # MAX_QUEUE_SIZE = 1000            # (not implemented yet)
```

```python
# In vidi_client.py (client side):

# Polling intervals for Jobs tab
FAST_POLL_INTERVAL = 2000   # 2 seconds when job is active
SLOW_POLL_INTERVAL = 8000   # 8 seconds when idle
```

---

**Next Steps:** 
- Try the test script: `python test_training_queue.py`
- Read [GPU_QUEUE_README.md](GPU_QUEUE_README.md) for detailed API docs
- Monitor queue in web UI Jobs tab
