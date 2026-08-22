# Cyprus Bureaucracy & Citizen Agent — Q&A (RAG) MVP

An AI assistant that answers questions about Republic of Cyprus public-administration
procedures (residency, tax, GeSy health, company formation, VAT) **grounded in official
documents**. It uses Retrieval-Augmented Generation (RAG): the app first looks up the
relevant official text, then asks Claude to explain it in plain language — and to say
"I don't know, go to a Citizens Service Centre (ΚΕΠ)" when the answer isn't in the
sources.

This is the **Phase 1 + Phase 3.1** slice of the product blueprint: the knowledge-base
data moat and the Question-Answering bot. The Document Checklist Generator and Form
Filler are designed to slot in later behind the same retrieval layer.

> ⚠️ Not affiliated with the Republic of Cyprus. Not legal or tax advice. The seed
> documents in `data/sources/` are **illustrative samples** — see `data/README.md`.

## Architecture

```
question ──▶ KnowledgeBase.retrieve()      # BM25 over chunked official docs (offline)
                    │  top-k official chunks (with title + source URL)
                    ▼
             QAService  ──▶ ClaudeClient    # strict system prompt + cached context
                    │                        # streaming answer, inline [Source N] cites
                    ▼
             Answer { text, citations[], grounded, disclaimer }
```

- **Retrieval** is a dependency-free **BM25** index (`app/rag/`). No embedding API key is
  needed, so retrieval and the whole test suite run offline and deterministically. Swap
  in a vector store (e.g. Voyage AI embeddings) later behind `KnowledgeBase.retrieve()`.
- **Generation** uses the Anthropic SDK (`app/llm/client.py`) with a strict system prompt
  that forbids guessing, requires citations, and defers to official sources.
- **API** is FastAPI (`app/main.py`) with JSON and streaming (NDJSON) endpoints.

```
app/
  config.py         env-driven settings
  prompts.py        strict Cyprus system prompt + context formatting
  disclaimer.py     shared legal disclaimer + ΚΕΠ referral text
  rag/              documents.py · chunking.py · bm25.py · retriever.py
  llm/client.py     Anthropic SDK wrapper (streaming, prompt caching, refusal fallback)
  services/qa.py    retrieve + generate orchestration
  main.py           FastAPI app: /health, /ask, /ask/stream
data/sources/       official-source Markdown documents (the knowledge base)
scripts/ask.py      CLI: ask a question without running the server
tests/              offline tests (chunking, BM25, retrieval, API with stubbed LLM)
```

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then add your ANTHROPIC_API_KEY
```

## Run

```bash
# HTTP API
uvicorn app.main:app --reload
# open http://127.0.0.1:8000/docs

# One-off from the CLI
python -m scripts.ask "I just moved to Limassol, how do I get a Yellow Slip?"

# See only the retrieved official sources (no API key / no API call)
python -m scripts.ask --sources-only "when do I register for VAT?"
```

### API

```bash
curl -s http://127.0.0.1:8000/ask \
  -H 'content-type: application/json' \
  -d '{"question":"What documents do I need for a Yellow Slip?"}' | jq
```

Response:

```json
{
  "answer": "To apply for the Yellow Slip you submit form MEU1 ... [Source 1]",
  "citations": [
    {"n": 1, "title": "Yellow Slip — EU Citizen Registration Certificate (MEU1)",
     "url": "https://www.moi.gov.cy/crmd", "category": "immigration", "score": 12.3}
  ],
  "grounded": true,
  "disclaimer": "This app is an AI-powered assistant, not a legal or tax advisor. ..."
}
```

`POST /ask/stream` returns the same content as NDJSON: a `citations` line, then `token`
lines, then a `done` line.

## Configuration

All settings are environment variables (see `.env.example`). Key ones:

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Required to generate answers; retrieval/tests work without it. |
| `CLAUDE_MODEL` | `claude-opus-5` | Use `claude-sonnet-5` / `claude-haiku-4-5` for cheaper, high-volume traffic. |
| `CLAUDE_EFFORT` | `medium` | `low`…`max`. Raise for harder reasoning. |
| `RETRIEVAL_TOP_K` | `4` | Number of chunks passed to the model. |

Server-side **refusal fallback** is enabled by default and applied automatically only
for models that support it (`claude-opus-5` / `claude-fable-5`).

## Testing

```bash
pytest -q      # fully offline: no API key or network required
```

## Building the real knowledge base (next step)

Replace the sample documents in `data/sources/` with scraped/downloaded official content
from gov.cy, the Registrar of Companies, CRMD, GeSy, and the Tax Department. Keep one
Markdown file per procedure with accurate `title` / `source_url` frontmatter, then
restart the app to re-index. See `data/README.md`.

## Roadmap (from the blueprint)

- [x] Phase 1 — knowledge-base data moat (RAG pipeline; sample sources)
- [x] Phase 3.1 — Question-Answering bot (this MVP)
- [ ] Phase 3.2 — Document Checklist Generator
- [ ] Phase 3.3 — Form Filler (auto-fill TD1 / MEU1 PDFs) — premium
- [ ] Phase 2 — WhatsApp Business API channel in front of `/ask`
- [ ] Phase 4 — freemium metering (3 free inquiries/month) + billing
- [ ] Phase 5 — GDPR: EU hosting, encryption at rest, data-erasure endpoint
