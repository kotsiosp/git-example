"""Shared test fixtures. Everything runs offline — no API key, no network."""
from __future__ import annotations

import pytest

from app.config import DEFAULT_SOURCES_DIR, Settings
from app.rag import KnowledgeBase
from app.services import (
    ChecklistService,
    ConversationService,
    FormFillerService,
    QAService,
    UsageService,
)
from app.services.conversation import SessionStore
from app.storage import Store


class StubClient:
    """Deterministic stand-in for ClaudeClient (no network)."""

    # --- Q&A ---
    def stream_answer(self, question, sources):
        yield f"Here is guidance for: {question}."
        if sources:
            yield " [Source 1]"

    def answer(self, question, sources):
        return "".join(self.stream_answer(question, sources))

    # --- Checklist ---
    def generate_checklist(self, topic_title, answers, sources):
        intro = f"Personalised steps for {topic_title}."
        items = ["Bring your passport and a copy", "Complete the application form",
                 "Pay the applicable fee (verify current amount)"]
        return intro, items

    # --- Form field extraction (parses "key=value; key=value") ---
    def extract_fields(self, form_title, field_defs, user_text):
        allowed = {f["key"] for f in field_defs}
        out = {}
        for part in user_text.replace("\n", ";").split(";"):
            if "=" in part:
                k, _, v = part.partition("=")
                k, v = k.strip(), v.strip()
                if k in allowed and v:
                    out[k] = v
        return out


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        anthropic_api_key=None,
        sources_dir=DEFAULT_SOURCES_DIR,
        data_dir=tmp_path,
        free_inquiries_per_month=3,
    )


@pytest.fixture
def kb(settings) -> KnowledgeBase:
    return KnowledgeBase.from_sources(settings.sources_dir)


@pytest.fixture
def stub_client() -> StubClient:
    return StubClient()


@pytest.fixture
def store(tmp_path) -> Store:
    return Store(tmp_path / "test.db")


@pytest.fixture
def conversation(kb, stub_client, settings, store) -> ConversationService:
    usage = UsageService(store, settings.free_inquiries_per_month)
    qa = QAService(kb, stub_client, settings)
    checklist = ChecklistService(kb, stub_client, settings)
    formfiller = FormFillerService(stub_client, settings)
    return ConversationService(
        qa=qa, checklist=checklist, formfiller=formfiller,
        usage=usage, store=store, settings=settings, sessions=SessionStore(),
    )
