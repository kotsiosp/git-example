"""Parsing of inbound WhatsApp Cloud API webhook payloads."""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class IncomingMessage:
    from_: str          # sender's WhatsApp id (phone number, digits only)
    message_id: str
    type: str           # "text", "interactive", "button", or other
    text: str           # best-effort text (body, or the id/title of a tapped button)
    timestamp: str = ""
    contact_name: str = ""
    raw: dict = field(default_factory=dict)


def _interactive_text(interactive: dict) -> str:
    """Extract the chosen option from an interactive (button/list) reply."""
    if not isinstance(interactive, dict):
        return ""
    br = interactive.get("button_reply") or interactive.get("list_reply") or {}
    # Prefer the stable id we set when sending; fall back to the visible title.
    return str(br.get("id") or br.get("title") or "").strip()


def parse_incoming(payload: dict) -> list[IncomingMessage]:
    """Return the user messages contained in a webhook payload.

    Status callbacks (delivered/read) and non-message events yield an empty list.
    """
    messages: list[IncomingMessage] = []
    if not isinstance(payload, dict):
        return messages

    for entry in payload.get("entry", []) or []:
        for change in entry.get("changes", []) or []:
            value = change.get("value", {}) or {}
            contacts = {c.get("wa_id"): c for c in value.get("contacts", []) or []}
            for msg in value.get("messages", []) or []:
                mtype = msg.get("type", "")
                if mtype == "text":
                    text = (msg.get("text") or {}).get("body", "")
                elif mtype == "interactive":
                    text = _interactive_text(msg.get("interactive") or {})
                elif mtype == "button":  # template quick-reply button
                    text = (msg.get("button") or {}).get("text", "")
                else:
                    # Unsupported types (image, audio, location, ...) — keep an empty body
                    # so the router can reply with a friendly "text only" message.
                    text = ""
                sender = msg.get("from", "")
                contact = contacts.get(sender, {})
                messages.append(
                    IncomingMessage(
                        from_=sender,
                        message_id=msg.get("id", ""),
                        type=mtype,
                        text=text,
                        timestamp=msg.get("timestamp", ""),
                        contact_name=(contact.get("profile") or {}).get("name", ""),
                        raw=msg,
                    )
                )
    return messages
