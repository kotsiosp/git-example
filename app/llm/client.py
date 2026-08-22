"""Thin wrapper around the Anthropic SDK for the Q&A use case.

Design notes:
- The strict Cyprus system prompt is stable, so we cache it (prompt caching) to cut cost
  on every request after the first.
- Streaming is used for the answer so long explanations don't hit HTTP timeouts and can
  be forwarded to the client token-by-token.
- Server-side refusal fallback is enabled by default for opus-5 / fable-5 (per Anthropic
  guidance); it is skipped automatically for other models, which don't support it.
"""
from __future__ import annotations

from collections.abc import Iterator

import anthropic

from ..prompts import SYSTEM_PROMPT, build_user_message

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
    def _request_kwargs(self, question: str, sources: list[dict]) -> dict:
        return {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": self.effort},
            # Stable system prompt cached across requests.
            "system": [
                {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
            ],
            "messages": [{"role": "user", "content": build_user_message(question, sources)}],
        }

    # -- streaming -----------------------------------------------------------
    def stream_answer(self, question: str, sources: list[dict]) -> Iterator[str]:
        """Yield answer text incrementally."""
        kwargs = self._request_kwargs(question, sources)
        if self.use_fallback:
            with self._client.beta.messages.stream(
                betas=[_FALLBACK_BETA], fallbacks="default", **kwargs
            ) as stream:
                yield from stream.text_stream
        else:
            with self._client.messages.stream(**kwargs) as stream:
                yield from stream.text_stream

    # -- non-streaming (convenience for CLI / tests) -------------------------
    def answer(self, question: str, sources: list[dict]) -> str:
        """Return the full answer text as a single string."""
        return "".join(self.stream_answer(question, sources))
