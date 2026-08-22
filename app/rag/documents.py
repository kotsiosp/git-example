"""Load official-source documents from disk.

Each source is a Markdown file under ``data/sources`` with a small YAML-ish frontmatter
block delimited by ``---`` lines, e.g.::

    ---
    title: How to Get a Yellow Slip (MEU1)
    source_url: https://www.moi.gov.cy/crmd
    category: immigration
    last_reviewed: 2026-08-22
    ---
    <markdown body...>

Frontmatter is parsed with a tiny key: value reader so we avoid a PyYAML dependency.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Document:
    """A single official source document."""

    title: str
    url: str
    category: str
    body: str
    path: Path
    meta: dict[str, str] = field(default_factory=dict)


def _parse_frontmatter(raw: str) -> tuple[dict[str, str], str]:
    """Split ``raw`` into (frontmatter dict, body). Missing frontmatter -> ({}, raw)."""
    if not raw.startswith("---"):
        return {}, raw

    lines = raw.splitlines()
    # lines[0] is the opening '---'; find the closing one.
    try:
        end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    except StopIteration:
        return {}, raw  # unterminated frontmatter; treat whole file as body

    meta: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip() or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip()

    body = "\n".join(lines[end + 1 :]).strip()
    return meta, body


def load_document(path: Path) -> Document:
    raw = path.read_text(encoding="utf-8")
    meta, body = _parse_frontmatter(raw)
    return Document(
        title=meta.get("title", path.stem.replace("-", " ").title()),
        url=meta.get("source_url", meta.get("url", "")),
        category=meta.get("category", "general"),
        body=body,
        path=path,
        meta=meta,
    )


def load_documents(sources_dir: Path) -> list[Document]:
    """Load every ``*.md`` file under ``sources_dir`` (sorted for determinism)."""
    sources_dir = Path(sources_dir)
    if not sources_dir.exists():
        raise FileNotFoundError(f"Sources directory does not exist: {sources_dir}")
    docs = [load_document(p) for p in sorted(sources_dir.glob("*.md"))]
    return docs
