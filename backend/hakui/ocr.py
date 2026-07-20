from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

from .config import Config
from .database import Database
from .receipt_parser import lines_to_text, parse_receipt_lines, parse_tsv


logger = logging.getLogger(__name__)


class Translator:
    def __init__(self, config: Config):
        self.enabled = config.ocr.translation_fallback
        self.timeout = config.ocr.timeout_seconds

    def translate(self, text: str) -> str:
        if not self.enabled or not text:
            return ""
        if not os.environ.get("HAKUI_TRANSLATION_MODEL"):
            logger.warning("Translation fallback requested but HAKUI_TRANSLATION_MODEL is unset")
            return ""
        try:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("translate_worker.py"))],
                input=text,
                capture_output=True,
                text=True,
                timeout=self.timeout,
                check=True,
            )
            return result.stdout if len(result.stdout) <= 2 * 1024 * 1024 else ""
        except Exception:
            logger.exception("Receipt translation fallback failed")
            return ""


def _command(file: str, arguments: list[str], timeout: int) -> str:
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as output, tempfile.TemporaryFile(mode="w+", encoding="utf-8") as errors:
        result = subprocess.run([file, *arguments], stdout=output, stderr=errors, text=True, timeout=timeout, check=False)
        if output.tell() > 10 * 1024 * 1024:
            raise RuntimeError(f"{file} produced too much output")
        output.seek(0)
        errors.seek(0)
        stdout = output.read()
        stderr = errors.read(2000)
    if result.returncode != 0:
        raise RuntimeError(f"{file} failed: {stderr.strip() or f'exit status {result.returncode}'}")
    return stdout


class OcrProcessor:
    def __init__(self, config: Config):
        self.config = config
        self.translator = Translator(config)

    def process(self, image: bytes) -> dict[str, Any]:
        timeout = self.config.ocr.timeout_seconds
        with tempfile.TemporaryDirectory(prefix="hakui-ocr-") as directory_value:
            directory = Path(directory_value)
            source = directory / "receipt"
            grayscale = directory / "grayscale.png"
            threshold = directory / "threshold.png"
            source.write_bytes(image)

            identity = _command("magick", ["identify", "-format", "%m %w %h", str(source)], timeout)
            parts = identity.strip().split()
            if len(parts) != 3:
                raise ValueError("Unsupported receipt image.")
            image_format, width_value, height_value = parts
            mime_types = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "HEIC": "image/heic"}
            if image_format not in mime_types:
                raise ValueError("Unsupported receipt image.")
            width, height = int(width_value), int(height_value)
            if width < 1 or height < 1 or width * height > self.config.receipts.max_pixels:
                raise ValueError("Receipt image dimensions are too large.")

            _command("magick", [
                str(source), "-auto-orient", "-alpha", "remove", "-alpha", "off", "-colorspace", "Gray",
                "-deskew", "40%", "-bordercolor", "white", "-border", "20x20", "-strip", str(grayscale),
            ], timeout)
            _command("magick", [
                str(grayscale), "-contrast-stretch", "1%x1%", "-threshold", "65%", str(threshold)
            ], timeout)

            language = "+".join(self.config.ocr.languages)
            variants = [
                _command("tesseract", [str(grayscale), "stdout", "-l", language, "--oem", "1", "--psm", "4", "tsv"], timeout),
                _command("tesseract", [str(threshold), "stdout", "-l", language, "--oem", "1", "--psm", "6", "tsv"], timeout),
            ]
            parsed = [(lines := parse_tsv(tsv), parse_receipt_lines(lines)) for tsv in variants]
            lines, extraction = max(parsed, key=lambda item: item[1]["confidence"])
            if extraction["amountYen"] is None:
                translated = self.translator.translate(lines_to_text(lines))
                extraction = parse_receipt_lines(lines, translated)
            return {
                "text": lines_to_text(lines),
                "extraction": extraction,
                "mimeType": mime_types[image_format],
                "width": width,
                "height": height,
            }


class OcrWorkers:
    def __init__(self, config: Config, database: Database):
        self.database = database
        self.processor = OcrProcessor(config)
        self.wake = threading.Event()
        self.stop_event = threading.Event()
        self.threads = [
            threading.Thread(target=self._run, name=f"hakui-ocr-{index + 1}", daemon=True)
            for index in range(config.ocr.max_concurrent_jobs)
        ]

    def start(self) -> None:
        for thread in self.threads:
            thread.start()
        self.notify()

    def notify(self) -> None:
        self.wake.set()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake.set()
        for thread in self.threads:
            thread.join(timeout=5)

    @property
    def healthy(self) -> bool:
        return all(thread.is_alive() for thread in self.threads)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                job = self.database.claim_ocr_job()
                if job is None:
                    self.wake.wait(timeout=2)
                    self.wake.clear()
                    continue
                receipt_id, image = job
                try:
                    result = self.processor.process(image)
                    self.database.complete_receipt(receipt_id, result["text"], result["extraction"], result["mimeType"])
                except Exception as error:
                    logger.exception("OCR failed for receipt %s", receipt_id)
                    message = str(error).strip() or "Receipt OCR failed."
                    try:
                        self.database.fail_receipt(receipt_id, message)
                    except Exception:
                        logger.exception("Could not record OCR failure for receipt %s", receipt_id)
            except Exception:
                logger.exception("OCR worker encountered a database error")
                self.stop_event.wait(2)
