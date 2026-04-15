"""Entry point for the ViDi Client Control Panel."""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "vidi_client:app",
        host="127.0.0.1",
        port=8080,
        reload=True,
    )
