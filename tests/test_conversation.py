"""End-to-end conversation router tests (offline, stubbed LLM)."""
from app.services.conversation import IDLE


def _first_text(reply):
    return reply.texts()[0] if reply.texts() else ""


def test_menu(conversation):
    reply = conversation.handle("u1", "menu")
    body = _first_text(reply)
    assert "Ask a question" in body and "checklist" in body.lower()


def test_default_is_qa_with_citations(conversation):
    reply = conversation.handle("u1", "How do I get a Yellow Slip?")
    body = _first_text(reply)
    assert "guidance" in body.lower()
    assert "Sources:" in body
    assert "free inquiries left" in body  # quota footer for non-premium


def test_checklist_flow_produces_pdf(conversation):
    assert "which procedure" in _first_text(conversation.handle("u2", "checklist")).lower()
    conversation.handle("u2", "1")            # pick first topic
    conversation.handle("u2", "1")            # answer Q1
    conversation.handle("u2", "1")            # answer Q2
    reply = conversation.handle("u2", "1")    # answer Q3 -> generate
    docs = [o for o in reply.outbound if o.kind == "document"]
    assert docs and docs[0].path.exists()
    # session reset after completion
    assert conversation.sessions.get("u2").state == IDLE


def test_form_flow_collects_then_fills(conversation):
    conversation.handle("u3", "form")
    reply = conversation.handle("u3", "1")  # pick first form (MEU1)
    assert "MEU1" in _first_text(reply) or "Registration" in _first_text(reply)

    # Partial details -> should report still-missing required fields.
    reply = conversation.handle("u3", "full_name=Maria Georgiou; nationality=Greek")
    assert "required" in _first_text(reply).lower()

    # Complete the rest -> then generate.
    conversation.handle(
        "u3",
        "date_of_birth=1990-05-14; passport_or_id_number=AB123; "
        "purpose_of_residence=Employment; address_in_cyprus=12 Makariou Ave",
    )
    reply = conversation.handle("u3", "done")
    docs = [o for o in reply.outbound if o.kind == "document"]
    assert docs and docs[0].path.exists()
    assert conversation.sessions.get("u3").state == IDLE


def test_freemium_gate_blocks_after_limit(conversation):
    # free_inquiries_per_month = 3 in the fixture.
    for _ in range(3):
        conversation.handle("u4", "What is VAT registration?")
    reply = conversation.handle("u4", "Another question?")
    assert "free inquiries" in _first_text(reply).lower()
    assert "upgrade" in _first_text(reply).lower()


def test_premium_bypasses_gate(conversation, store):
    store.set_premium("vip", True)
    for _ in range(5):
        reply = conversation.handle("vip", "How do I register a company?")
    assert "guidance" in _first_text(reply).lower()  # still answered, never blocked


def test_cancel_resets_flow(conversation):
    conversation.handle("u5", "checklist")
    assert conversation.sessions.get("u5").state != IDLE
    conversation.handle("u5", "cancel")
    assert conversation.sessions.get("u5").state == IDLE


def test_delete_my_data_is_free_and_erases(conversation, store):
    conversation.handle("u6", "What is GeSy?")
    assert store.get_usage("u6") == 1
    reply = conversation.handle("u6", "delete my data")
    assert "deleted" in _first_text(reply).lower()
    assert store.get_usage("u6") == 0


def test_menu_and_help_are_free(conversation, store):
    conversation.handle("u7", "menu")
    conversation.handle("u7", "help")
    assert store.get_usage("u7") == 0


def test_unsupported_empty_message(conversation):
    reply = conversation.handle("u8", "")
    assert "text messages" in _first_text(reply).lower()
