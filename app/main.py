"""FastAPI application for the Cyprus Bureaucracy & Citizen Agent (Q&A / RAG MVP).

Endpoints:
  GET  /health        — liveness + knowledge-base stats
  POST /ask           — ask a question, get a grounded JSON answer with citations
  POST /ask/stream    — same, but streams the answer text as it is generated

Run locally:
  uvicorn app.main:app --reload
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from .config import get_settings
from .disclaimer import DISCLAIMER
from .llm import ClaudeClient
from .rag import KnowledgeBase
from .schemas import AskRequest, AskResponse, CitationOut, HealthResponse
from .services import QAService

# Built once at startup and stored on app.state.
_state: dict = {}


def build_qa_service() -> QAService:
    settings = get_settings()
    kb = KnowledgeBase.from_sources(
        settings.sources_dir,
        chunk_size_words=settings.chunk_size_words,
        chunk_overlap_words=settings.chunk_overlap_words,
    )
    client = ClaudeClient(
        model=settings.claude_model,
        effort=settings.claude_effort,
        max_tokens=settings.claude_max_tokens,
        api_key=settings.anthropic_api_key,
        enable_refusal_fallback=settings.enable_refusal_fallback,
    )
    return QAService(kb, client, settings)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Build the knowledge base (and Claude client) once, at startup.
    _state["qa"] = build_qa_service()
    yield
    _state.clear()


app = FastAPI(
    title=get_settings().app_name,
    version="0.1.0",
    description="AI assistant for Cyprus public-administration procedures. Not affiliated "
    "with the Republic of Cyprus; not legal or tax advice.",
    lifespan=lifespan,
)


def _qa() -> QAService:
    qa = _state.get("qa")
    if qa is None:  # pragma: no cover - only if accessed before startup
        raise HTTPException(status_code=503, detail="Service starting up")
    return qa


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = get_settings()
    qa = _qa()
    return HealthResponse(
        status="ok",
        app=settings.app_name,
        documents=len(qa.kb.documents),
        chunks=qa.kb.num_chunks,
        model=settings.claude_model,
        api_key_configured=bool(settings.anthropic_api_key),
    )


@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest) -> AskResponse:
    result = _qa().answer(req.question)
    return AskResponse(
        answer=result.text,
        citations=[CitationOut(**c.__dict__) for c in result.citations],
        grounded=result.grounded,
        disclaimer=result.disclaimer,
    )


@app.post("/ask/stream")
def ask_stream(req: AskRequest) -> StreamingResponse:
    """Stream the answer as newline-delimited JSON (NDJSON).

    First line: ``{"type":"citations", ...}``. Then ``{"type":"token","text":...}`` lines.
    Final line: ``{"type":"done","disclaimer":...}``.
    """
    tokens, citations, grounded = _qa().stream(req.question)

    def generate():
        meta = {
            "type": "citations",
            "grounded": grounded,
            "citations": [c.__dict__ for c in citations],
        }
        yield json.dumps(meta, ensure_ascii=False) + "\n"
        for text in tokens:
            yield json.dumps({"type": "token", "text": text}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "done", "disclaimer": DISCLAIMER}, ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")
