"""Conversation router / state machine, shared by the WhatsApp and web channels.

Turns each inbound message into a ``Reply`` (a list of outbound actions: text,
tappable interactive prompts, or documents). It is free of network/HTTP concerns so it
can be unit-tested offline; each channel renders the outbound actions its own way.

Flows:
- Default: any free text is answered by the Q&A bot (metered).
- ``checklist`` -> pick a topic -> answer 3 questions -> receive a PDF checklist (metered).
- ``form``      -> pick a form -> describe details in plain text -> receive a filled PDF (metered).
- ``menu``/``help``, ``cancel``, ``upgrade``, and ``delete my data`` are free.

The UI is bilingual (English/Greek): the language is auto-detected from the user's text
and remembered for the session. Selections use stable ids ("checklist", "1", "done",
"menu") so both tappable buttons and typed replies resolve through the same logic.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from ..forms import CHECKLIST_TOPICS, FORMS
from ..i18n import DEFAULT_LANG, detect_lang, t
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

_GREETINGS = {"hi", "hello", "hey", "start", "menu", "γεια", "γειά", "μενου", "μενού"}
_HELP = {"help", "?", "βοηθεια", "βοήθεια"}
_CANCEL = {"cancel", "stop", "exit", "reset", "ακυρο", "άκυρο", "ακύρωση"}
_DELETE = {"delete", "delete my data", "erase", "forget me", "διαγραφη", "διαγραφή"}
_GENERATE = {"done", "fill", "generate", "ready", "ok", "go", "τελος", "τέλος", "ενταξει", "εντάξει"}


@dataclass
class Outbound:
    kind: str  # "text" | "interactive" | "document"
    text: str = ""
    options: list[tuple[str, str]] = field(default_factory=list)  # (id, title) for interactive
    path: Path | None = None
    filename: str = ""
    caption: str = ""

    @classmethod
    def message(cls, text: str) -> "Outbound":
        return cls(kind="text", text=text)

    @classmethod
    def buttons(cls, text: str, options: list[tuple[str, str]]) -> "Outbound":
        return cls(kind="interactive", text=text, options=options)

    @classmethod
    def document(cls, path: Path, filename: str, caption: str = "") -> "Outbound":
        return cls(kind="document", path=path, filename=filename, caption=caption)


@dataclass
class Reply:
    outbound: list[Outbound] = field(default_factory=list)

    def texts(self) -> list[str]:
        return [o.text for o in self.outbound if o.kind in ("text", "interactive")]


@dataclass
class Session:
    state: str = IDLE
    lang: str = DEFAULT_LANG
    onboarded: bool = False
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
        session = self.sessions.get(user_id)

        # Auto-detect and remember language from natural-language text.
        detected = detect_lang(text)
        if detected:
            session.lang = detected
        lang = session.lang
        low = text.lower()

        if not text:
            return Reply([Outbound.message(t(lang, "unsupported"))])

        # Global free commands (work in any state).
        if low in _GREETINGS:
            return self._menu(session)
        if low in _HELP:
            return Reply([Outbound.message(t(lang, "help"))])
        if low in _CANCEL:
            session.reset()
            return Reply([Outbound.message(t(lang, "cancelled"))])
        if low in _DELETE:
            return self._delete_data(user_id, session)
        if low == "upgrade":
            session.onboarded = True
            return Reply([Outbound.message(t(lang, "upgrade_info", limit=self.settings.free_inquiries_per_month))])

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
        if low in {"checklist", "list", "documents"}:
            return self._start_checklist(session)
        if low in {"form", "forms"}:
            return self._start_form(session)
        if low in {"ask", "question"}:
            session.onboarded = True
            return Reply([Outbound.message(t(lang, "ask_prompt"))])

        # Default: Q&A.
        return self._answer(user_id, session, text)

    # ------------------------------------------------------------------ #
    # menus & info
    # ------------------------------------------------------------------ #
    def _menu(self, session: Session) -> Reply:
        lang = session.lang
        session.reset()
        if not session.onboarded:
            body = t(lang, "welcome", app=self.settings.app_name) + "\n\n" + t(lang, "menu_body")
            session.onboarded = True
        else:
            body = t(lang, "menu_body")
        body += "\n\n_" + t(lang, "disclaimer") + "_"
        options = [
            ("ask", t(lang, "menu_ask")),
            ("checklist", t(lang, "menu_checklist")),
            ("form", t(lang, "menu_form")),
        ]
        return Reply([Outbound.buttons(body, options)])

    def _delete_data(self, user_id: str, session: Session) -> Reply:
        removed = self.store.erase(user_id)
        lang = session.lang
        session.reset()
        self.sessions.clear(user_id)
        return Reply([Outbound.message(t(lang, "deleted" if removed else "nothing_to_delete"))])

    # ------------------------------------------------------------------ #
    # freemium gate
    # ------------------------------------------------------------------ #
    def _blocked_reply(self, lang: str) -> Reply:
        return Reply([Outbound.message(t(lang, "blocked", limit=self.settings.free_inquiries_per_month))])

    def _quota_footer(self, user_id: str, lang: str) -> str:
        q = self.usage.check(user_id)
        if q.premium:
            return ""
        return t(lang, "quota_footer", n=q.remaining)

    def _menu_button(self, lang: str) -> Outbound:
        return Outbound.buttons("", [("menu", t(lang, "back_to_menu"))])

    # ------------------------------------------------------------------ #
    # Q&A
    # ------------------------------------------------------------------ #
    def _answer(self, user_id: str, session: Session, question: str) -> Reply:
        lang = session.lang
        session.onboarded = True
        if not self.usage.check(user_id).allowed:
            return self._blocked_reply(lang)
        self.usage.consume(user_id)
        result = self.qa.answer(question)
        body = result.text
        if result.citations:
            srcs = "\n".join(f"[{c.n}] {c.title} — {c.url}" for c in result.citations)
            body += f"\n\n*{t(lang, 'sources_label')}:*\n{srcs}"
        body += f"\n\n_{t(lang, 'disclaimer')}_"
        body += self._quota_footer(user_id, lang)
        return Reply([Outbound.message(body)])

    # ------------------------------------------------------------------ #
    # Checklist flow
    # ------------------------------------------------------------------ #
    def _start_checklist(self, session: Session) -> Reply:
        lang = session.lang
        session.reset()
        session.onboarded = True
        session.state = CHECKLIST_SELECT
        options = [(str(i), tp.title) for i, tp in enumerate(CHECKLIST_TOPICS.values(), 1)]
        return Reply([Outbound.buttons(t(lang, "checklist_which"), options)])

    def _checklist_pick(self, session: Session, text: str) -> Reply:
        lang = session.lang
        topics = list(CHECKLIST_TOPICS.values())
        topic = _pick(text, topics, key=lambda tp: tp.title, alt=lambda tp: tp.key)
        if topic is None:
            options = [(str(i), tp.title) for i, tp in enumerate(topics, 1)]
            return Reply([Outbound.buttons(t(lang, "checklist_pick_error"), options)])
        session.topic_key = topic.key
        session.state = CHECKLIST_Q
        session.q_index = 0
        session.answers = {}
        return Reply([self._question_outbound(lang, topic, 0)])

    def _checklist_answer(self, user_id: str, session: Session, text: str) -> Reply:
        lang = session.lang
        topic = CHECKLIST_TOPICS[session.topic_key]
        question = topic.questions[session.q_index]
        session.answers[question.key] = _resolve_choice(text, question.options)
        session.q_index += 1

        if session.q_index < len(topic.questions):
            return Reply([self._question_outbound(lang, topic, session.q_index)])

        # All questions answered -> generate (metered).
        if not self.usage.check(user_id).allowed:
            session.reset()
            return self._blocked_reply(lang)
        self.usage.consume(user_id)
        result = self.checklist.generate(
            topic.key, session.answers, write_pdf=True, disclaimer=t(lang, "disclaimer"),
        )
        session.reset()

        if not result.items:
            return Reply([Outbound.message(t(lang, "checklist_fail"))])

        summary = (result.intro + "\n\n" if result.intro else "") + "\n".join(
            f"☐ {item}" for item in result.items
        )
        summary += f"\n\n_{t(lang, 'disclaimer')}_" + self._quota_footer(user_id, lang)
        out = [Outbound.message(summary)]
        if result.pdf_path:
            out.append(Outbound.document(
                result.pdf_path, filename=f"checklist-{topic.key}.pdf",
                caption=t(lang, "checklist_caption", title=topic.title),
            ))
        out.append(self._menu_button(lang))
        return Reply(out)

    def _question_outbound(self, lang: str, topic, index: int) -> Outbound:
        question = topic.questions[index]
        progress = t(lang, "question_progress", i=index + 1, total=len(topic.questions))
        body = f"*{progress}*\n{question.text}"
        if question.options:
            body += "\n\n_" + t(lang, "question_hint") + "_"
            options = [(str(i), o) for i, o in enumerate(question.options, 1)]
            return Outbound.buttons(body, options)
        return Outbound.message(body)

    # ------------------------------------------------------------------ #
    # Form flow
    # ------------------------------------------------------------------ #
    def _start_form(self, session: Session) -> Reply:
        lang = session.lang
        session.reset()
        session.onboarded = True
        session.state = FORM_SELECT
        options = [(str(i), f"{f.official_ref} — {f.title}") for i, f in enumerate(FORMS.values(), 1)]
        return Reply([Outbound.buttons(t(lang, "form_which"), options)])

    def _form_pick(self, session: Session, text: str) -> Reply:
        lang = session.lang
        forms = list(FORMS.values())
        form = _pick(text, forms, key=lambda f: f.title, alt=lambda f: f.key,
                     extra=lambda f: f.official_ref)
        if form is None:
            options = [(str(i), f"{f.official_ref} — {f.title}") for i, f in enumerate(forms, 1)]
            return Reply([Outbound.buttons(t(lang, "form_pick_error"), options)])
        session.form_key = form.key
        session.state = FORM_COLLECT
        session.values = {}
        req = "\n".join(f"• {f.label} (e.g. {f.example})" for f in form.required_fields)
        return Reply([Outbound.message(t(
            lang, "form_details_prompt", ref=form.official_ref, title=form.title, required=req,
        ))])

    def _form_collect(self, user_id: str, session: Session, text: str) -> Reply:
        lang = session.lang
        form_key = session.form_key
        low = text.lower()
        wants_generate = low in _GENERATE

        if not wants_generate:
            session.values = self.formfiller.extract(form_key, text, session.values)

        missing = self.formfiller.missing_required(form_key, session.values)
        captured = list(session.values)

        if wants_generate:
            if missing:
                miss = "\n".join(f"• {m}" for m in missing)
                return Reply([Outbound.message(t(lang, "form_missing_on_generate", missing=miss))])
            if not self.usage.check(user_id).allowed:
                session.reset()
                return self._blocked_reply(lang)
            self.usage.consume(user_id)
            result = self.formfiller.fill(
                form_key, session.values, write_pdf=True, disclaimer=t(lang, "disclaimer"),
            )
            session.reset()
            out = [Outbound.message(
                t(lang, "form_done", ref=result.official_ref)
                + f"\n\n_{t(lang, 'disclaimer')}_" + self._quota_footer(user_id, lang)
            )]
            if result.pdf_path:
                out.append(Outbound.document(
                    result.pdf_path, filename=f"{result.form_key}.pdf",
                    caption=f"{result.official_ref}: {result.form_title}",
                ))
            out.append(self._menu_button(lang))
            return Reply(out)

        got = ", ".join(captured) if captured else "—"
        if missing:
            miss = "\n".join(f"• {m}" for m in missing)
            return Reply([Outbound.message(t(lang, "form_still_required", got=got, missing=miss))])
        # All required present — offer a Generate button.
        return Reply([Outbound.buttons(
            t(lang, "form_ready", got=got), [("done", t(lang, "form_generate_btn"))],
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
