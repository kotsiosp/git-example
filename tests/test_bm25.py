from app.rag.bm25 import BM25Index, tokenize


def _index(docs):
    return BM25Index([tokenize(d) for d in docs])


def test_tokenize_drops_stopwords_and_lowercases():
    toks = tokenize("How do I get a Yellow Slip?")
    assert "yellow" in toks and "slip" in toks
    assert "how" not in toks and "a" not in toks


def test_search_ranks_relevant_doc_first():
    docs = [
        "Yellow Slip registration certificate MEU1 for EU citizens residence.",
        "VAT registration threshold for businesses and self employed.",
        "GeSy health system personal doctor registration.",
    ]
    idx = _index(docs)
    results = idx.search("how do I get a yellow slip", top_k=3)
    assert results, "expected at least one match"
    assert results[0][0] == 0  # the yellow-slip doc ranks first


def test_search_returns_empty_for_no_overlap():
    idx = _index(["completely unrelated content about fishing boats"])
    assert idx.search("quantum chromodynamics") == []


def test_scores_are_sorted_descending():
    docs = ["tax return deadline tax return", "tax something", "unrelated"]
    idx = _index(docs)
    results = idx.search("tax return", top_k=3)
    scores = [s for _, s in results]
    assert scores == sorted(scores, reverse=True)
    assert all(s > 0 for s in scores)
