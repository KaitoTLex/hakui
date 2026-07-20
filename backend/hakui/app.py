from __future__ import annotations

import csv
import io
import json
import logging
import sqlite3
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import load_config
from .database import ConflictError, Database
from .ocr import OcrWorkers


logger = logging.getLogger(__name__)
config = load_config()


class TransactionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    legId: UUID | None
    categoryId: UUID | None
    merchant: str = Field(min_length=1, max_length=160)
    amountYen: int = Field(ge=0, le=100_000_000)
    transactionDate: date | None
    paymentMethod: Literal["cash", "card", "unknown"]
    purchaseTiming: Literal["during_trip", "pre_trip"]
    notes: str = Field(max_length=2000)
    source: Literal["manual", "scan", "csv"]
    status: Literal["confirmed", "needs_review", "pending_ocr"]
    revision: int = Field(ge=1)

    @field_validator("merchant")
    @classmethod
    def clean_merchant(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Merchant is required.")
        return value


class LegSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: UUID
    budgetYen: int = Field(ge=0, le=1_000_000_000)
    startsOn: date | None
    endsOn: date | None


class SettingsInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operationId: UUID
    expectedRevision: int = Field(ge=0)
    overallBudgetYen: int = Field(ge=0, le=1_000_000_000)
    currentLegId: UUID | None
    legs: list[LegSettings]


@asynccontextmanager
async def lifespan(application: FastAPI):
    database = Database(config)
    workers = OcrWorkers(config, database)
    application.state.database = database
    application.state.workers = workers
    workers.start()
    try:
        yield
    finally:
        workers.stop()
        database.close()


app = FastAPI(title="Hakui API", docs_url=None, redoc_url=None, lifespan=lifespan)


def db() -> Database:
    return app.state.database


def model_data(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(mode="json")


@app.exception_handler(sqlite3.Error)
async def sqlite_error_handler(_request, error: sqlite3.Error):
    logger.exception("SQLite operation failed")
    return JSONResponse(status_code=503, content={"message": "The data service is temporarily unavailable."}, headers={"Retry-After": "5"})


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, error: RequestValidationError):
    message = error.errors()[0].get("msg", "Request data is invalid.") if error.errors() else "Request data is invalid."
    return JSONResponse(status_code=400, content={"message": message})


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, error: HTTPException):
    return JSONResponse(status_code=error.status_code, content={"message": str(error.detail)}, headers=error.headers)


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        result = db().health()
        if not app.state.workers.healthy:
            raise RuntimeError("An OCR worker stopped unexpectedly")
        result["ocrWorkers"] = "ok"
        return result
    except Exception as error:
        logger.exception("Health check failed")
        raise HTTPException(status_code=503, detail="Database is unavailable") from error


@app.get("/snapshot")
def snapshot() -> dict[str, Any]:
    return db().snapshot()


@app.put("/transactions/{transaction_id}")
def put_transaction(transaction_id: UUID, transaction: TransactionInput) -> dict[str, Any]:
    data = model_data(transaction)
    if str(transaction_id) != data["id"]:
        raise HTTPException(status_code=400, detail="Transaction ID does not match URL.")
    try:
        return db().upsert_transaction(data)
    except ConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.delete("/transactions/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: UUID, x_hakui_revision: Annotated[int, Header(ge=0)]) -> Response:
    try:
        db().delete_transaction(str(transaction_id), x_hakui_revision)
    except ConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return Response(status_code=204)


@app.put("/settings")
def put_settings(settings: SettingsInput) -> dict[str, Any]:
    try:
        return db().update_settings(model_data(settings))
    except ConflictError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


def spreadsheet_safe(value: str) -> str:
    return f"'{value}" if value.startswith(("=", "+", "-", "@")) else value


@app.get("/export")
def export_transactions() -> Response:
    current = db().snapshot()
    legs = {leg["id"]: leg["name"] for leg in current["legs"]}
    categories = {category["id"]: category["name"] for category in current["categories"]}
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=("Expense", "Cost", "Date", "Leg", "Category", "Payment", "Timing", "Notes", "Status"))
    writer.writeheader()
    for transaction in current["transactions"]:
        writer.writerow({
            "Expense": spreadsheet_safe(transaction["merchant"]), "Cost": transaction["amountYen"],
            "Date": transaction["transactionDate"] or "", "Leg": legs.get(transaction["legId"], ""),
            "Category": categories.get(transaction["categoryId"], ""), "Payment": transaction["paymentMethod"],
            "Timing": transaction["purchaseTiming"], "Notes": spreadsheet_safe(transaction["notes"]), "Status": transaction["status"],
        })
    return Response(
        output.getvalue(), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="hakui-transactions.csv"'},
    )


@app.get("/receipts/{receipt_id}")
def get_receipt(receipt_id: UUID) -> dict[str, Any]:
    receipt = db().get_receipt(str(receipt_id))
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found.")
    return receipt


@app.get("/receipts/{receipt_id}/image")
def get_receipt_image(receipt_id: UUID) -> Response:
    receipt = db().get_receipt(str(receipt_id), include_image=True)
    if not receipt:
        raise HTTPException(status_code=404, detail="Receipt not found.")
    return Response(receipt["image"], media_type=receipt["mimeType"], headers={"Cache-Control": "private, max-age=86400"})


@app.put("/receipts/{receipt_id}", status_code=202)
async def put_receipt(
    receipt_id: UUID,
    transaction: Annotated[str, Form()],
    receipt: Annotated[UploadFile, File()],
) -> dict[str, Any]:
    try:
        parsed = TransactionInput.model_validate(json.loads(transaction))
    except (json.JSONDecodeError, ValueError) as error:
        raise HTTPException(status_code=400, detail="Transaction data is invalid.") from error
    data = model_data(parsed)
    existing = db().get_receipt(str(receipt_id))
    if existing and existing["transactionId"] != data["id"]:
        raise HTTPException(status_code=409, detail="Receipt belongs to a different transaction.")
    server_revision = db().transaction_revision(data["id"])
    if existing and existing["ocrState"] == "complete":
        if server_revision is not None and data["revision"] > server_revision:
            db().upsert_transaction(data)
        return {"receiptId": existing["id"], "state": "complete"}
    data["status"] = "pending_ocr"
    data["source"] = "scan"
    if existing and server_revision is not None and data["revision"] > server_revision:
        db().upsert_transaction(data)
    if existing and existing["ocrState"] in ("queued", "processing"):
        return {"receiptId": existing["id"], "state": existing["ocrState"]}

    image = await receipt.read(config.receipts.max_upload_bytes + 1)
    if len(image) > config.receipts.max_upload_bytes:
        raise HTTPException(status_code=413, detail="Receipt image is too large.")
    if not image:
        raise HTTPException(status_code=400, detail="Receipt image is empty.")

    if existing:
        if server_revision is not None and data["revision"] < server_revision:
            raise HTTPException(status_code=409, detail="A newer version of this transaction already exists.")
        if server_revision is not None and data["revision"] == server_revision and existing["ocrState"] == "failed":
            data["revision"] += 1
            db().upsert_transaction(data)
        db().requeue_receipt(str(receipt_id), image, receipt.content_type or "application/octet-stream", data["revision"])
    else:
        db().create_receipt_upload(str(receipt_id), data, image, receipt.content_type or "application/octet-stream")
    app.state.workers.notify()
    return {"receiptId": str(receipt_id), "state": "queued"}
