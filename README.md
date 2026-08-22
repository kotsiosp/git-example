# Cyprus Bureaucracy & Citizen Agent

An AI assistant for **Republic of Cyprus** public-administration procedures (residency,
tax, GeSy health, VAT, company formation), delivered over **WhatsApp** and a built-in
**web chat**. It answers questions, builds personalised **document checklists**, and
**pre-fills official forms** — all grounded in official documents via Retrieval-Augmented
Generation (RAG), so it cites sources and says "I don't know, go to a Citizens Service
Centre (ΚΕΠ)" when the answer isn't in the sources.

**User-friendly by design:** tappable quick-reply buttons and menus (not "reply with a
number"), fully **bilingual English/Greek** with automatic language detection, a friendly
onboarding welcome, read receipts, and a polished browser chat you can try instantly.

Implements the full product blueprint:

| Phase | What | Status |
|---|---|---|
| 1 | Knowledge-base data moat (RAG pipeline) | ✅ (sample sources — swap for scraped official content) |
| 2 | WhatsApp Cloud API channel | ✅ |
| 3.1 | Question-Answering bot | ✅ |
| 3.2 | Document Checklist Generator (→ PDF) | ✅ |
| 3.3 | Form Filler — auto-fill MEU1 / TD1 (→ PDF) | ✅ |
| 4 | Freemium metering (N free inquiries/month) | ✅ |
| 5 | GDPR: erasure, minimal retention, EU hosting notes | ✅ |

> ⚠️ Not affiliated with the Republic of Cyprus. Not legal or tax advice. The seed
> documents and form field lists are **illustrative samples** — see `data/README.md` and
> `app/forms/definitions.py`.

## Architecture

```
WhatsApp  ──►  /webhook/whatsapp  ──►  ConversationService (state machine, per user)
 (Cloud API)      (verify + HMAC)          │
                                           ├─ Q&A ........ KnowledgeBase.retrieve() ─► Claude (streamed, cited)
                                           ├─ Checklist .. 3 questions ─► Claude ─► PDF
                                           ├─ Form Filler  free text ─► Claude field extraction ─► PDF
                                           ├─ Freemium ... SQLite usage metering + premium flag
                                           └─ GDPR ....... "delete my data" ─► erase
                                           │
                        replies (text + PDF documents) ──► WhatsApp Cloud API (send / media upload)
```

- **Retrieval** is a dependency-free **BM25** index (`app/rag/`) — no embedding key
  needed, so retrieval, PDF generation, the router, and the whole test suite run offline
  and deterministically. Swap in a vector store behind `KnowledgeBase.retrieve()` later.
- **Generation** uses the Anthropic SDK (`claude-opus-5`, adaptive thinking, streaming,
  prompt caching, refusal fallback).
- **The conversation router** (`app/services/conversation.py`) is pure/testable — it turns
  a message into a list of outbound actions; the webhook layer does the network I/O.

```
app/
  config.py            env-driven settings
  prompts.py           strict system prompts (Q&A, checklist, extraction)
  i18n.py              EN/EL string catalog + language detection
  disclaimer.py        shared legal disclaimer + ΚΕΠ referral
  rag/                 documents · chunking · bm25 · retriever
  llm/                 client.py (Anthropic wrapper) · parsing.py (tolerant JSON)
  pdf/                 render.py (checklists + filled forms, Greek-capable)
  forms/               TD1/MEU1 form definitions + checklist topic definitions
  storage/             SQLite: usage metering, premium, GDPR erasure
  whatsapp/            Cloud API client (text/interactive/media/read) · webhook parse/verify
  services/            qa · checklist · formfiller · usage · conversation (router)
  web/index.html       self-contained web chat UI (buttons, EN/EL, PDF cards)
  main.py              FastAPI app + endpoints
data/sources/          official-source documents (the knowledge base)
scripts/ask.py         CLI: ask a question without the server
tests/                 58 offline tests (LLM + WhatsApp stubbed)
docs/WHATSAPP.md       step-by-step Meta / WhatsApp setup
Dockerfile · docker-compose.yml
```

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # add ANTHROPIC_API_KEY (+ WhatsApp creds to go live)
uvicorn app.main:app --reload
```

Then **open <http://localhost:8000/>** for the built-in web chat — the fastest way to try
the whole product (tappable buttons, checklists, form filling, EN/EL) with no WhatsApp
setup. To go live on WhatsApp see **`docs/WHATSAPP.md`**.

You can also drive the exact same conversation engine from the command line / scripts:

```bash
# Q&A
curl -s localhost:8000/simulate -d '{"user_id":"me","text":"How do I get a Yellow Slip?"}' \
  -H 'content-type: application/json' | jq

# Checklist (multi-turn): checklist -> pick topic -> answer 3 questions -> PDF path returned
curl -s localhost:8000/simulate -d '{"user_id":"me","text":"checklist"}' -H 'content-type: application/json'

# One-off Q&A from the CLI (no server)
python -m scripts.ask "What is the deadline for my tax return?"
python -m scripts.ask --sources-only "when do I register for VAT?"   # no API key needed
```

### Docker

```bash
docker compose up --build     # serves on :8000, persists state in a volume, Greek fonts included
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/` | Web chat demo UI |
| GET  | `/health` | Liveness + KB stats + config flags |
| POST | `/ask` | Q&A (JSON answer + citations) |
| POST | `/ask/stream` | Q&A streamed as NDJSON |
| POST | `/web/message` · `/simulate` | Run the conversation router (web UI + local testing, no Meta) |
| GET  | `/files/{name}` | Download a generated PDF (path-traversal-safe) |
| GET  | `/webhook/whatsapp` | Meta webhook verification |
| POST | `/webhook/whatsapp` | Inbound WhatsApp messages (HMAC-verified) |
| POST | `/gdpr/erase` | Delete all stored data for a user |
| GET  | `/gdpr/usage/{user_id}` | A user's current usage/quota (transparency) |
| POST | `/admin/premium` | Toggle a user's premium flag (**demo — protect in prod**) |

## Features in detail

**Channels & UX** — the same conversation engine serves WhatsApp and the built-in web
chat. Selections are **tappable buttons/lists** (WhatsApp reply buttons for ≤3 options, a
list menu otherwise; the web UI renders quick-reply chips), the UI is **bilingual EN/EL**
with automatic detection, new users get a welcome + disclaimer, and WhatsApp messages are
marked read. Typed replies still work everywhere, so nothing depends on tapping.

**Q&A bot** — retrieves the top official chunks, sends them to Claude under a strict
"answer only from these documents, cite `[Source N]`, otherwise defer to ΚΕΠ" prompt.

**Checklist Generator** — asks 3 personalising questions per topic (Yellow Slip, company,
GeSy, VAT, tax), then generates a tailored, grounded checklist and renders a printable
**PDF** sent over WhatsApp.

**Form Filler (premium)** — the user describes their details in plain English or Greek;
Claude extracts the fields for the chosen form (MEU1 / TD1); the app renders a
pre-filled, printable **PDF** and lists any required fields still missing.

**Freemium** — `FREE_INQUIRIES_PER_MONTH` (default 3) metered per user in SQLite;
menu/help/cancel/`delete my data` are always free; `upgrade` explains premium. Wire real
billing to `Store.set_premium`.

**GDPR** — only a monthly counter + premium flag are stored (no message content);
`delete my data` (or `POST /gdpr/erase`) wipes it; host in the EU and mount an encrypted
volume for `DATA_DIR`. See Phase 5 notes below.

## Testing

```bash
pytest -q      # 58 tests, fully offline — no API key, no network
```

Tests stub the Claude client and WhatsApp transport, covering chunking, BM25, retrieval,
PDF generation, usage/metering, i18n + language detection, the WhatsApp client
(text/interactive/media/read) + webhook parsing/verification, every conversation flow
(Q&A, checklist, form, freemium gate, GDPR, Greek), and the HTTP API (including the web
chat endpoint and safe file serving). The web UI itself was verified end-to-end in a real
browser (menu → tappable checklist → PDF card, plus the Greek path).

## Going to production

- **Knowledge base:** replace the samples in `data/sources/` with scraped/downloaded
  official content (gov.cy, Registrar of Companies, CRMD, GeSy, Tax Department). One
  Markdown file per procedure with accurate `title`/`source_url`. Restart to re-index.
  (See `data/README.md`.)
- **Forms:** verify each form's official field set in `app/forms/definitions.py`; ideally
  overlay onto the real official PDF templates.
- **Scale:** move sessions from in-memory `SessionStore` to Redis; move `Store` to
  Postgres; run multiple workers.
- **GDPR (Phase 5):** EU hosting (e.g. AWS Frankfurt), encryption at rest for `DATA_DIR`,
  the erasure endpoint (implemented), and the in-app disclaimer (implemented).
- **Security:** protect `/admin/*`, set `WHATSAPP_APP_SECRET` so inbound webhooks are
  signature-verified, and keep secrets in `.env` / a secret manager (never in git).
