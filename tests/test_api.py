"""End-to-end API tests with a stubbed Claude client (no API key / network needed)."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.config import get_settings
from app.rag import KnowledgeBase
from app.services import QAService


class StubClient:
    """Stand-in for ClaudeClient that echoes the retrieved sources deterministically."""

    def stream_answer(self, question, sources):
        n = len(sources)
        yield f"Based on {n} official source(s), here is a summary."
        if n:
            yield " [Source 1]"

    def answer(self, question, sources):
        return "".join(self.stream_answer(question, sources))


@pytest.fixture
def client(monkeypatch):
    settings = get_settings()
    kb = KnowledgeBase.from_sources(settings.sources_dir)
    service = QAService(kb, StubClient(), settings)
    monkeypatch.setattr(main, "build_qa_service", lambda: service)
    with TestClient(main.app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["documents"] >= 5
    assert body["chunks"] >= body["documents"]


def test_ask_grounded(client):
    r = client.post("/ask", json={"question": "How do I get a Yellow Slip?"})
    assert r.status_code == 200
    body = r.json()
    assert body["grounded"] is True
    assert body["citations"]
    assert any("Yellow Slip" in c["title"] for c in body["citations"])
    assert body["disclaimer"]


def test_ask_offtopic_not_grounded(client):
    r = client.post("/ask", json={"question": "Who won the football match last night?"})
    assert r.status_code == 200
    body = r.json()
    assert body["grounded"] is False
    assert body["citations"] == []


def test_ask_validation_rejects_short_question(client):
    r = client.post("/ask", json={"question": "hi"})
    assert r.status_code == 422


def test_ask_stream_ndjson(client):
    r = client.post("/ask/stream", json={"question": "How do I register for VAT?"})
    assert r.status_code == 200
    lines = [json.loads(line) for line in r.text.strip().splitlines()]
    assert lines[0]["type"] == "citations"
    assert lines[0]["grounded"] is True
    assert any(line["type"] == "token" for line in lines)
    assert lines[-1]["type"] == "done"
    assert lines[-1]["disclaimer"]
