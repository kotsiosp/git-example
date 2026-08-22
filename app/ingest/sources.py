"""Registry of official Cyprus sources to fetch on the weekly scan.

Each source maps to a document key (its filename in the ingested dir) and an official URL.
``selector`` optionally narrows extraction to a page's main content region.

⚠️ Verify these URLs and, ideally, point them at the specific procedure pages rather than
department landing pages before relying on the fetched text. Auto-ingested content should
be reviewed — it supplements, and does not replace, the curated `data/sources` documents.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class IngestSource:
    key: str            # becomes <key>.md in the ingested directory
    title: str
    url: str
    category: str
    selector: str | None = None  # optional CSS selector for the main content


INGEST_SOURCES: list[IngestSource] = [
    IngestSource(
        key="crmd-residency",
        title="Civil Registry and Migration Department",
        url="https://www.moi.gov.cy/moi/crmd/crmd.nsf/index_en/index_en",
        category="immigration",
    ),
    IngestSource(
        key="tax-department",
        title="Tax Department (Cyprus)",
        url="https://www.mof.gov.cy/mof/tax/taxdep.nsf/index_en/index_en",
        category="tax",
    ),
    IngestSource(
        key="gesy",
        title="GeSy — General Healthcare System",
        url="https://www.gesy.org.cy/sites/gesy?lang=en",
        category="health",
    ),
    IngestSource(
        key="registrar-companies",
        title="Department of Registrar of Companies",
        url="https://www.companies.gov.cy/en/",
        category="business",
    ),
    IngestSource(
        key="govcy",
        title="Gov.cy — central government portal",
        url="https://www.gov.cy/en/",
        category="general",
    ),
]
