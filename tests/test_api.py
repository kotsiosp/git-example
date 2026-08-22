"""End-to-end API tests with stubbed Claude client and WhatsApp (no key / network)."""
from __future__ import annotations

import hashlib
import hmac
import json
from collections import deque

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.services import (
    ChecklistService,
    ConversationService,
    FormFillerService,
    QAService,
    UsageService,
)
from app.services.conversation import SessionStore


@pytest.fixture
def client(monkeypatch, kb, stub_client, settings, store):
    settings = settings.model_copy(update={
        "whatsapp_verify_token": "verify-me",
        "whatsapp_app_secret": "s3cret",
    })
    usage = UsageService(store, settings.free_inquiries_per_month)
    qa = QAService(kb, stub_client, settings)
    checklist = ChecklistService(kb, stub_client, settings)
    formfiller = FormFillerService(stub_client, settings)
    conversation = ConversationService(
        qa=qa, checklist=checklist, formfiller=formfiller,
        usage=usage, store=store, settings=settings, sessions=SessionStore(),
    )
    state = {
        "settings": settings, "kb": kb, "qa": qa, "store": store, "usage": usage,
        "conversation": conversation, "whatsapp": None,
        "seen_message_ids": deque(maxlen=2000),
    }
    monkeypatch.setattr(main, "build_app_state", lambda: state)
    with TestClient(main.app) as c:
        yield c


def test_health(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["documents"] >= 5
    assert body["whatsapp_configured"] is False


def test_ask_grounded(client):
    body = client.post("/ask", json={"question": "How do I get a Yellow Slip?"}).json()
    assert body["grounded"] is True
    assert any("Yellow Slip" in c["title"] for c in body["citations"])


def test_ask_stream(client):
    r = client.post("/ask/stream", json={"question": "How do I register for VAT?"})
    lines = [json.loads(x) for x in r.text.strip().splitlines()]
    assert lines[0]["type"] == "citations"
    assert lines[-1]["type"] == "done"


def test_simulate_menu(client):
    body = client.post("/simulate", json={"user_id": "u1", "text": "menu"}).json()
    assert any("checklist" in r["text"].lower() for r in body["replies"])


def test_simulate_checklist_returns_pdf(client):
    for msg in ["checklist", "1", "1", "1", "1"]:
        body = client.post("/simulate", json={"user_id": "u2", "text": msg}).json()
    kinds = [r["kind"] for r in body["replies"]]
    assert "document" in kinds
    doc = next(r for r in body["replies"] if r["kind"] == "document")
    assert doc["pdf_path"]


def test_gdpr_erase_and_usage(client):
    client.post("/simulate", json={"user_id": "g1", "text": "What is GeSy?"})
    usage = client.get("/gdpr/usage/g1").json()
    assert usage["used"] == 1
    erased = client.post("/gdpr/erase", json={"user_id": "g1"}).json()
    assert erased["erased"] is True
    assert client.get("/gdpr/usage/g1").json()["used"] == 0


def test_admin_premium(client):
    body = client.post("/admin/premium", json={"user_id": "vip", "premium": True}).json()
    assert body["premium"] is True
    assert body["remaining"] == -1


def test_webhook_verify(client):
    r = client.get("/webhook/whatsapp", params={
        "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345",
    })
    assert r.status_code == 200 and r.text == "12345"

    bad = client.get("/webhook/whatsapp", params={
        "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "x",
    })
    assert bad.status_code == 403


def test_webhook_receive_signature(client):
    payload = {"entry": [{"changes": [{"value": {"messages": [{
        "from": "35799000000", "id": "wamid.x", "type": "text",
        "text": {"body": "menu"},
    }]}}]}]}
    raw = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(b"s3cret", raw, hashlib.sha256).hexdigest()

    ok = client.post("/webhook/whatsapp", content=raw,
                     headers={"X-Hub-Signature-256": sig, "content-type": "application/json"})
    assert ok.status_code == 200
    assert ok.json()["count"] == 1

    bad = client.post("/webhook/whatsapp", content=raw,
                      headers={"X-Hub-Signature-256": "sha256=bad", "content-type": "application/json"})
    assert bad.status_code == 401
