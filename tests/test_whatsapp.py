import hashlib
import hmac
import json

import httpx

from app.whatsapp import (
    WhatsAppClient,
    parse_incoming,
    verify_signature,
    verify_webhook,
)


def test_verify_webhook_success_and_failure():
    assert verify_webhook("subscribe", "tok", "CHAL", "tok") == "CHAL"
    assert verify_webhook("subscribe", "wrong", "CHAL", "tok") is None
    assert verify_webhook("subscribe", "tok", "CHAL", None) is None


def test_verify_signature():
    secret = "s3cret"
    body = b'{"hello":"world"}'
    good = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_signature(secret, body, good) is True
    assert verify_signature(secret, body, "sha256=deadbeef") is False
    assert verify_signature(secret, body, None) is False
    # No secret configured -> verification skipped (dev mode).
    assert verify_signature(None, body, None) is True


def test_parse_incoming_text():
    payload = {
        "entry": [{
            "changes": [{
                "value": {
                    "contacts": [{"wa_id": "35799123456", "profile": {"name": "Maria"}}],
                    "messages": [{
                        "from": "35799123456", "id": "wamid.1", "type": "text",
                        "text": {"body": "How do I get a Yellow Slip?"},
                    }],
                }
            }]
        }]
    }
    msgs = parse_incoming(payload)
    assert len(msgs) == 1
    assert msgs[0].from_ == "35799123456"
    assert msgs[0].text == "How do I get a Yellow Slip?"
    assert msgs[0].contact_name == "Maria"


def test_parse_incoming_interactive_and_statuses():
    payload = {
        "entry": [{"changes": [{"value": {"messages": [{
            "from": "1", "id": "wamid.2", "type": "interactive",
            "interactive": {"type": "button_reply", "button_reply": {"id": "checklist", "title": "Checklist"}},
        }]}}]}]
    }
    msgs = parse_incoming(payload)
    assert msgs[0].text == "checklist"

    # A status-only callback yields no messages.
    status_payload = {"entry": [{"changes": [{"value": {"statuses": [{"status": "delivered"}]}}]}]}
    assert parse_incoming(status_payload) == []


def test_client_send_text_and_document(tmp_path):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.path.endswith("/media"):
            return httpx.Response(200, json={"id": "media-123"})
        return httpx.Response(200, json={"messages": [{"id": "wamid.out"}]})

    transport = httpx.MockTransport(handler)
    http = httpx.Client(transport=transport)
    client = WhatsAppClient("token", "PHONE_ID", http_client=http)

    r = client.send_text("35799123456", "hello")
    assert r["messages"][0]["id"] == "wamid.out"
    body = json.loads(calls[-1].content)
    assert body["type"] == "text" and body["text"]["body"] == "hello"

    pdf = tmp_path / "doc.pdf"
    pdf.write_bytes(b"%PDF-1.4 test")
    client.send_document("35799123456", pdf, filename="doc.pdf", caption="here")
    # Two more calls: media upload, then document message.
    assert calls[-2].url.path.endswith("/media")
    doc_body = json.loads(calls[-1].content)
    assert doc_body["type"] == "document"
    assert doc_body["document"]["id"] == "media-123"


def test_client_raises_on_error():
    def handler(request):
        return httpx.Response(400, json={"error": {"message": "bad"}})

    client = WhatsAppClient("t", "p", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    try:
        client.send_text("1", "x")
        assert False, "expected WhatsAppError"
    except Exception as e:
        assert "400" in str(e)
