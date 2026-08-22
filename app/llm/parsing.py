"""Tolerant JSON extraction from model output.

Models occasionally wrap JSON in prose or code fences despite instructions. This finds the
first balanced JSON object/array in the text and parses it. Using this instead of
``json.loads(text)`` directly keeps the checklist/extraction paths robust across models.
"""
from __future__ import annotations

import json
from typing import Any


def extract_json(text: str) -> Any:
    """Return the first JSON value found in ``text``. Raises ValueError if none parses."""
    text = text.strip()
    # Strip a ```json ... ``` fence if present.
    if text.startswith("```"):
        text = text.split("```", 2)[1] if text.count("```") >= 2 else text.strip("`")
        if text.lstrip().startswith("json"):
            text = text.lstrip()[4:]

    # Fast path.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Scan for the first balanced { } or [ ] block, respecting strings/escapes.
    for open_ch, close_ch in (("{", "}"), ("[", "]")):
        start = text.find(open_ch)
        if start == -1:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == open_ch:
                depth += 1
            elif ch == close_ch:
                depth -= 1
                if depth == 0:
                    candidate = text[start : i + 1]
                    try:
                        return json.loads(candidate)
                    except json.JSONDecodeError:
                        break
    raise ValueError("No parseable JSON found in model output")
