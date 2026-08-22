from app.i18n import DEFAULT_LANG, detect_lang, t


def test_detect_lang():
    assert detect_lang("Πώς παίρνω κίτρινη βεβαίωση;") == "el"
    assert detect_lang("How do I get a Yellow Slip?") == "en"
    assert detect_lang("12345") is None
    assert detect_lang("") is None


def test_translation_and_fallback():
    assert t("en", "menu_ask") == "❓ Ask a question"
    assert t("el", "menu_ask") == "❓ Ερώτηση"
    # Unknown language falls back to English.
    assert t("fr", "menu_ask") == t(DEFAULT_LANG, "menu_ask")
    # Unknown key returns the key itself (never raises).
    assert t("en", "does_not_exist") == "does_not_exist"


def test_placeholder_formatting():
    assert "2" in t("en", "quota_footer", n=2)
    assert "3" in t("el", "blocked", limit=3)
    # Missing placeholder must not raise.
    assert t("en", "quota_footer") == t("en", "quota_footer")
