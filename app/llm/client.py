"""Thin wrapper around the Anthropic SDK for the agent's three LLM tasks.

Tasks:
- Q&A: strict, grounded answer (streaming).
- Checklist generation: JSON {intro, items} grounded in retrieved docs + user answers.
- Field extraction: JSON {field_key: value} from a user's free-text message.

Design notes:
- Each task's stable system prompt is cached (prompt caching) to cut cost per request.
- The Q&A answer streams so long explanations don't hit HTTP timeouts.
- Server-side refusal fallback is enabled by default for opus-5 / fable-5 (per Anthropic
  guidance); it is skipped automatically for other models, which don't support it.
"""
from __future__ import annotations

from collections.abc import Iterator

import anthropic

from ..prompts import (
    CHECKLIST_SYSTEM_PROMPT,
    EXTRACTION_SYSTEM_PROMPT,
    SYSTEM_PROMPT,
    build_checklist_message,
    build_extraction_message,
    build_user_message,
)
from .parsing import extract_json

# Models that support the server-side refusal fallback beta.
_FALLBACK_MODELS = {"claude-opus-5", "claude-fable-5", "claude-mythos-5"}
_FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeClient:
    def __init__(
        self,
        model: str = "claude-opus-5",
        effort: str = "medium",
        max_tokens: int = 2048,
        api_key: str | None = None,
        enable_refusal_fallback: bool = True,
    ):
        # Anthropic() resolves the key from ANTHROPIC_API_KEY / auth profile if not passed.
        self._client = anthropic.Anthropic(api_key=api_key) if api_key else anthropic.Anthropic()
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.use_fallback = enable_refusal_fallback and model in _FALLBACK_MODELS

    # -- request assembly ----------------------------------------------------
    def _base_kwargs(self, system_text: str, user_content: str, max_tokens: int | None = None) -> dict:
        return {
            "model": self.model,
            "max_tokens": max_tokens or self.max_tokens,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort},
            "system": [
                {"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [{"role": "user", "content": user_content}],
        }

    def _complete(self, system_text: str, user_content: str, max_tokens: int | None = None) -> str:
        """Non-streaming completion returning concatenated text blocks."""
        kwargs = self._base_kwargs(system_text, user_content, max_tokens)
        if self.use_fallback:
            msg = self._client.beta.messages.create(
                betas=[_FALLBACK_BETA], fallbacks="default", **kwargs
            )
        else:
            msg = self._client.messages.create(**kwargs)
        return "".join(b.text for b in msg.content if b.type == "text")

    # -- Q&A (streaming) -----------------------------------------------------
    def stream_answer(self, question: str, sources: list[dict]) -> Iterator[str]:
        kwargs = self._base_kwargs(SYSTEM_PROMPT, build_user_message(question, sources))
        if self.use_fallback:
            with self._client.beta.messages.stream(
                betas=[_FALLBACK_BETA], fallbacks="default", **kwargs
            ) as stream:
                yield from stream.text_stream
        else:
            with self._client.messages.stream(**kwargs) as stream:
                yield from stream.text_stream

    def answer(self, question: str, sources: list[dict]) -> str:
        return "".join(self.stream_answer(question, sources))

    # -- Checklist generation ------------------------------------------------
    def generate_checklist(
        self, topic_title: str, answers: dict, sources: list[dict]
    ) -> tuple[str, list[str]]:
        """Return (intro, items). Falls back to an empty list on unparseable output."""
        user = build_checklist_message(topic_title, answers, sources)
        text = self._complete(CHECKLIST_SYSTEM_PROMPT, user)
        try:
            data = extract_json(text)
        except ValueError:
            return "", []
        intro = str(data.get("intro", "")) if isinstance(data, dict) else ""
        raw_items = data.get("items", []) if isinstance(data, dict) else []
        items = [str(i).strip() for i in raw_items if str(i).strip()]
        return intro, items

    # -- Field extraction ----------------------------------------------------
    def extract_fields(
        self, form_title: str, field_defs: list[dict], user_text: str
    ) -> dict[str, str]:
        """Extract {field_key: value} from free text. Keys are constrained to field_defs."""
        allowed = {f["key"] for f in field_defs}
        user = build_extraction_message(form_title, field_defs, user_text)
        text = self._complete(EXTRACTION_SYSTEM_PROMPT, user)
        try:
            data = extract_json(text)
        except ValueError:
            return {}
        if not isinstance(data, dict):
            return {}
        out: dict[str, str] = {}
        for key, value in data.items():
            if key in allowed and value not in (None, "", []):
                out[key] = str(value).strip()
        return out
