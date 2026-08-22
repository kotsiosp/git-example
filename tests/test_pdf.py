from app.pdf import render_checklist_pdf, render_form_pdf


def _is_pdf(path) -> bool:
    with open(path, "rb") as fh:
        return fh.read(5) == b"%PDF-"


def test_render_checklist_pdf(tmp_path):
    out = tmp_path / "checklist.pdf"
    p = render_checklist_pdf(
        out,
        title="Yellow Slip",
        subtitle="Personalised checklist",
        intro="Here is what you need.",
        items=["Bring your passport", "Complete form MEU1", "Pay the fee (verify)"],
        sources=[("CRMD", "https://www.moi.gov.cy/crmd")],
        disclaimer="Not legal advice.",
    )
    assert p == out
    assert out.exists() and _is_pdf(out)
    assert out.stat().st_size > 800


def test_render_form_pdf_with_missing(tmp_path):
    out = tmp_path / "form.pdf"
    render_form_pdf(
        out,
        form_title="EU Citizen Registration Certificate",
        official_ref="Form MEU1",
        source_url="https://www.moi.gov.cy/crmd",
        fields=[("Full name", "Maria Georgiou"), ("Passport", "")],
        missing=["Passport or ID number"],
        note="For EU citizens.",
        disclaimer="Not legal advice.",
    )
    assert out.exists() and _is_pdf(out)


def test_render_greek_text(tmp_path):
    # Should not raise even if only Helvetica is available (Latin fallback).
    out = tmp_path / "greek.pdf"
    render_checklist_pdf(
        out, title="Κίτρινη Βεβαίωση", subtitle="Λίστα", intro="Οδηγίες",
        items=["Φέρτε το διαβατήριό σας"], sources=[], disclaimer="Δεν αποτελεί νομική συμβουλή.",
    )
    assert out.exists() and _is_pdf(out)
