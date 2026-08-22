# Knowledge base sources

Each `*.md` file in `sources/` is one official-procedure document indexed by the RAG
pipeline. Files start with a frontmatter block:

```
---
title: How to Get a Yellow Slip (MEU1)
source_url: https://www.moi.gov.cy/crmd
category: immigration
last_reviewed: 2026-08-22
---
<body in Markdown>
```

`title` and `source_url` are surfaced to users as citations, so keep them accurate.

## ⚠️ These are SAMPLE documents

The files here are **illustrative seed content** so the app runs end-to-end. They are
**not** an authoritative copy of Cyprus law. Specific fees, deadlines, and form numbers
are marked `(verify …)` on purpose — do not ship them as-is.

Building the real "data moat" (Phase 1 of the blueprint) means replacing these with
scraped/downloaded official content from:

- https://www.gov.cy — central government portal
- https://www.companies.gov.cy — Registrar of Companies
- https://www.moi.gov.cy/crmd — Civil Registry and Migration Department
- https://www.gesy.org.cy — GeSy (national health system)
- https://www.mof.gov.cy/tax — Tax Department / TAXISnet

Keep one document per procedure, record `last_reviewed`, and re-index by restarting the
app (the knowledge base is built at startup).
