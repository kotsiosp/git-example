"""Fetch a URL and extract readable text from its HTML.

``httpx`` is created with ``trust_env=True`` so it honours the environment's HTTPS proxy.
HTML is reduced to headings/paragraphs/list items with BeautifulSoup; navigation, scripts,
and boilerplate are stripped.
"""
from __future__ import annotations

import re

import httpx
from bs4 import BeautifulSoup

_NOISE_TAGS = ["script", "style", "noscript", "nav", "footer", "header", "aside", "form", "svg", "iframe"]
_MAX_CHARS = 20000


def fetch_url(url: str, user_agent: str, timeout: float = 30.0,
              http_client: httpx.Client | None = None) -> str:
    """Return the raw HTML for ``url`` (raises httpx.HTTPError on failure)."""
    headers = {"User-Agent": user_agent, "Accept": "text/html,application/xhtml+xml"}
    if http_client is not None:
        resp = http_client.get(url, headers=headers, follow_redirects=True, timeout=timeout)
    else:
        with httpx.Client(trust_env=True, follow_redirects=True, timeout=timeout) as client:
            resp = client.get(url, headers=headers)
    resp.raise_for_status()
    return resp.text


def html_to_text(html: str, selector: str | None = None, max_chars: int = _MAX_CHARS) -> str:
    """Extract readable text (headings as Markdown ``#``, list items as ``-``)."""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(_NOISE_TAGS):
        tag.decompose()

    root = None
    if selector:
        root = soup.select_one(selector)
    if root is None:
        root = soup.find("main") or soup.find("article") or soup.body or soup

    lines: list[str] = []
    seen: set[str] = set()
    for el in root.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li"]):
        txt = el.get_text(" ", strip=True)
        if not txt or len(txt) < 3:
            continue
        key = (el.name, txt)
        if key in seen:  # skip repeated menu-ish items
            continue
        seen.add(key)
        if el.name[0] == "h" and el.name[1:].isdigit():
            level = min(int(el.name[1]), 3)
            lines.append("\n" + "#" * level + " " + txt)
        elif el.name == "li":
            lines.append("- " + txt)
        else:
            lines.append(txt)

    text = "\n\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) > max_chars:
        text = text[:max_chars].rsplit("\n", 1)[0] + "\n\n… (truncated)"
    return text
