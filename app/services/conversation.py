"""Conversation router / state machine for the WhatsApp channel.

Turns each inbound message into a ``Reply`` (a list of outbound text/document actions).
It is deliberately free of network and HTTP concerns so it can be unit-tested offline:
the webhook layer is responsible for actually sending the resulting outbound actions.

Flows:
- Default: any free text is answered by the Q&A bot (metered).
- ``checklist`` -> pick a topic -> answer 3 questions -> receive a PDF checklist (metered).
- ``form``      -> pick a form -> describe details in plain text -> receive a filled PDF (metered).
- ``menu``/``help``, ``cancel``, ``upgrade``, and ``delete my data`` are free.

Per-user session state is transient and in-memory (collected form values are PII); it is
cleared on completion, on ``cancel``, and on GDPR erasure. For multi-instance
deployments, back ``SessionStore`` with Redis.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from ..disclaimer import DISCLAIMER
from ..forms import CHECKLIST_TOPICS, FORMS
from ..storage import Store
from .checklist import ChecklistService
from .formfiller import FormFillerService
from .qa import QAService
from .usage import UsageService

# Session states
IDLE = "idle"
CHECKLIST_SELECT = "checklist_select"
CHECKLIST_Q = "checklist_q"
FORM_SELECT = "form_select"
FORM_COLLECT = "form_collect"

_GREETINGS = {"hi", "hello", "hey", "start", "menu", "help", "γεια", "γειά", "μενου", "μενού"}
_CANCEL = {"cancel", "stop", "exit", "reset", "ακυρο", "άκυρο"}
_DELETE = {"delete", "delete my data", "erase", "forget me", "διαγραφη", "διαγραφή"}


@dataclass
class Outbound:
    kind: str  # "text" | "document"
    text: str = ""
    path: Path | None = None
    filename: str = ""
    caption: str = ""

    @classmethod
    def message(cls, text: str) -> "Outbound":
        return cls(kind="text", text=text)

    @classmethod
    def document(cls, path: Path, filename: str, caption: str = "") -> "Outbound":
        return cls(kind="document", path=path, filename=filename, caption=caption)


@dataclass
class Reply:
    outbound: list[Outbound] = field(default_factory=list)

    def texts(self) -> list[str]:
        return [o.text for o in self.outbound if o.kind == "text"]


@dataclass
class Session:
    state: str = IDLE
    topic_key: str = ""
    form_key: str = ""
    q_index: int = 0
    answers: dict = field(default_factory=dict)
    values: dict = field(default_factory=dict)

    def reset(self) -> None:
        self.state = IDLE
        self.topic_key = ""
        self.form_key = ""
        self.q_index = 0
        self.answers = {}
        self.values = {}


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}

    def get(self, user_id: str) -> Session:
        return self._sessions.setdefault(user_id, Session())

    def clear(self, user_id: str) -> None:
        self._sessions.pop(user_id, None)


class ConversationService:
    def __init__(
        self,
        qa: QAService,
        checklist: ChecklistService,
        formfiller: FormFillerService,
        usage: UsageService,
        store: Store,
        settings: Settings,
        sessions: SessionStore | None = None,
    ):
        self.qa = qa
        self.checklist = checklist
        self.formfiller = formfiller
        self.usage = usage
        self.store = store
        self.settings = settings
        self.sessions = sessions or SessionStore()

    # ------------------------------------------------------------------ #
    # entry point
    # ------------------------------------------------------------------ #
    def handle(self, user_id: str, text: str) -> Reply:
        text = (text or "").strip()
        low = text.lower()
        session = self.sessions.get(user_id)

        # Empty / unsupported message type.
        if not text:
            return Reply([Outbound.message(
                "I can only read text messages right now. Type 'menu' to see what I can do."
            )])

        # Global free commands (work in any state).
        if low in _GREETINGS:
            session.reset()
            return self._menu()
        if low in _CANCEL:
            session.reset()
            return Reply([Outbound.message("Okay, cancelled. Type 'menu' to see the options.")])
        if low in _DELETE:
            return self._delete_data(user_id, session)
        if low == "upgrade":
            return self._upgrade_info()

        # In-flow handling.
        if session.state == CHECKLIST_SELECT:
            return self._checklist_pick(session, text)
        if session.state == CHECKLIST_Q:
            return self._checklist_answer(user_id, session, text)
        if session.state == FORM_SELECT:
            return self._form_pick(session, text)
        if session.state == FORM_COLLECT:
            return self._form_collect(user_id, session, text)

        # Entry commands.
        if low in {"checklist", "2", "list", "documents"}:
            return self._start_checklist(session)
        if low in {"form", "forms", "3", "fill"}:
            return self._start_form(session)
        if low in {"ask", "1", "question"}:
            return Reply([Outbound.message("Sure — just type your question (in English or Greek).")])

        # Default: Q&A.
        return self._answer(user_id, text)

    # ------------------------------------------------------------------ #
    # menus & info
    # ------------------------------------------------------------------ #
    def _menu(self) -> Reply:
        body = (
            f"👋 Welcome to the {self.settings.app_name}.\n"
            "I help with Cyprus government procedures. What would you like to do?\n\n"
            "1️⃣ *Ask a question* — just type it (e.g. \"How do I get a Yellow Slip?\")\n"
            "2️⃣ *Get a document checklist* — reply *checklist*\n"
            "3️⃣ *Fill an official form* — reply *form*\n\n"
            "Other commands: *upgrade*, *delete my data*, *cancel*.\n\n"
            f"_{DISCLAIMER}_"
        )
        return Reply([Outbound.message(body)])

    def _upgrade_info(self) -> Reply:
        return Reply([Outbound.message(
            "⭐ *Premium* gives you unlimited questions and auto-filled PDF forms.\n"
            f"Free plan: {self.settings.free_inquiries_per_month} inquiries per month.\n\n"
            "To subscribe, visit our website or reply to this chat and our team will help. "
            "(Billing is not wired up in this demo build.)"
        )])

    def _delete_data(self, user_id: str, session: Session) -> Reply:
        removed = self.store.erase(user_id)
        session.reset()
        self.sessions.clear(user_id)
        msg = (
            "🗑️ Done. I've deleted your usage data and cleared this conversation's state. "
            "We do not retain your message content."
            if removed
            else "There was no stored data to delete. We do not retain your message content."
        )
        return Reply([Outbound.message(msg)])

    # ------------------------------------------------------------------ #
    # freemium gate
    # ------------------------------------------------------------------ #
    def _blocked_reply(self) -> Reply:
        return Reply([Outbound.message(
            f"You've used your {self.settings.free_inquiries_per_month} free inquiries this "
            "month. Reply *upgrade* for unlimited access, or come back next month. "
            "Menu and 'delete my data' remain free."
        )])

    def _quota_footer(self, user_id: str) -> str:
        q = self.usage.check(user_id)
        if q.premium:
            return ""
        return f"\n\n_({q.remaining} free inquiries left this month — reply *upgrade* for unlimited.)_"

    # ------------------------------------------------------------------ #
    # Q&A
    # ------------------------------------------------------------------ #
    def _answer(self, user_id: str, question: str) -> Reply:
        if not self.usage.check(user_id).allowed:
            return self._blocked_reply()
        self.usage.consume(user_id)
        result = self.qa.answer(question)
        body = result.text
        if result.citations:
            srcs = "\n".join(f"[{c.n}] {c.title} — {c.url}" for c in result.citations)
            body += f"\n\n*Sources:*\n{srcs}"
        body += f"\n\n_{DISCLAIMER}_"
        body += self._quota_footer(user_id)
        return Reply([Outbound.message(body)])

    # ------------------------------------------------------------------ #
    # Checklist flow
    # ------------------------------------------------------------------ #
    def _start_checklist(self, session: Session) -> Reply:
        session.reset()
        session.state = CHECKLIST_SELECT
        lines = [f"{i}. {t.title}" for i, t in enumerate(CHECKLIST_TOPICS.values(), 1)]
        return Reply([Outbound.message(
            "📋 *Document checklist* — which procedure?\n\n" + "\n".join(lines) +
            "\n\nReply with a number, or 'cancel'."
        )])

    def _checklist_pick(self, session: Session, text: str) -> Reply:
        topics = list(CHECKLIST_TOPICS.values())
        topic = _pick(text, topics, key=lambda t: t.title, alt=lambda t: t.key)
        if topic is None:
            return Reply([Outbound.message("I didn't catch that. Reply with the number of a topic, or 'cancel'.")])
        session.topic_key = topic.key
        session.state = CHECKLIST_Q
        session.q_index = 0
        session.answers = {}
        return Reply([Outbound.message(self._format_question(topic.questions[0]))])

    def _checklist_answer(self, user_id: str, session: Session, text: str) -> Reply:
        topic = CHECKLIST_TOPICS[session.topic_key]
        question = topic.questions[session.q_index]
        session.answers[question.key] = _resolve_choice(text, question.options)
        session.q_index += 1

        if session.q_index < len(topic.questions):
            return Reply([Outbound.message(self._format_question(topic.questions[session.q_index]))])

        # All questions answered -> generate (metered).
        if not self.usage.check(user_id).allowed:
            session.reset()
            return self._blocked_reply()
        self.usage.consume(user_id)
        result = self.checklist.generate(topic.key, session.answers, write_pdf=True)
        answers = dict(session.answers)
        session.reset()

        if not result.items:
            return Reply([Outbound.message(
                "I couldn't build a reliable checklist from the official sources for that. "
                "Please try the Q&A instead, or visit a Citizens Service Centre (ΚΕΠ)."
            )])

        summary = (result.intro + "\n\n" if result.intro else "") + "\n".join(
            f"☐ {item}" for item in result.items
        )
        summary += f"\n\n_{DISCLAIMER}_" + self._quota_footer(user_id)
        out = [Outbound.message(summary)]
        if result.pdf_path:
            out.append(Outbound.document(
                result.pdf_path, filename=f"checklist-{topic.key}.pdf",
                caption=f"Your {topic.title} checklist",
            ))
        return Reply(out)

    def _format_question(self, question) -> str:
        if question.options:
            opts = "\n".join(f"  {i}. {o}" for i, o in enumerate(question.options, 1))
            return f"{question.text}\n{opts}\n\n(Reply with a number or your own answer.)"
        return question.text

    # ------------------------------------------------------------------ #
    # Form flow
    # ------------------------------------------------------------------ #
    def _start_form(self, session: Session) -> Reply:
        session.reset()
        session.state = FORM_SELECT
        lines = [f"{i}. {f.official_ref} — {f.title}" for i, f in enumerate(FORMS.values(), 1)]
        return Reply([Outbound.message(
            "📝 *Form filler* — which form?\n\n" + "\n".join(lines) +
            "\n\nReply with a number, or 'cancel'."
        )])

    def _form_pick(self, session: Session, text: str) -> Reply:
        forms = list(FORMS.values())
        form = _pick(text, forms, key=lambda f: f.title, alt=lambda f: f.key,
                     extra=lambda f: f.official_ref)
        if form is None:
            return Reply([Outbound.message("I didn't catch that. Reply with the number of a form, or 'cancel'.")])
        session.form_key = form.key
        session.state = FORM_COLLECT
        session.values = {}
        req = "\n".join(f"• {f.label} (e.g. {f.example})" for f in form.required_fields)
        return Reply([Outbound.message(
            f"Great — *{form.official_ref}: {form.title}*.\n"
            "Send me your details in one message (plain language is fine). I need at least:\n\n"
            f"{req}\n\nWhen you're ready, I'll pre-fill the form. Reply 'cancel' to stop."
        )])

    def _form_collect(self, user_id: str, session: Session, text: str) -> Reply:
        form_key = session.form_key
        low = text.lower()

        # Extract details from the message and merge.
        if low not in {"done", "fill", "generate", "ready", "ok", "go"}:
            session.values = self.formfiller.extract(form_key, text, session.values)

        missing = self.formfiller.missing_required(form_key, session.values)
        captured = list(session.values)
        wants_generate = low in {"done", "fill", "generate", "ready", "ok", "go"}

        # Explicit request to generate.
        if wants_generate:
            if missing:
                miss = "\n".join(f"• {m}" for m in missing)
                return Reply([Outbound.message(
                    "I still need a few required fields before I can fill the form:\n\n"
                    f"{miss}\n\nSend them in a message, or reply 'cancel'."
                )])
            if not self.usage.check(user_id).allowed:
                session.reset()
                return self._blocked_reply()
            self.usage.consume(user_id)
            result = self.formfiller.fill(form_key, session.values, write_pdf=True)
            session.reset()
            out = [Outbound.message(
                f"✅ Your *{result.official_ref}* is pre-filled and ready to print and sign."
                f"\n\n_{DISCLAIMER}_" + self._quota_footer(user_id)
            )]
            if result.pdf_path:
                out.append(Outbound.document(
                    result.pdf_path, filename=f"{result.form_key}.pdf",
                    caption=f"{result.official_ref}: {result.form_title}",
                ))
            return Reply(out)

        # Still collecting after extracting the latest details.
        got = ", ".join(captured) if captured else "nothing yet"
        if missing:
            miss = "\n".join(f"• {m}" for m in missing)
            return Reply([Outbound.message(
                f"Got it. Captured so far: {got}.\nStill required:\n\n{miss}\n\n"
                "Send the remaining details, or reply 'cancel'."
            )])
        return Reply([Outbound.message(
            f"Great — I have all the required fields ({got}).\n"
            "Reply *done* to generate your pre-filled PDF, or send any optional details first."
        )])


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _pick(text, items, key, alt=None, extra=None):
    """Resolve a user's selection to an item by 1-based number or fuzzy name/key match."""
    text = text.strip()
    if text.isdigit():
        idx = int(text) - 1
        if 0 <= idx < len(items):
            return items[idx]
        return None
    low = text.lower()
    for it in items:
        candidates = [key(it).lower()]
        if alt:
            candidates.append(alt(it).lower())
        if extra:
            candidates.append(extra(it).lower())
        if any(low == c or low in c or c in low for c in candidates):
            return it
    return None


def _resolve_choice(text: str, options: list[str]) -> str:
    """Map a numeric or textual reply to one of ``options``; otherwise return the raw text."""
    text = text.strip()
    if options and text.isdigit():
        idx = int(text) - 1
        if 0 <= idx < len(options):
            return options[idx]
    for o in options:
        if text.lower() == o.lower():
            return o
    return text
