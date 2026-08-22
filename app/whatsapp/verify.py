"""Webhook verification helpers for the WhatsApp Cloud API."""
from __future__ import annotations

import hashlib
import hmac


def verify_webhook(mode: str | None, token: str | None, challenge: str | None,
                   expected_token: str | None) -> str | None:
    """Meta webhook verification handshake (GET).

    Returns the challenge string to echo back when verification succeeds, else None.
    """
    if mode == "subscribe" and token and expected_token and hmac.compare_digest(token, expected_token):
        return challenge
    return None


def verify_signature(app_secret: str | None, payload: bytes, signature_header: str | None) -> bool:
    """Verify the ``X-Hub-Signature-256`` header on an inbound webhook POST.

    If ``app_secret`` is not configured, verification is skipped (returns True) so the app
    runs in local/dev without an app secret — set WHATSAPP_APP_SECRET in production.
    """
    if not app_secret:
        return True
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    provided = signature_header.split("=", 1)[1]
    return hmac.compare_digest(expected, provided)
