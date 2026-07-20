from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    origin: str


@dataclass(frozen=True)
class BackendConfig:
    host: str
    port: int


@dataclass(frozen=True)
class StorageConfig:
    database_path: Path
    backup_directory: Path
    initial_csv_path: Path


@dataclass(frozen=True)
class ReceiptConfig:
    max_upload_bytes: int
    max_pixels: int


@dataclass(frozen=True)
class OcrConfig:
    languages: tuple[str, ...]
    timeout_seconds: int
    max_concurrent_jobs: int
    translation_fallback: bool


@dataclass(frozen=True)
class Config:
    server: ServerConfig
    backend: BackendConfig
    storage: StorageConfig
    receipts: ReceiptConfig
    ocr: OcrConfig


_cached: Config | None = None


def _positive_int(value: Any, name: str, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{name} must be a positive integer")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must not exceed {maximum}")
    return value


def _path(value: Any, name: str, base: Path) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty path")
    path = Path(value)
    return path if path.is_absolute() else (base / path).resolve()


def load_config() -> Config:
    global _cached
    if _cached is not None:
        return _cached

    config_path = Path(os.environ.get("HAKUI_CONFIG", "./config/hakui.json")).resolve()
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    server = raw.get("server", {})
    backend = raw.get("backend", {})
    storage = raw.get("storage", {})
    receipts = raw.get("receipts", {})
    ocr = raw.get("ocr", {})

    host = server.get("host")
    origin = server.get("origin")
    if not isinstance(host, str) or not host:
        raise ValueError("server.host must be a non-empty string")
    if not isinstance(origin, str) or not origin.startswith(("http://", "https://")):
        raise ValueError("server.origin must be an HTTP(S) URL")
    server_port = _positive_int(server.get("port"), "server.port", 65535)

    backend_host = backend.get("host", "127.0.0.1")
    if not isinstance(backend_host, str) or not backend_host:
        raise ValueError("backend.host must be a non-empty string")

    languages = ocr.get("languages")
    if not isinstance(languages, list) or not languages or not all(isinstance(item, str) and item for item in languages):
        raise ValueError("ocr.languages must be a non-empty list of strings")

    _cached = Config(
        server=ServerConfig(host=host, port=server_port, origin=origin),
        backend=BackendConfig(
            host=backend_host,
            port=_positive_int(backend.get("port", server_port + 1), "backend.port", 65535),
        ),
        storage=StorageConfig(
            database_path=_path(storage.get("databasePath"), "storage.databasePath", Path.cwd()),
            backup_directory=_path(storage.get("backupDirectory"), "storage.backupDirectory", Path.cwd()),
            initial_csv_path=_path(storage.get("initialCsvPath"), "storage.initialCsvPath", Path.cwd()),
        ),
        receipts=ReceiptConfig(
            max_upload_bytes=_positive_int(receipts.get("maxUploadBytes"), "receipts.maxUploadBytes"),
            max_pixels=_positive_int(receipts.get("maxPixels"), "receipts.maxPixels"),
        ),
        ocr=OcrConfig(
            languages=tuple(languages),
            timeout_seconds=_positive_int(ocr.get("timeoutSeconds"), "ocr.timeoutSeconds", 120),
            max_concurrent_jobs=_positive_int(ocr.get("maxConcurrentJobs"), "ocr.maxConcurrentJobs", 4),
            translation_fallback=bool(ocr.get("translationFallback", True)),
        ),
    )
    return _cached
