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


def test_client_send_interactive_buttons_vs_list():
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"messages": [{"id": "x"}]})

    client = WhatsAppClient("t", "p", http_client=httpx.Client(transport=httpx.MockTransport(handler)))

    # <=3 short options -> reply buttons.
    client.send_interactive("1", "Pick", [("ask", "Ask"), ("checklist", "List")])
    assert sent[-1]["interactive"]["type"] == "button"
    assert len(sent[-1]["interactive"]["action"]["buttons"]) == 2

    # >3 options -> list menu, capped at 10 rows, titles truncated to 24 chars.
    opts = [(str(i), "A very long option title that exceeds limits " + str(i)) for i in range(12)]
    client.send_interactive("1", "Pick many", opts)
    inter = sent[-1]["interactive"]
    assert inter["type"] == "list"
    rows = inter["action"]["sections"][0]["rows"]
    assert len(rows) == 10
    assert all(len(r["title"]) <= 24 for r in rows)


def test_client_mark_read():
    sent = []

    def handler(request):
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"success": True})

    client = WhatsAppClient("t", "p", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    client.mark_read("wamid.abc")
    assert sent[-1]["status"] == "read" and sent[-1]["message_id"] == "wamid.abc"


def test_client_raises_on_error():
    def handler(request):
        return httpx.Response(400, json={"error": {"message": "bad"}})

    client = WhatsAppClient("t", "p", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    try:
        client.send_text("1", "x")
        assert False, "expected WhatsAppError"
    except Exception as e:
        assert "400" in str(e)
