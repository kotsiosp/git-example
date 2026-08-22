from app.config import DEFAULT_SOURCES_DIR
from app.rag import KnowledgeBase


def _kb():
    return KnowledgeBase.from_sources(DEFAULT_SOURCES_DIR)


def test_knowledge_base_loads_documents_and_chunks():
    kb = _kb()
    assert len(kb.documents) >= 5
    assert kb.num_chunks >= len(kb.documents)


def test_documents_have_titles_and_urls():
    kb = _kb()
    for doc in kb.documents:
        assert doc.title
        assert doc.url.startswith("http")


def test_retrieve_yellow_slip():
    kb = _kb()
    chunks = kb.retrieve("I moved to Limassol, how do I get a yellow slip?", top_k=4)
    assert chunks
    assert any("Yellow Slip" in c.title for c in chunks)


def test_retrieve_vat():
    kb = _kb()
    chunks = kb.retrieve("when must I register for VAT as self employed", top_k=4)
    assert chunks
    assert any(c.category == "tax" for c in chunks)


def test_retrieve_offtopic_returns_nothing():
    kb = _kb()
    chunks = kb.retrieve("best hiking trails in the Troodos mountains", top_k=4)
    # Off-topic queries with no lexical overlap should surface no official sources.
    assert chunks == []
