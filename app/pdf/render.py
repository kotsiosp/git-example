"""Render checklists and filled forms to PDF with ReportLab.

Greek support: ReportLab's built-in Helvetica lacks Greek glyphs, so we try to register a
Unicode TrueType font (DejaVuSans, which ships on most Linux images). If none is found we
fall back to Helvetica — Latin text still renders fine; register a font for Greek output.
"""
from __future__ import annotations

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    ListFlowable,
    ListItem,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_FONT_CANDIDATES = [
    ("DejaVuSans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    ("DejaVuSans", "/usr/share/fonts/dejavu/DejaVuSans.ttf"),
    ("DejaVuSans", "/Library/Fonts/Arial Unicode.ttf"),
]
_BOLD_CANDIDATES = [
    ("DejaVuSans-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("DejaVuSans-Bold", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"),
]

_BASE_FONT = "Helvetica"
_BOLD_FONT = "Helvetica-Bold"


def _register_fonts() -> None:
    global _BASE_FONT, _BOLD_FONT
    for name, path in _FONT_CANDIDATES:
        if Path(path).exists():
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                _BASE_FONT = name
                break
            except Exception:  # pragma: no cover - font parse issues
                continue
    for name, path in _BOLD_CANDIDATES:
        if Path(path).exists():
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                _BOLD_FONT = name
                break
            except Exception:  # pragma: no cover
                continue


_register_fonts()


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("t", parent=base["Title"], fontName=_BOLD_FONT, fontSize=18,
                                spaceAfter=4),
        "subtitle": ParagraphStyle("s", parent=base["Normal"], fontName=_BASE_FONT, fontSize=10,
                                   textColor=colors.HexColor("#555555"), spaceAfter=10),
        "h2": ParagraphStyle("h2", parent=base["Heading2"], fontName=_BOLD_FONT, fontSize=12,
                             spaceBefore=10, spaceAfter=4),
        "body": ParagraphStyle("b", parent=base["Normal"], fontName=_BASE_FONT, fontSize=10.5,
                               leading=15, alignment=TA_LEFT),
        "item": ParagraphStyle("i", parent=base["Normal"], fontName=_BASE_FONT, fontSize=10.5,
                               leading=15),
        "small": ParagraphStyle("sm", parent=base["Normal"], fontName=_BASE_FONT, fontSize=8,
                                textColor=colors.HexColor("#777777"), leading=11),
    }


def _footer(disclaimer: str, styles) -> list:
    return [
        Spacer(1, 8 * mm),
        HRFlowable(width="100%", color=colors.HexColor("#dddddd")),
        Spacer(1, 2 * mm),
        Paragraph(disclaimer, styles["small"]),
    ]


def render_checklist_pdf(
    path: Path | str,
    *,
    title: str,
    subtitle: str,
    intro: str,
    items: list[str],
    sources: list[tuple[str, str]],
    disclaimer: str,
) -> Path:
    """Write a personalized document checklist PDF and return its path."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    styles = _styles()
    doc = SimpleDocTemplate(
        str(path), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=16 * mm,
        title=title,
    )
    story: list = [Paragraph(title, styles["title"]), Paragraph(subtitle, styles["subtitle"])]
    if intro:
        story.append(Paragraph(intro, styles["body"]))
    story.append(Paragraph("Your checklist", styles["h2"]))

    list_items = [
        ListItem(Paragraph(item, styles["item"]), value="☐", leftIndent=6)
        for item in items
    ]
    story.append(ListFlowable(list_items, bulletType="bullet", start="☐", leftIndent=10))

    if sources:
        story.append(Paragraph("Official sources", styles["h2"]))
        src_items = [
            ListItem(Paragraph(f"{t} — {u}" if u else t, styles["item"]))
            for t, u in sources
        ]
        story.append(ListFlowable(src_items, bulletType="bullet", leftIndent=10))

    story.extend(_footer(disclaimer, styles))
    doc.build(story)
    return path


def render_form_pdf(
    path: Path | str,
    *,
    form_title: str,
    official_ref: str,
    source_url: str,
    fields: list[tuple[str, str]],
    missing: list[str],
    note: str,
    disclaimer: str,
) -> Path:
    """Write a printable, pre-filled form PDF and return its path.

    ``fields`` are (label, value) pairs. ``missing`` are labels of required fields left
    blank (rendered as an action list so the user knows what to complete by hand).
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    styles = _styles()
    doc = SimpleDocTemplate(
        str(path), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=16 * mm,
        title=f"{official_ref} — {form_title}",
    )
    story: list = [
        Paragraph(f"{official_ref}: {form_title}", styles["title"]),
        Paragraph(f"{note}  Source: {source_url}", styles["subtitle"]),
    ]

    table_data = [[Paragraph("<b>Field</b>", styles["item"]), Paragraph("<b>Value</b>", styles["item"])]]
    for label, value in fields:
        shown = value if value else "__________________________"
        table_data.append([Paragraph(label, styles["item"]), Paragraph(shown, styles["item"])])

    table = Table(table_data, colWidths=[70 * mm, 90 * mm])
    table.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (-1, -1), _BASE_FONT),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f0f0f0")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cccccc")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    story.append(table)

    if missing:
        story.append(Paragraph("Still required (complete before submitting)", styles["h2"]))
        story.append(
            ListFlowable(
                [ListItem(Paragraph(m, styles["item"])) for m in missing],
                bulletType="bullet", leftIndent=10,
            )
        )

    story.append(Spacer(1, 10 * mm))
    story.append(Paragraph("Signature: ____________________________     Date: ______________",
                           styles["body"]))
    story.extend(_footer(disclaimer, styles))
    doc.build(story)
    return path
