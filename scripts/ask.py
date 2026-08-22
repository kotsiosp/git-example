#!/usr/bin/env python3
"""Ask the Cyprus agent a question from the command line (no server needed).

Usage:
    python -m scripts.ask "How do I get a Yellow Slip?"
    python -m scripts.ask            # then type your question at the prompt

Requires ANTHROPIC_API_KEY to be set for the answer step. Retrieval works without it,
so `--sources-only` prints the matched official sources with no API call.
"""
from __future__ import annotations

import argparse
import sys

from app.main import build_qa_service


def main() -> int:
    parser = argparse.ArgumentParser(description="Ask the Cyprus Bureaucracy & Citizen Agent.")
    parser.add_argument("question", nargs="*", help="Your question (English or Greek).")
    parser.add_argument(
        "--sources-only",
        action="store_true",
        help="Only show retrieved official sources; do not call the Claude API.",
    )
    args = parser.parse_args()

    question = " ".join(args.question).strip() or input("Question: ").strip()
    if not question:
        print("No question provided.", file=sys.stderr)
        return 2

    qa = build_qa_service()

    if args.sources_only:
        chunks = qa.kb.retrieve(question, top_k=qa.settings.retrieval_top_k)
        if not chunks:
            print("No matching official sources found.")
            return 0
        for i, c in enumerate(chunks, 1):
            print(f"[{i}] {c.title}  (score={c.score:.2f})\n    {c.url}\n")
        return 0

    result = qa.answer(question)
    print(result.text)
    print()
    if result.citations:
        print("Sources:")
        for c in result.citations:
            print(f"  [{c.n}] {c.title} — {c.url}")
        print()
    print(result.disclaimer)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
