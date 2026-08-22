"""FastAPI application for the Cyprus Bureaucracy & Citizen Agent.

Features:
- Q&A (RAG) bot                — /ask, /ask/stream
- Document Checklist Generator — via the WhatsApp flow / simulator
- Form Filler                  — via the WhatsApp flow / simulator
- WhatsApp Cloud API channel   — /webhook/whatsapp (GET verify, POST receive)
- Freemium metering + GDPR     — /gdpr/*, /admin/premium
- Local testing without Meta   — /simulate

Run locally:
  uvicorn app.main:app --reload
"""
from __future__ import annotations

import json
import logging
from collections import deque
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse

from .config import get_settings
from .disclaimer import DISCLAIMER
from .llm import ClaudeClient
from .rag import KnowledgeBase
from .schemas import (
    AskRequest,
    AskResponse,
    CitationOut,
    EraseRequest,
    EraseResponse,
    HealthResponse,
    OutboundOut,
    PremiumRequest,
    SimulateRequest,
    SimulateResponse,
    UsageResponse,
)
from .services import (
    ChecklistService,
    ConversationService,
    FormFillerService,
    QAService,
    UsageService,
)
from .services.conversation import Reply, SessionStore
from .storage import Store
from .whatsapp import WhatsAppClient, parse_incoming, verify_signature, verify_webhook

logger = logging.getLogger("cyprus_agent")

_state: dict = {}


def build_qa_service() -> QAService:
    """Build just the Q&A service (used by the CLI and lightweight callers)."""
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


def build_app_state() -> dict:
    """Construct every long-lived object once. Safe to import without any secrets."""
    settings = get_settings()
    qa = build_qa_service()
    kb, client = qa.kb, qa.client
    store = Store(settings.db_path)
    usage = UsageService(store, settings.free_inquiries_per_month)
    checklist = ChecklistService(kb, client, settings)
    formfiller = FormFillerService(client, settings)
    conversation = ConversationService(
        qa=qa, checklist=checklist, formfiller=formfiller,
        usage=usage, store=store, settings=settings, sessions=SessionStore(),
    )

    whatsapp = None
    if settings.whatsapp_configured:
        whatsapp = WhatsAppClient(
            token=settings.whatsapp_token,
            phone_number_id=settings.whatsapp_phone_number_id,
            graph_version=settings.whatsapp_graph_version,
        )

    return {
        "settings": settings,
        "kb": kb,
        "qa": qa,
        "store": store,
        "usage": usage,
        "conversation": conversation,
        "whatsapp": whatsapp,
        "seen_message_ids": deque(maxlen=2000),
    }


@asynccontextmanager
async def lifespan(app: FastAPI):
    _state.update(build_app_state())
    yield
    ws = _state.get("whatsapp")
    if ws:
        ws.close()
    store = _state.get("store")
    if store:
        store.close()
    _state.clear()


app = FastAPI(
    title=get_settings().app_name,
    version="0.2.0",
    description="AI assistant for Cyprus public-administration procedures, on WhatsApp. "
    "Not affiliated with the Republic of Cyprus; not legal or tax advice.",
    lifespan=lifespan,
)


def _svc(name: str):
    obj = _state.get(name)
    if obj is None and name not in _state:  # pragma: no cover - accessed before startup
        raise HTTPException(status_code=503, detail="Service starting up")
    return obj


def _settings():
    """Settings the running app was built with (falls back to the global singleton)."""
    return _state.get("settings") or get_settings()


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    settings = _settings()
    qa: QAService = _svc("qa")
    return HealthResponse(
        status="ok",
        app=settings.app_name,
        documents=len(qa.kb.documents),
        chunks=qa.kb.num_chunks,
        model=settings.claude_model,
        api_key_configured=bool(settings.anthropic_api_key),
        whatsapp_configured=settings.whatsapp_configured,
    )


# --------------------------------------------------------------------------- #
# Q&A (direct HTTP API)
# --------------------------------------------------------------------------- #
@app.post("/ask", response_model=AskResponse)
def ask(req: AskRequest) -> AskResponse:
    qa: QAService = _svc("qa")
    result = qa.answer(req.question)
    return AskResponse(
        answer=result.text,
        citations=[CitationOut(**c.__dict__) for c in result.citations],
        grounded=result.grounded,
        disclaimer=result.disclaimer,
    )


@app.post("/ask/stream")
def ask_stream(req: AskRequest) -> StreamingResponse:
    qa: QAService = _svc("qa")
    tokens, citations, grounded = qa.stream(req.question)

    def generate():
        meta = {"type": "citations", "grounded": grounded,
                "citations": [c.__dict__ for c in citations]}
        yield json.dumps(meta, ensure_ascii=False) + "\n"
        for text in tokens:
            yield json.dumps({"type": "token", "text": text}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "done", "disclaimer": DISCLAIMER}, ensure_ascii=False) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# --------------------------------------------------------------------------- #
# WhatsApp webhook
# --------------------------------------------------------------------------- #
@app.get("/webhook/whatsapp")
def whatsapp_verify(request: Request):
    settings = _settings()
    params = request.query_params
    challenge = verify_webhook(
        params.get("hub.mode"),
        params.get("hub.verify_token"),
        params.get("hub.challenge"),
        settings.whatsapp_verify_token,
    )
    if challenge is None:
        raise HTTPException(status_code=403, detail="Verification failed")
    return PlainTextResponse(content=challenge)


@app.post("/webhook/whatsapp")
async def whatsapp_receive(
    request: Request,
    background: BackgroundTasks,
    x_hub_signature_256: str | None = Header(default=None),
):
    settings = _settings()
    raw = await request.body()
    if not verify_signature(settings.whatsapp_app_secret, raw, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        payload = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    messages = parse_incoming(payload)
    # Process (LLM calls + sending) off the request path so we return 200 immediately.
    background.add_task(_process_messages, messages)
    return {"status": "received", "count": len(messages)}


def _process_messages(messages: list) -> None:
    conversation: ConversationService = _state.get("conversation")
    whatsapp: WhatsAppClient | None = _state.get("whatsapp")
    seen: deque = _state.get("seen_message_ids")
    if conversation is None:
        return
    for msg in messages:
        if msg.message_id and seen is not None:
            if msg.message_id in seen:
                continue
            seen.append(msg.message_id)
        try:
            reply = conversation.handle(msg.from_, msg.text)
        except Exception:  # pragma: no cover - defensive
            logger.exception("Failed to handle message from %s", msg.from_)
            reply = Reply()
        _send_reply(whatsapp, msg.from_, reply)


def _send_reply(whatsapp: WhatsAppClient | None, to: str, reply: Reply) -> None:
    if whatsapp is None:
        logger.info("WhatsApp not configured; would send to %s: %s", to, reply.texts())
        return
    for out in reply.outbound:
        try:
            if out.kind == "text":
                whatsapp.send_text(to, out.text)
            elif out.kind == "document" and out.path:
                whatsapp.send_document(to, out.path, filename=out.filename, caption=out.caption)
        except Exception:  # pragma: no cover - network errors shouldn't crash the worker
            logger.exception("Failed to send %s to %s", out.kind, to)


# --------------------------------------------------------------------------- #
# Local testing without Meta: simulate an inbound message
# --------------------------------------------------------------------------- #
@app.post("/simulate", response_model=SimulateResponse)
def simulate(req: SimulateRequest) -> SimulateResponse:
    conversation: ConversationService = _svc("conversation")
    reply = conversation.handle(req.user_id, req.text)
    return SimulateResponse(
        replies=[
            OutboundOut(
                kind=o.kind, text=o.text, filename=o.filename, caption=o.caption,
                pdf_path=str(o.path) if o.path else None,
            )
            for o in reply.outbound
        ]
    )


# --------------------------------------------------------------------------- #
# GDPR + admin
# --------------------------------------------------------------------------- #
@app.post("/gdpr/erase", response_model=EraseResponse)
def gdpr_erase(req: EraseRequest) -> EraseResponse:
    store: Store = _svc("store")
    conversation: ConversationService = _svc("conversation")
    erased = store.erase(req.user_id)
    conversation.sessions.clear(req.user_id)
    return EraseResponse(user_id=req.user_id, erased=erased)


@app.get("/gdpr/usage/{user_id}", response_model=UsageResponse)
def gdpr_usage(user_id: str) -> UsageResponse:
    usage: UsageService = _svc("usage")
    q = usage.check(user_id)
    return UsageResponse(user_id=user_id, used=q.used, limit=q.limit,
                         remaining=q.remaining, premium=q.premium)


@app.post("/admin/premium", response_model=UsageResponse)
def admin_premium(req: PremiumRequest) -> UsageResponse:
    """Set a user's premium flag. DEMO ONLY — protect this behind auth in production."""
    store: Store = _svc("store")
    usage: UsageService = _svc("usage")
    store.set_premium(req.user_id, req.premium)
    q = usage.check(req.user_id)
    return UsageResponse(user_id=req.user_id, used=q.used, limit=q.limit,
                         remaining=q.remaining, premium=q.premium)
