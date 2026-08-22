"""Pydantic request/response models for the HTTP API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class AskRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=2000, examples=[
        "I just moved to Limassol — how do I get a Yellow Slip?"
    ])


class CitationOut(BaseModel):
    n: int
    title: str
    url: str
    category: str
    score: float


class AskResponse(BaseModel):
    answer: str
    citations: list[CitationOut]
    grounded: bool
    disclaimer: str


class HealthResponse(BaseModel):
    status: str
    app: str
    documents: int
    chunks: int
    model: str
    api_key_configured: bool
    whatsapp_configured: bool


class SimulateRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64, examples=["35799123456"])
    text: str = Field(..., min_length=1, max_length=2000)


class OutboundOut(BaseModel):
    kind: str
    text: str = ""
    filename: str = ""
    caption: str = ""
    pdf_path: str | None = None


class SimulateResponse(BaseModel):
    replies: list[OutboundOut]


class EraseRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)


class EraseResponse(BaseModel):
    user_id: str
    erased: bool


class PremiumRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)
    premium: bool = True


class UsageResponse(BaseModel):
    user_id: str
    used: int
    limit: int
    remaining: int
    premium: bool
