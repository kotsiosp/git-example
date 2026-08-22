"""Run the ingestion scan: fetch each source, extract text, and update the ingested docs."""
from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from ..config import Settings
from .fetcher import fetch_url, html_to_text
from .sources import INGEST_SOURCES, IngestSource


@dataclass
class SourceResult:
    key: str
    url: str
    status: str            # "ok" | "error" | "empty"
    changed: bool = False
    chars: int = 0
    error: str = ""


@dataclass
class IngestReport:
    started_at: str
    finished_at: str = ""
    results: list[SourceResult] = field(default_factory=list)

    @property
    def ok_count(self) -> int:
        return sum(1 for r in self.results if r.status == "ok")

    @property
    def changed_count(self) -> int:
        return sum(1 for r in self.results if r.changed)

    @property
    def error_count(self) -> int:
        return sum(1 for r in self.results if r.status != "ok")

    def to_dict(self) -> dict:
        return {
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "ok": self.ok_count,
            "changed": self.changed_count,
            "errors": self.error_count,
            "results": [asdict(r) for r in self.results],
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _render_doc(source: IngestSource, text: str) -> str:
    return (
        "---\n"
        f"title: {source.title}\n"
        f"source_url: {source.url}\n"
        f"category: {source.category}\n"
        f"last_reviewed: {date.today().isoformat()}\n"
        "source: auto-ingested\n"
        "---\n"
        f"> Auto-fetched from the official source on {date.today().isoformat()}. "
        "Verify against the source before relying on specifics.\n\n"
        f"{text}\n"
    )


def run_ingest(
    settings: Settings,
    sources: list[IngestSource] | None = None,
    fetch_html: Callable[[str], str] | None = None,
) -> IngestReport:
    """Fetch every source, write changed documents into the ingested dir, update manifest.

    A source that fails to fetch (or yields no text) is recorded as an error and its
    existing document, if any, is left untouched — a bad scan never destroys good content.
    """
    sources = sources if sources is not None else INGEST_SOURCES
    if fetch_html is None:
        def fetch_html(url: str) -> str:  # noqa: E306 - local default
            return fetch_url(url, settings.ingest_user_agent, settings.ingest_timeout_seconds)

    ingested_dir = Path(settings.ingested_dir)
    ingested_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = Path(settings.data_dir) / "ingest_manifest.json"
    manifest: dict = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            manifest = {}

    report = IngestReport(started_at=_now())
    for src in sources:
        try:
            html = fetch_html(src.url)
            text = html_to_text(html, src.selector)
            if not text.strip():
                report.results.append(SourceResult(src.key, src.url, "empty",
                                                    error="no extractable text"))
                continue
            digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            prev = (manifest.get(src.key) or {}).get("hash")
            changed = digest != prev
            (ingested_dir / f"{src.key}.md").write_text(_render_doc(src, text), encoding="utf-8")
            manifest[src.key] = {
                "hash": digest, "url": src.url, "chars": len(text), "last_ingested": _now(),
            }
            report.results.append(SourceResult(src.key, src.url, "ok", changed=changed,
                                               chars=len(text)))
        except Exception as e:  # network / parse errors: keep any existing doc
            report.results.append(SourceResult(src.key, src.url, "error", error=str(e)[:300]))

    report.finished_at = _now()
    manifest["last_run"] = report.to_dict()
    try:
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    except OSError:
        pass
    return report
