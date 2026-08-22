from app.rag.chunking import chunk_text


def test_short_text_is_single_chunk():
    text = "Para one.\n\nPara two."
    chunks = chunk_text(text, chunk_size_words=100, overlap_words=10)
    assert len(chunks) == 1
    assert "Para one." in chunks[0] and "Para two." in chunks[0]


def test_long_text_splits_with_overlap():
    words = " ".join(f"w{i}" for i in range(500))
    text = words  # single long paragraph
    chunks = chunk_text(text, chunk_size_words=100, overlap_words=20)
    assert len(chunks) > 1
    # consecutive chunks share the overlap tail
    first_tail = chunks[0].split()[-20:]
    second_head = chunks[1].split()[:20]
    assert first_tail == second_head


def test_paragraphs_packed_within_budget():
    text = "\n\n".join(["alpha beta gamma"] * 10)  # 30 words total
    chunks = chunk_text(text, chunk_size_words=12, overlap_words=3)
    # each chunk (except via overlap) stays near the budget
    assert all(len(c.split()) <= 12 for c in chunks)
    assert len(chunks) >= 3


def test_empty_text():
    assert chunk_text("", chunk_size_words=50) == []
