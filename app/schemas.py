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
