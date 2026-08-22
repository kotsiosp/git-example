"""Application configuration, driven by environment variables (and an optional .env file).

Nothing here requires a secret to *import* the app — the ANTHROPIC_API_KEY and WhatsApp
credentials are only needed for live calls, so retrieval, PDF generation, the
conversation router, and the full test suite run without any of them.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root (…/app/config.py -> repo root is two parents up from this file's dir).
ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES_DIR = ROOT_DIR / "data" / "sources"
DEFAULT_DATA_DIR = ROOT_DIR / "var"  # runtime state (sqlite db, generated PDFs)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Claude / LLM -------------------------------------------------------
    # Default to the most capable model. Switch to claude-sonnet-5 or
    # claude-haiku-4-5 via CLAUDE_MODEL for cheaper, higher-volume production use.
    anthropic_api_key: str | None = None
    claude_model: str = "claude-opus-5"
    # Effort trades depth vs. cost/latency: low | medium | high | xhigh | max.
    claude_effort: str = "medium"
    claude_max_tokens: int = 2048
    # Server-side refusal fallback is honoured only for opus-5 / fable-5 (see llm/client.py).
    enable_refusal_fallback: bool = True

    # --- Retrieval ----------------------------------------------------------
    sources_dir: Path = DEFAULT_SOURCES_DIR
    retrieval_top_k: int = 4
    chunk_size_words: int = 220
    chunk_overlap_words: int = 40

    # --- Storage / runtime state -------------------------------------------
    data_dir: Path = DEFAULT_DATA_DIR
    database_path: Path | None = None  # defaults to <data_dir>/app.db
    output_dir: Path | None = None     # generated PDFs; defaults to <data_dir>/output

    # --- Freemium (Phase 4) -------------------------------------------------
    free_inquiries_per_month: int = 3

    # --- Knowledge-base ingestion (weekly official-source re-scan) ----------
    # Opt-in: enabling it makes the app fetch government sites on a schedule.
    ingest_enabled: bool = False
    ingest_interval_hours: int = 168        # weekly
    ingest_on_startup: bool = False         # also run once shortly after boot
    ingest_timeout_seconds: float = 30.0
    ingest_user_agent: str = (
        "CyprusCitizenAgent/1.0 (+https://example.com; knowledge-base refresh)"
    )

    # --- WhatsApp Cloud API (Phase 2) --------------------------------------
    # From Meta / Facebook Developer app -> WhatsApp product.
    whatsapp_token: str | None = None            # permanent/system-user access token
    whatsapp_phone_number_id: str | None = None  # the sending phone number id
    whatsapp_verify_token: str | None = None     # your chosen webhook verify token
    whatsapp_app_secret: str | None = None       # app secret, to verify webhook signatures
    whatsapp_graph_version: str = "v21.0"
    # Public base URL of THIS service (used only if you send media by link instead of upload).
    public_base_url: str | None = None

    # --- App ----------------------------------------------------------------
    app_name: str = "Cyprus Bureaucracy & Citizen Agent"
    # Token required for /admin/* endpoints (sent as the X-Admin-Token header).
    # If unset, the admin API is disabled (fail-closed) rather than left open.
    admin_token: str | None = None

    # --- Derived paths ------------------------------------------------------
    @property
    def db_path(self) -> Path:
        return self.database_path or (self.data_dir / "app.db")

    @property
    def pdf_output_dir(self) -> Path:
        return self.output_dir or (self.data_dir / "output")

    @property
    def ingested_dir(self) -> Path:
        """Where the weekly scan writes auto-fetched official documents (runtime state)."""
        return self.data_dir / "ingested"

    @property
    def source_dirs(self) -> list[Path]:
        """All directories the knowledge base indexes: curated + auto-ingested."""
        return [self.sources_dir, self.ingested_dir]

    @property
    def whatsapp_configured(self) -> bool:
        return bool(self.whatsapp_token and self.whatsapp_phone_number_id)


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
