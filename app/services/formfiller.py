"""Form Filler (Phase 3.3, premium).

The user describes their details in plain language; Claude extracts the values for a known
official form; we render a printable, pre-filled PDF and report any required fields still
missing so the user knows exactly what to complete by hand before signing.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Settings
from ..disclaimer import DISCLAIMER
from ..forms import FormDefinition, get_form
from ..llm import ClaudeClient
from ..pdf import render_form_pdf


@dataclass
class FormResult:
    form_key: str
    form_title: str
    official_ref: str
    values: dict[str, str]
    missing_required: list[str]  # human labels
    pdf_path: Path | None = None
    extras: dict = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        return not self.missing_required


class FormFillerService:
    def __init__(self, client: ClaudeClient, settings: Settings):
        self.client = client
        self.settings = settings

    @staticmethod
    def form(form_key: str) -> FormDefinition | None:
        return get_form(form_key)

    def extract(self, form_key: str, user_text: str, known: dict | None = None) -> dict[str, str]:
        """Extract field values from free text, merged onto any already-known values."""
        form = get_form(form_key)
        if form is None:
            raise KeyError(f"Unknown form: {form_key}")
        field_defs = [{"key": f.key, "label": f.label} for f in form.fields]
        extracted = self.client.extract_fields(form.title, field_defs, user_text)
        merged = dict(known or {})
        merged.update(extracted)
        return merged

    def missing_required(self, form_key: str, values: dict) -> list[str]:
        form = get_form(form_key)
        if form is None:
            raise KeyError(f"Unknown form: {form_key}")
        return [f.label for f in form.required_fields if not values.get(f.key)]

    def fill(self, form_key: str, values: dict, write_pdf: bool = True,
             disclaimer: str | None = None) -> FormResult:
        form = get_form(form_key)
        if form is None:
            raise KeyError(f"Unknown form: {form_key}")

        missing = self.missing_required(form_key, values)
        result = FormResult(
            form_key=form.key,
            form_title=form.title,
            official_ref=form.official_ref,
            values={k: v for k, v in values.items() if k in {f.key for f in form.fields}},
            missing_required=missing,
        )

        if write_pdf:
            ordered = [(f.label, values.get(f.key, "")) for f in form.fields]
            out = Path(self.settings.pdf_output_dir) / f"{form.key}_{uuid.uuid4().hex[:8]}.pdf"
            render_form_pdf(
                out,
                form_title=form.title,
                official_ref=form.official_ref,
                source_url=form.source_url,
                fields=ordered,
                missing=missing,
                note=form.note,
                disclaimer=disclaimer or DISCLAIMER,
            )
            result.pdf_path = out

        return result
