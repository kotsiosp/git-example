"""Application configuration, driven by environment variables (and an optional .env file).

Nothing here requires a secret to *import* the app — the ANTHROPIC_API_KEY is only
needed when an actual answer is generated, so retrieval and tests run without it.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo root (…/app/config.py -> repo root is two parents up from this file's dir).
ROOT_DIR = Path(__file__).resolve().parent.parent
DEFAULT_SOURCES_DIR = ROOT_DIR / "data" / "sources"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Claude / LLM -------------------------------------------------------
    # Default to the most capable model. Switch to claude-sonnet-5 or
    # claude-haiku-4-5 via CLAUDE_MODEL for cheaper, higher-volume production use.
    anthropic_api_key: str | None = None
    claude_model: str = "claude-opus-5"
    # Effort trades depth vs. cost/latency: low | medium | high | xhigh | max.
    # "medium" is a sensible default for explain-the-law Q&A; raise for harder reasoning.
    claude_effort: str = "medium"
    claude_max_tokens: int = 2048
    # Server-side refusal fallback is honoured only for opus-5 / fable-5 (see llm/client.py).
    enable_refusal_fallback: bool = True

    # --- Retrieval ----------------------------------------------------------
    sources_dir: Path = DEFAULT_SOURCES_DIR
    retrieval_top_k: int = 4
    # Chunking (token-ish; we count words as a cheap proxy).
    chunk_size_words: int = 220
    chunk_overlap_words: int = 40

    # --- API ----------------------------------------------------------------
    app_name: str = "Cyprus Bureaucracy & Citizen Agent"
    free_inquiries_per_month: int = 3  # documented for the freemium model; not enforced here


@lru_cache
def get_settings() -> Settings:
    """Cached settings singleton."""
    return Settings()
