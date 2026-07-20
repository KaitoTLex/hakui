from __future__ import annotations

import logging

import uvicorn

from hakui.config import load_config


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = load_config()
    uvicorn.run("hakui.app:app", host=config.backend.host, port=config.backend.port, workers=1, proxy_headers=False)
