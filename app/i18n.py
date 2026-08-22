"""Bilingual (English / Greek) UI strings and language detection.

Cyprus users are a mix of expats (English) and locals (Greek), so the fixed UI text is
localised. Answer/checklist/form *content* is produced by Claude in the user's language;
this catalog covers the wrapper strings (menus, prompts, quota, disclaimer).

Usage:
    from .i18n import t, detect_lang
    t("en", "menu_ask")          # -> "Ask a question"
    t(lang, "quota_footer", n=2) # -> formatted string
"""
from __future__ import annotations

import re

# Greek + Greek Extended Unicode blocks.
_GREEK_RE = re.compile(r"[Ͱ-Ͽἀ-῿]")

LANGS = ("en", "el")
DEFAULT_LANG = "en"


def detect_lang(text: str) -> str | None:
    """Return 'el' if the text contains Greek letters, 'en' if it clearly has Latin
    letters, else None (undetermined — e.g. digits/emoji only)."""
    if not text:
        return None
    if _GREEK_RE.search(text):
        return "el"
    if re.search(r"[A-Za-z]", text):
        return "en"
    return None


# Each value is {"en": ..., "el": ...}. Use {name} placeholders for formatting.
STRINGS: dict[str, dict[str, str]] = {
    "disclaimer": {
        "en": "This is an AI assistant, not a legal or tax advisor, and is not affiliated "
              "with the Republic of Cyprus. Always confirm with official Gov.cy sources.",
        "el": "Αυτός είναι βοηθός AI, όχι νομικός ή φορολογικός σύμβουλος, και δεν συνδέεται "
              "με την Κυπριακή Δημοκρατία. Επιβεβαιώνετε πάντα με επίσημες πηγές στο Gov.cy.",
    },
    "welcome": {
        "en": "👋 Welcome to the *{app}*!\nI help you navigate Cyprus government "
              "procedures — residency, tax, health (GeSy), VAT and company setup.",
        "el": "👋 Καλώς ήρθατε στο *{app}*!\nΣας βοηθώ με τις διαδικασίες του κυπριακού "
              "δημοσίου — διαμονή, φόροι, υγεία (ΓεΣΥ), ΦΠΑ και σύσταση εταιρείας.",
    },
    "menu_body": {
        "en": "What would you like to do?",
        "el": "Τι θα θέλατε να κάνετε;",
    },
    "menu_hint": {
        "en": "You can also just type a question, or send *menu*, *upgrade*, "
              "*delete my data*, *cancel*.",
        "el": "Μπορείτε επίσης να γράψετε μια ερώτηση, ή *menu*, *upgrade*, "
              "*delete my data*, *cancel*.",
    },
    "menu_ask": {"en": "❓ Ask a question", "el": "❓ Ερώτηση"},
    "menu_checklist": {"en": "📋 Checklist", "el": "📋 Λίστα"},
    "menu_form": {"en": "📝 Fill a form", "el": "📝 Έντυπο"},
    "ask_prompt": {
        "en": "Sure — just type your question (English or Greek).",
        "el": "Βεβαίως — γράψτε την ερώτησή σας (Αγγλικά ή Ελληνικά).",
    },
    "cancelled": {
        "en": "Okay, cancelled. Send *menu* to see the options.",
        "el": "Εντάξει, ακυρώθηκε. Στείλτε *menu* για τις επιλογές.",
    },
    "upgrade_info": {
        "en": "⭐ *Premium* gives you unlimited questions and auto-filled PDF forms.\n"
              "Free plan: {limit} inquiries per month.\n\nReply here and our team will help "
              "you subscribe. (Billing is not wired up in this demo build.)",
        "el": "⭐ Το *Premium* προσφέρει απεριόριστες ερωτήσεις και αυτόματη συμπλήρωση "
              "εντύπων PDF.\nΔωρεάν πλάνο: {limit} αιτήματα τον μήνα.\n\nΑπαντήστε εδώ και η "
              "ομάδα μας θα σας βοηθήσει. (Η χρέωση δεν είναι ενεργή σε αυτή τη demo έκδοση.)",
    },
    "deleted": {
        "en": "🗑️ Done. I've deleted your usage data and cleared this conversation. "
              "We don't retain your message content.",
        "el": "🗑️ Έγινε. Διέγραψα τα δεδομένα χρήσης σας και καθάρισα τη συνομιλία. "
              "Δεν διατηρούμε το περιεχόμενο των μηνυμάτων σας.",
    },
    "nothing_to_delete": {
        "en": "There was no stored data to delete. We don't retain your message content.",
        "el": "Δεν υπήρχαν αποθηκευμένα δεδομένα προς διαγραφή. Δεν διατηρούμε το "
              "περιεχόμενο των μηνυμάτων σας.",
    },
    "blocked": {
        "en": "You've used your {limit} free inquiries this month. Reply *upgrade* for "
              "unlimited access, or come back next month. Menu and *delete my data* stay free.",
        "el": "Χρησιμοποιήσατε τα {limit} δωρεάν αιτήματα του μήνα. Απαντήστε *upgrade* για "
              "απεριόριστη πρόσβαση, ή δοκιμάστε τον επόμενο μήνα. Το menu και το "
              "*delete my data* παραμένουν δωρεάν.",
    },
    "quota_footer": {
        "en": "\n\n_({n} free inquiries left this month — reply *upgrade* for unlimited.)_",
        "el": "\n\n_(Απομένουν {n} δωρεάν αιτήματα αυτόν τον μήνα — *upgrade* για απεριόριστα.)_",
    },
    "sources_label": {"en": "Sources", "el": "Πηγές"},
    "help": {
        "en": "I can:\n• Answer questions — just type one\n• Build a *document checklist*\n"
              "• *Fill a form* (MEU1, TD1)\n\nSend *menu* for buttons, or *cancel* to stop.",
        "el": "Μπορώ να:\n• Απαντώ σε ερωτήσεις — απλώς γράψτε\n• Φτιάχνω *λίστα εγγράφων*\n"
              "• *Συμπληρώνω έντυπο* (MEU1, TD1)\n\nΣτείλτε *menu* για κουμπιά, ή *cancel*.",
    },
    "unsupported": {
        "en": "I can only read text messages right now. Type *menu* to see what I can do.",
        "el": "Προς το παρόν διαβάζω μόνο κείμενο. Γράψτε *menu* για να δείτε τι μπορώ να κάνω.",
    },
    # Checklist
    "checklist_which": {
        "en": "📋 *Document checklist* — which procedure?",
        "el": "📋 *Λίστα εγγράφων* — ποια διαδικασία;",
    },
    "checklist_pick_error": {
        "en": "I didn't catch that. Tap a topic below, or send *cancel*.",
        "el": "Δεν το κατάλαβα. Επιλέξτε ένα θέμα πιο κάτω, ή στείλτε *cancel*.",
    },
    "question_progress": {
        "en": "Question {i} of {total}",
        "el": "Ερώτηση {i} από {total}",
    },
    "question_hint": {
        "en": "Tap an option below, or type your own answer.",
        "el": "Επιλέξτε μια απάντηση πιο κάτω, ή γράψτε τη δική σας.",
    },
    "checklist_working": {
        "en": "One moment — preparing your personalised checklist… ⏳",
        "el": "Μια στιγμή — ετοιμάζω την εξατομικευμένη λίστα σας… ⏳",
    },
    "checklist_fail": {
        "en": "I couldn't build a reliable checklist from the official sources for that. "
              "Please try a question instead, or visit a Citizens Service Centre (ΚΕΠ).",
        "el": "Δεν μπόρεσα να φτιάξω αξιόπιστη λίστα από τις επίσημες πηγές. Δοκιμάστε μια "
              "ερώτηση, ή επισκεφθείτε ένα Κέντρο Εξυπηρέτησης του Πολίτη (ΚΕΠ).",
    },
    "checklist_caption": {
        "en": "Your {title} checklist",
        "el": "Η λίστα σας: {title}",
    },
    # Form
    "form_which": {
        "en": "📝 *Form filler* — which form?",
        "el": "📝 *Συμπλήρωση εντύπου* — ποιο έντυπο;",
    },
    "form_pick_error": {
        "en": "I didn't catch that. Tap a form below, or send *cancel*.",
        "el": "Δεν το κατάλαβα. Επιλέξτε ένα έντυπο πιο κάτω, ή στείλτε *cancel*.",
    },
    "form_details_prompt": {
        "en": "Great — *{ref}: {title}*.\nSend me your details in one message (plain "
              "language is fine). I need at least:\n\n{required}\n\nI'll pre-fill the form. "
              "Send *cancel* to stop.",
        "el": "Τέλεια — *{ref}: {title}*.\nΣτείλτε τα στοιχεία σας σε ένα μήνυμα (με απλά "
              "λόγια). Χρειάζομαι τουλάχιστον:\n\n{required}\n\nΘα προσυμπληρώσω το έντυπο. "
              "Στείλτε *cancel* για διακοπή.",
    },
    "form_still_required": {
        "en": "Got it. Captured so far: {got}.\nStill required:\n\n{missing}\n\n"
              "Send the remaining details, or *cancel*.",
        "el": "Ελήφθη. Μέχρι τώρα: {got}.\nΑπομένουν υποχρεωτικά:\n\n{missing}\n\n"
              "Στείλτε τα υπόλοιπα, ή *cancel*.",
    },
    "form_missing_on_generate": {
        "en": "I still need a few required fields first:\n\n{missing}\n\nSend them, or *cancel*.",
        "el": "Χρειάζομαι ακόμη μερικά υποχρεωτικά πεδία:\n\n{missing}\n\nΣτείλτε τα, ή *cancel*.",
    },
    "form_ready": {
        "en": "Great — I have all the required fields ({got}).\nTap *Generate PDF* below, "
              "or send any optional details first.",
        "el": "Τέλεια — έχω όλα τα υποχρεωτικά πεδία ({got}).\nΠατήστε *Δημιουργία PDF* πιο "
              "κάτω, ή στείλτε πρώτα προαιρετικά στοιχεία.",
    },
    "form_generate_btn": {"en": "✅ Generate PDF", "el": "✅ Δημιουργία PDF"},
    "form_done": {
        "en": "✅ Your *{ref}* is pre-filled and ready to print and sign.",
        "el": "✅ Το *{ref}* σας είναι προσυμπληρωμένο, έτοιμο για εκτύπωση και υπογραφή.",
    },
    "back_to_menu": {"en": "🏠 Menu", "el": "🏠 Μενού"},
}


def t(lang: str, key: str, **kwargs) -> str:
    """Translate ``key`` into ``lang`` (falling back to English), formatting placeholders."""
    lang = lang if lang in LANGS else DEFAULT_LANG
    entry = STRINGS.get(key, {})
    text = entry.get(lang) or entry.get(DEFAULT_LANG) or key
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError):
            return text
    return text
