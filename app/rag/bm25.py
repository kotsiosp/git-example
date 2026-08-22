"""A small, dependency-free BM25 (Okapi) ranking index.

BM25 is a strong lexical baseline for RAG and needs no embedding API key, so the whole
pipeline runs offline and deterministically — ideal for an MVP and for tests. Swap in a
vector store (e.g. Voyage AI embeddings + cosine search) later behind the same
``search()`` interface without touching the rest of the app.
"""
from __future__ import annotations

import math
import re
from collections import Counter

_TOKEN_RE = re.compile(r"[a-z0-9Ͱ-Ͽἀ-῿]+")  # latin + digits + Greek

# Function-word stopword set (English + Greek). These — articles, pronouns,
# interrogatives, auxiliaries, modals, prepositions — carry no topical signal and would
# otherwise match nearly every document (e.g. "Who must file..."), so we drop them.
_STOPWORDS = {
    # English articles / conjunctions / prepositions
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "as",
    "by", "from", "if", "into", "out", "about", "over", "under", "than", "then",
    "so", "not", "no", "yes", "but", "also",
    # English pronouns
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "this", "that", "these", "those",
    # English interrogatives
    "how", "what", "when", "where", "which", "who", "whom", "whose", "why",
    # English auxiliaries / modals / common copulas
    "is", "are", "be", "am", "was", "were", "been", "being", "do", "does", "did",
    "have", "has", "had", "can", "could", "will", "would", "shall", "should",
    "may", "might", "must",
    # Greek function words
    "και", "να", "το", "η", "ο", "τα", "της", "του", "στο", "στη", "για", "με",
    "πως", "πώς", "τι", "ειναι", "είναι", "σε", "απο", "από", "που", "ποιος", "ποια",
    "ποιο", "γιατι", "γιατί", "θα", "οι", "τον", "την", "ένα", "μια", "ή",
}


def tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if t not in _STOPWORDS]


class BM25Index:
    """Okapi BM25 over a fixed list of documents (chunks)."""

    def __init__(self, docs_tokens: list[list[str]], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.docs_tokens = docs_tokens
        self.n_docs = len(docs_tokens)
        self.doc_len = [len(d) for d in docs_tokens]
        self.avg_len = (sum(self.doc_len) / self.n_docs) if self.n_docs else 0.0
        self.term_freqs: list[Counter] = [Counter(d) for d in docs_tokens]

        # document frequency per term
        df: Counter = Counter()
        for tf in self.term_freqs:
            df.update(tf.keys())
        # BM25 idf with the +1 smoothing that keeps idf non-negative
        self.idf = {
            term: math.log(1 + (self.n_docs - freq + 0.5) / (freq + 0.5))
            for term, freq in df.items()
        }

    def score(self, query_tokens: list[str], index: int) -> float:
        if self.avg_len == 0:
            return 0.0
        tf = self.term_freqs[index]
        dl = self.doc_len[index]
        score = 0.0
        for term in query_tokens:
            if term not in tf:
                continue
            idf = self.idf.get(term, 0.0)
            freq = tf[term]
            denom = freq + self.k1 * (1 - self.b + self.b * dl / self.avg_len)
            score += idf * (freq * (self.k1 + 1)) / denom
        return score

    def search(self, query: str, top_k: int = 4) -> list[tuple[int, float]]:
        """Return ``[(doc_index, score), ...]`` for the best ``top_k`` docs, score-desc.

        Docs with a zero score are dropped so we never return irrelevant context.
        """
        q = tokenize(query)
        if not q or self.n_docs == 0:
            return []
        scored = [(i, self.score(q, i)) for i in range(self.n_docs)]
        scored = [pair for pair in scored if pair[1] > 0.0]
        scored.sort(key=lambda pair: pair[1], reverse=True)
        return scored[:top_k]
