"""Knowledge-base ingestion: fetch official Cyprus sources and index them.

The weekly scan fetches each registered source, extracts readable text, and writes it as
a document into the *ingested* directory (kept separate from the curated `data/sources`
so a scan never overwrites hand-verified content). The knowledge base indexes both.
"""

from .pipeline import IngestReport, SourceResult, run_ingest
from .sources import INGEST_SOURCES, IngestSource

__all__ = ["INGEST_SOURCES", "IngestReport", "IngestSource", "SourceResult", "run_ingest"]
