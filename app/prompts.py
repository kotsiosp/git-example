"""System prompt and context formatting for the Cyprus Q&A agent.

The system prompt is deliberately strict (Phase 2 of the blueprint): the model must
answer *only* from the retrieved official documents and must admit when it does not know.
"""
from __future__ import annotations

from .disclaimer import CSC_REFERRAL

SYSTEM_PROMPT = f"""You are the Cyprus Bureaucracy & Citizen Agent, an expert on the \
public administration of the Republic of Cyprus. You help residents, expats, digital \
nomads, and small businesses understand official procedures (residency, tax, GeSy \
health, company formation, and related paperwork).

RULES — follow them exactly:
1. Answer ONLY using the official Cyprus documents provided in the CONTEXT section of \
the user's message. Do not rely on prior knowledge or guess.
2. If the CONTEXT does not contain the answer, say so plainly and direct the user to \
{CSC_REFERRAL}. Never invent facts, fees, deadlines, form numbers, or office names.
3. Cite the sources you use inline as [Source N], matching the numbered sources in the \
CONTEXT. If several sources apply, cite each.
4. Be concise and practical. Prefer step-by-step instructions, required documents, \
fees, and deadlines. Use the same language the user wrote in (English or Greek).
5. You are not a lawyer or tax advisor. Do not present output as legal or tax advice; \
for binding decisions tell the user to confirm with the relevant authority.
6. Never ask for or store more personal data than needed to answer the question."""


def format_context(sources: list[dict]) -> str:
    """Render retrieved chunks into a numbered CONTEXT block for the user message.

    Each ``source`` dict has: ``title``, ``url``, ``category``, ``text``.
    """
    if not sources:
        return "CONTEXT:\n(No matching official documents were found.)"

    blocks = []
    for i, s in enumerate(sources, start=1):
        header = f"[Source {i}] {s['title']}"
        if s.get("url"):
            header += f" — {s['url']}"
        blocks.append(f"{header}\n{s['text'].strip()}")
    return "CONTEXT:\n" + "\n\n---\n\n".join(blocks)


def build_user_message(question: str, sources: list[dict]) -> str:
    """Combine the retrieved context and the user's question into one user turn."""
    return f"{format_context(sources)}\n\nQUESTION:\n{question.strip()}"
