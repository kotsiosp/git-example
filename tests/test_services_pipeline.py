"""ChecklistService and FormFillerService with the stub client."""
from app.services import ChecklistService, FormFillerService, QAService


def test_qa_service_grounded(kb, stub_client, settings):
    qa = QAService(kb, stub_client, settings)
    ans = qa.answer("How do I get a Yellow Slip?")
    assert ans.grounded is True
    assert ans.citations
    assert any("Yellow Slip" in c.title for c in ans.citations)


def test_checklist_service_generates_pdf(kb, stub_client, settings):
    svc = ChecklistService(kb, stub_client, settings)
    result = svc.generate("yellow_slip", {"citizenship": "EU/EEA/Swiss", "reason": "Employment",
                                          "address": "Yes"})
    assert result.generated is True
    assert result.items
    assert result.citations
    assert result.pdf_path and result.pdf_path.exists()


def test_checklist_unknown_topic(kb, stub_client, settings):
    svc = ChecklistService(kb, stub_client, settings)
    try:
        svc.generate("nope", {})
        assert False
    except KeyError:
        pass


def test_formfiller_extract_and_missing(stub_client, settings):
    svc = FormFillerService(stub_client, settings)
    values = svc.extract("meu1", "full_name=Maria Georgiou; nationality=Greek")
    assert values["full_name"] == "Maria Georgiou"
    missing = svc.missing_required("meu1", values)
    # required fields not yet provided should be reported by label
    assert "Passport or ID number" in missing
    assert "Date of birth" in missing


def test_formfiller_fill_complete(stub_client, settings):
    svc = FormFillerService(stub_client, settings)
    text = ("full_name=Maria Georgiou; date_of_birth=1990-05-14; nationality=Greek; "
            "passport_or_id_number=AB123; purpose_of_residence=Employment; "
            "address_in_cyprus=12 Makariou Ave Limassol")
    values = svc.extract("meu1", text)
    assert svc.missing_required("meu1", values) == []
    result = svc.fill("meu1", values)
    assert result.complete is True
    assert result.pdf_path and result.pdf_path.exists()
    assert result.official_ref == "Form MEU1"
