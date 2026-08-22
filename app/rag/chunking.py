"""Split document bodies into overlapping, retrieval-sized chunks.

We chunk on a word-count budget with overlap, but never split in the middle of a
paragraph when we can avoid it: paragraphs are packed greedily into a chunk until the
budget is reached. Overlap carries the tail words of one chunk into the next so context
that straddles a boundary is still retrievable.
"""
from __future__ import annotations


def _paragraphs(text: str) -> list[str]:
    return [p.strip() for p in text.split("\n\n") if p.strip()]


def chunk_text(text: str, chunk_size_words: int = 220, overlap_words: int = 40) -> list[str]:
    """Return a list of chunk strings.

    A paragraph longer than ``chunk_size_words`` is emitted on its own (we don't hard-cut
    inside it); everything else is packed to stay within the budget.
    """
    if chunk_size_words <= 0:
        raise ValueError("chunk_size_words must be positive")
    overlap_words = max(0, min(overlap_words, chunk_size_words - 1))

    chunks: list[str] = []
    current: list[str] = []  # words in the chunk being built

    def flush() -> None:
        if current:
            chunks.append(" ".join(current))

    for para in _paragraphs(text):
        words = para.split()
        if current and len(current) + len(words) > chunk_size_words:
            flush()
            # start the next chunk with an overlap tail from the previous one
            current = current[-overlap_words:] if overlap_words else []
        current.extend(words)
        # a single very long paragraph can overflow; emit and reset with overlap
        while len(current) > chunk_size_words:
            chunks.append(" ".join(current[:chunk_size_words]))
            current = current[chunk_size_words - overlap_words :] if overlap_words else current[chunk_size_words:]

    flush()
    return chunks
