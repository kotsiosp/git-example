"""Knowledge base: load official documents, chunk them, and retrieve relevant chunks."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .bm25 import BM25Index
from .chunking import chunk_text
from .documents import Document, load_documents


@dataclass
class RetrievedChunk:
    """A chunk returned from a query, with its provenance and relevance score."""

    text: str
    title: str
    url: str
    category: str
    score: float

    def as_source(self) -> dict:
        """Shape expected by ``app.prompts.format_context``."""
        return {"title": self.title, "url": self.url, "category": self.category, "text": self.text}


class KnowledgeBase:
    """In-memory RAG index over the Cyprus official-source documents.

    Build it once at startup; ``retrieve()`` is cheap thereafter.
    """

    def __init__(self, chunks: list[dict], index: BM25Index, documents: list[Document],
                 sources_dir=None, chunk_size_words: int = 220, chunk_overlap_words: int = 40):
        self._chunks = chunks
        self._index = index
        self.documents = documents
        self._sources_dir = sources_dir
        self._chunk_size_words = chunk_size_words
        self._chunk_overlap_words = chunk_overlap_words

    @staticmethod
    def _build(documents: list[Document], chunk_size_words: int, chunk_overlap_words: int):
        chunks: list[dict] = []
        for doc in documents:
            for piece in chunk_text(doc.body, chunk_size_words, chunk_overlap_words):
                chunks.append(
                    {"text": piece, "title": doc.title, "url": doc.url, "category": doc.category}
                )
        # Index each chunk over its title + text so a document's topic words always match.
        index = BM25Index([_index_text(c) for c in chunks])
        return chunks, index

    @classmethod
    def from_sources(
        cls,
        sources_dir: Path | list[Path],
        chunk_size_words: int = 220,
        chunk_overlap_words: int = 40,
    ) -> "KnowledgeBase":
        documents = load_documents(sources_dir)
        chunks, index = cls._build(documents, chunk_size_words, chunk_overlap_words)
        return cls(chunks, index, documents, sources_dir, chunk_size_words, chunk_overlap_words)

    def reload(self) -> int:
        """Re-read the source directories and rebuild the index in place.

        Returns the new number of documents. Used by the weekly ingestion scan so live
        services keep the same KnowledgeBase reference while its content updates.
        """
        if self._sources_dir is None:
            raise RuntimeError("KnowledgeBase was not built from source directories")
        documents = load_documents(self._sources_dir)
        chunks, index = self._build(documents, self._chunk_size_words, self._chunk_overlap_words)
        self.documents = documents
        self._chunks = chunks
        self._index = index
        return len(documents)

    def retrieve(self, query: str, top_k: int = 4) -> list[RetrievedChunk]:
        results = self._index.search(query, top_k=top_k)
        out: list[RetrievedChunk] = []
        for idx, score in results:
            c = self._chunks[idx]
            out.append(
                RetrievedChunk(
                    text=c["text"],
                    title=c["title"],
                    url=c["url"],
                    category=c["category"],
                    score=score,
                )
            )
        return out

    @property
    def num_chunks(self) -> int:
        return len(self._chunks)


def _index_text(chunk: dict) -> list[str]:
    from .bm25 import tokenize

    return tokenize(f"{chunk['title']} {chunk['text']}")
