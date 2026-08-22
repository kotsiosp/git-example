"""Document Checklist Generator (Phase 3.2).

Given a topic and the user's answers to a few personalising questions, retrieve the
relevant official documents, ask Claude to produce a tailored checklist grounded in them,
and render it to a PDF the user can print and take to the office.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from ..disclaimer import DISCLAIMER
from ..forms import ChecklistTopic, get_topic
from ..llm import ClaudeClient
from ..pdf import render_checklist_pdf
from ..rag import KnowledgeBase


@dataclass
class ChecklistResult:
    topic_key: str
    topic_title: str
    intro: str
    items: list[str]
    citations: list[tuple[str, str]]  # (title, url)
    pdf_path: Path | None = None
    generated: bool = True  # False if the model returned nothing usable
    extras: dict = field(default_factory=dict)


class ChecklistService:
    def __init__(self, kb: KnowledgeBase, client: ClaudeClient, settings: Settings):
        self.kb = kb
        self.client = client
        self.settings = settings

    @staticmethod
    def topic(topic_key: str) -> ChecklistTopic | None:
        return get_topic(topic_key)

    def _query(self, topic: ChecklistTopic, answers: dict) -> str:
        return topic.title + " " + " ".join(str(v) for v in answers.values())

    def generate(self, topic_key: str, answers: dict, write_pdf: bool = True) -> ChecklistResult:
        topic = get_topic(topic_key)
        if topic is None:
            raise KeyError(f"Unknown checklist topic: {topic_key}")

        chunks = self.kb.retrieve(self._query(topic, answers), top_k=self.settings.retrieval_top_k)
        sources = [c.as_source() for c in chunks]
        # De-duplicated citations preserving order.
        seen: dict[tuple[str, str], None] = {}
        for c in chunks:
            seen.setdefault((c.title, c.url), None)
        citations = list(seen.keys())

        intro, items = self.client.generate_checklist(topic.title, answers, sources)

        result = ChecklistResult(
            topic_key=topic.key,
            topic_title=topic.title,
            intro=intro,
            items=items,
            citations=citations,
            generated=bool(items),
        )

        if write_pdf and items:
            subtitle = "Personalised checklist — " + ", ".join(
                f"{k}: {v}" for k, v in answers.items()
            )
            out = Path(self.settings.pdf_output_dir) / f"checklist_{topic.key}_{uuid.uuid4().hex[:8]}.pdf"
            render_checklist_pdf(
                out,
                title=topic.title,
                subtitle=subtitle,
                intro=intro,
                items=items,
                sources=citations,
                disclaimer=DISCLAIMER,
            )
            result.pdf_path = out

        return result
