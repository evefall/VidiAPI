#!/usr/bin/env python3
"""
Test script for GPU training queue functionality.

Demonstrates that multiple concurrent training requests get queued
instead of conflicting with each other.

Usage:
    python test_training_queue.py
"""

import asyncio
import httpx
import json
from datetime import datetime

# Client settings
VIDI_SERVER = "http://localhost:8000"  # FastAPI server


async def start_training(ws_name: str, job_num: int) -> str:
    """Start a training job and return the job ID."""
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{VIDI_SERVER}/api/v1/training/start",
            json={
                "workspace": ws_name,
                "stream": "default",
                "tool": "Analyze",
                "gpu_list": "",
                "artifact": "normal"
            }
        )
        resp.raise_for_status()
        data = resp.json()
        job_id = data["id"]
        print(f"[{job_num}] Training started: Job ID {job_id}")
        return job_id


async def poll_job_status(job_id: str, job_num: int, interval: float = 2.0):
    """Poll a job's status and display updates."""
    async with httpx.AsyncClient(timeout=30) as client:
        previous_status = None
        while True:
            try:
                resp = await client.get(f"{VIDI_SERVER}/api/v1/training/{job_id}/status")
                resp.raise_for_status()
                job = resp.json()

                status = job["status"]
                progress = int(job["progress"] * 100)
                message = job.get("message", "")

                # Only print when status changes or progress updates
                if status != previous_status or status == "running":
                    time_str = datetime.now().strftime("%H:%M:%S")
                    print(f"[{time_str}] Job {job_num} ({job_id[:8]}): {status:8} | {progress:3}% | {message}")
                    previous_status = status

                # Stop when job completes
                if status in ["completed", "failed", "cancelled"]:
                    if job.get("error"):
                        print(f"  ERROR: {job['error']}")
                    break

                await asyncio.sleep(interval)
            except Exception as e:
                print(f"[ERROR] Job {job_num}: {e}")
                break


async def test_queue(workspace: str, num_jobs: int = 3):
    """
    Test the training queue by starting multiple concurrent jobs.

    Expected behavior:
    - First job starts training immediately (status=running)
    - Other jobs wait in queue (status=queued)
    - As each job completes, the next one starts
    """
    print("\n" + "="*70)
    print(f"Testing Training Queue with {num_jobs} concurrent jobs")
    print(f"Workspace: {workspace}")
    print("="*70 + "\n")

    # Start all jobs concurrently
    job_ids = []
    print("Starting jobs...")
    for i in range(num_jobs):
        job_id = await start_training(workspace, i + 1)
        job_ids.append((job_id, i + 1))
        await asyncio.sleep(0.5)  # Small delay between requests

    print(f"\nAll {num_jobs} jobs submitted. Monitoring status...\n")

    # Poll all jobs concurrently
    tasks = [poll_job_status(job_id, job_num) for job_id, job_num in job_ids]
    await asyncio.gather(*tasks)

    print("\n" + "="*70)
    print("Queue test complete!")
    print("="*70 + "\n")


async def main():
    """Main test runner."""
    # Get workspace name from user or use default
    print("GPU Training Queue Test")
    print("-" * 70)
    workspace = input("Enter workspace name (or press Enter for 'test'): ").strip() or "test"

    try:
        await test_queue(workspace, num_jobs=3)
    except Exception as e:
        print(f"\nTest failed: {e}")


if __name__ == "__main__":
    asyncio.run(main())
