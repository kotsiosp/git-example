"""Q&A orchestration: retrieve official context, then ask Claude to explain it."""
from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from ..config import Settings
from ..disclaimer import DISCLAIMER
from ..llm import ClaudeClient
from ..rag import KnowledgeBase, RetrievedChunk


@dataclass
class Citation:
    n: int
    title: str
    url: str
    category: str
    score: float


@dataclass
class Answer:
    text: str
    citations: list[Citation]
    disclaimer: str = DISCLAIMER
    grounded: bool = True  # False when no official source matched the question


class QAService:
    """Wires the knowledge base to the Claude client."""

    def __init__(self, kb: KnowledgeBase, client: ClaudeClient, settings: Settings):
        self.kb = kb
        self.client = client
        self.settings = settings

    def _retrieve(self, question: str) -> list[RetrievedChunk]:
        return self.kb.retrieve(question, top_k=self.settings.retrieval_top_k)

    @staticmethod
    def _citations(chunks: list[RetrievedChunk]) -> list[Citation]:
        # Deduplicate by (title, url) while preserving retrieval order and best score.
        seen: dict[tuple[str, str], Citation] = {}
        n = 0
        for c in chunks:
            key = (c.title, c.url)
            if key not in seen:
                n += 1
                seen[key] = Citation(n, c.title, c.url, c.category, c.score)
        return list(seen.values())

    def answer(self, question: str) -> Answer:
        """Blocking answer (used by the CLI and the JSON endpoint)."""
        chunks = self._retrieve(question)
        citations = self._citations(chunks)
        sources = [c.as_source() for c in chunks]
        text = self.client.answer(question, sources)
        return Answer(text=text, citations=citations, grounded=bool(chunks))

    def stream(self, question: str) -> tuple[Iterator[str], list[Citation], bool]:
        """Return (text token iterator, citations, grounded) for streaming responses.

        Retrieval happens up front so callers can send citations before/after the stream.
        """
        chunks = self._retrieve(question)
        citations = self._citations(chunks)
        sources = [c.as_source() for c in chunks]
        return self.client.stream_answer(question, sources), citations, bool(chunks)
