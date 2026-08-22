"""Ingestion pipeline, KB reload, and scheduler — offline (no network)."""
from __future__ import annotations

import json

from app.ingest.fetcher import html_to_text
from app.ingest.pipeline import run_ingest
from app.ingest.scheduler import IngestScheduler
from app.ingest.sources import IngestSource
from app.rag import KnowledgeBase

SAMPLE_HTML = """
<html><head><title>x</title><style>.a{}</style></head>
<body>
  <nav>Menu Home About</nav>
  <main>
    <h1>Yellow Slip</h1>
    <p>EU citizens must register within three months.</p>
    <ul><li>Bring your passport</li><li>Proof of address</li></ul>
    <script>evil()</script>
  </main>
  <footer>copyright</footer>
</body></html>
"""


def test_html_to_text_strips_noise_and_keeps_structure():
    text = html_to_text(SAMPLE_HTML)
    assert "Yellow Slip" in text
    assert "Bring your passport" in text
    assert "evil" not in text and "Menu Home" not in text and "copyright" not in text
    assert "- Bring your passport" in text  # list formatting


def _sources():
    return [
        IngestSource("test-a", "Source A", "https://example.gov.cy/a", "immigration"),
        IngestSource("test-b", "Source B", "https://example.gov.cy/b", "tax"),
    ]


def test_run_ingest_writes_docs_and_manifest(settings):
    def fake_fetch(url):
        return f"<main><h1>Doc</h1><p>Content for {url}</p></main>"

    report = run_ingest(settings, sources=_sources(), fetch_html=fake_fetch)
    assert report.ok_count == 2
    assert report.changed_count == 2  # first run: everything is new
    files = list(settings.ingested_dir.glob("*.md"))
    assert {f.stem for f in files} == {"test-a", "test-b"}
    body = (settings.ingested_dir / "test-a.md").read_text()
    assert "source: auto-ingested" in body and "Content for" in body

    manifest = json.loads((settings.data_dir / "ingest_manifest.json").read_text())
    assert "test-a" in manifest and manifest["last_run"]["ok"] == 2

    # Second identical run -> no changes detected.
    report2 = run_ingest(settings, sources=_sources(), fetch_html=fake_fetch)
    assert report2.changed_count == 0


def test_run_ingest_keeps_existing_doc_on_fetch_error(settings):
    ok_sources = _sources()
    run_ingest(settings, sources=ok_sources, fetch_html=lambda u: "<main><p>hello world</p></main>")
    original = (settings.ingested_dir / "test-a.md").read_text()

    def flaky(url):
        raise RuntimeError("network down")

    report = run_ingest(settings, sources=ok_sources, fetch_html=flaky)
    assert report.error_count == 2
    # Existing docs are untouched by a failed scan.
    assert (settings.ingested_dir / "test-a.md").read_text() == original


def test_kb_reload_picks_up_ingested_docs(settings):
    kb = KnowledgeBase.from_sources(settings.source_dirs)
    before = len(kb.documents)

    run_ingest(settings, sources=_sources(),
               fetch_html=lambda u: "<main><h1>Digital nomad visa</h1><p>Special rules apply.</p></main>")
    added = kb.reload()
    assert added == before + 2
    # The freshly ingested content is now retrievable.
    hits = kb.retrieve("digital nomad visa special rules", top_k=3)
    assert any("Source" in h.title for h in hits)


def test_scheduler_run_sync(settings):
    kb = KnowledgeBase.from_sources(settings.source_dirs)
    sched = IngestScheduler(settings, kb)
    import app.ingest.scheduler as sch
    # Patch the pipeline's fetch by monkeypatching run_ingest's default via a stub source set:
    # simplest: replace run_ingest reference used inside run_sync.
    orig = sch.run_ingest
    sch.run_ingest = lambda s: orig(s, sources=_sources(),
                                    fetch_html=lambda u: "<main><p>weekly content</p></main>")
    try:
        report = sched.run_sync()
    finally:
        sch.run_ingest = orig
    assert report.ok_count == 2
    assert sched.last_report is report
