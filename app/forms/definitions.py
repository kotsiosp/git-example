"""Static definitions for checklist topics and fillable forms.

⚠️ These field lists and topics are illustrative. Before production, verify each form's
exact official field set and reference number against the responsible department, and
(ideally) replace the generated PDFs with overlays onto the real official templates.
"""
from __future__ import annotations

from dataclasses import dataclass, field


# --------------------------------------------------------------------------- #
# Checklist topics (Phase 3.2 — Document Checklist Generator)
# --------------------------------------------------------------------------- #
@dataclass
class Question:
    key: str
    text: str
    options: list[str] = field(default_factory=list)  # empty => free text


@dataclass
class ChecklistTopic:
    key: str
    title: str
    category: str
    questions: list[Question]


CHECKLIST_TOPICS: dict[str, ChecklistTopic] = {
    "yellow_slip": ChecklistTopic(
        key="yellow_slip",
        title="Yellow Slip (EU Registration Certificate, MEU1)",
        category="immigration",
        questions=[
            Question("citizenship", "Are you an EU/EEA/Swiss citizen or a non-EU national?",
                     ["EU/EEA/Swiss", "Non-EU"]),
            Question("reason", "What is your main reason for residence?",
                     ["Employment", "Self-employment", "Studies", "Self-sufficient (own funds)"]),
            Question("address", "Do you already have a Cyprus address (rental/utility bill)?",
                     ["Yes", "Not yet"]),
        ],
    ),
    "company": ChecklistTopic(
        key="company",
        title="Registering a Company (Registrar of Companies)",
        category="business",
        questions=[
            Question("type", "What type of company do you want to register?",
                     ["Private limited by shares", "Other"]),
            Question("name", "Has your company name been approved yet?", ["Yes", "No"]),
            Question("provider", "Will you use a lawyer / licensed service provider?",
                     ["Yes", "No, filing myself"]),
        ],
    ),
    "gesy": ChecklistTopic(
        key="gesy",
        title="Registering with GeSy (National Health System)",
        category="health",
        questions=[
            Question("status", "What is your status?",
                     ["Employee", "Self-employed", "Pensioner", "Other"]),
            Question("credentials", "Do you have government digital-authentication credentials?",
                     ["Yes", "No"]),
            Question("doctor", "Have you chosen a Personal Doctor (GP) yet?", ["Yes", "Not yet"]),
        ],
    ),
    "vat": ChecklistTopic(
        key="vat",
        title="VAT Registration",
        category="tax",
        questions=[
            Question("activity", "What best describes your activity?",
                     ["Selling goods", "Providing services", "Both"]),
            Question("turnover", "Is your annual turnover above the registration threshold?",
                     ["Yes", "No / not sure"]),
            Question("eu", "Do you trade with other EU countries?", ["Yes", "No"]),
        ],
    ),
    "tax": ChecklistTopic(
        key="tax",
        title="Personal Income Tax Return (TD1)",
        category="tax",
        questions=[
            Question("residency", "Are you a Cyprus tax resident?", ["Yes", "No / not sure"]),
            Question("income", "What are your main income sources?",
                     ["Employment", "Self-employment", "Pension", "Rental / investments"]),
            Question("taxisnet", "Do you already have a TAXISnet account?", ["Yes", "No"]),
        ],
    ),
}


# --------------------------------------------------------------------------- #
# Fillable forms (Phase 3.3 — Form Filler, premium)
# --------------------------------------------------------------------------- #
@dataclass
class FormField:
    key: str
    label: str
    required: bool = False
    example: str = ""
    help: str = ""


@dataclass
class FormDefinition:
    key: str
    title: str
    official_ref: str
    source_url: str
    category: str
    note: str
    fields: list[FormField]

    @property
    def required_fields(self) -> list[FormField]:
        return [f for f in self.fields if f.required]


FORMS: dict[str, FormDefinition] = {
    "meu1": FormDefinition(
        key="meu1",
        title="EU Citizen Registration Certificate",
        official_ref="Form MEU1",
        source_url="https://www.moi.gov.cy/crmd",
        category="immigration",
        note="For EU/EEA/Swiss citizens applying for a Yellow Slip.",
        fields=[
            FormField("full_name", "Full name (as in passport/ID)", True, "Maria Georgiou"),
            FormField("date_of_birth", "Date of birth", True, "1990-05-14"),
            FormField("nationality", "Nationality", True, "Greek"),
            FormField("passport_or_id_number", "Passport or ID number", True, "AB1234567"),
            FormField("purpose_of_residence", "Purpose of residence", True,
                      "Employment", "Employment / Self-employment / Studies / Self-sufficient"),
            FormField("address_in_cyprus", "Address in Cyprus", True,
                      "12 Makariou Ave, 3040 Limassol"),
            FormField("employer_or_institution", "Employer or institution", False,
                      "ACME Ltd"),
            FormField("date_of_arrival", "Date of arrival in Cyprus", False, "2026-06-01"),
            FormField("contact_phone", "Contact phone", False, "+357 99 123456"),
            FormField("contact_email", "Contact email", False, "maria@example.com"),
        ],
    ),
    "td1": FormDefinition(
        key="td1",
        title="Personal Income Tax Return",
        official_ref="Form TD1",
        source_url="https://www.mof.gov.cy/tax",
        category="tax",
        note="Annual personal income tax return, filed via TAXISnet.",
        fields=[
            FormField("full_name", "Full name", True, "Andreas Nicolaou"),
            FormField("tax_identification_code", "Tax Identification Code (TIC)", True, "12345678X"),
            FormField("tax_year", "Tax year", True, "2025"),
            FormField("residential_address", "Residential address", True,
                      "5 Athinon St, 1015 Nicosia"),
            FormField("employment_income", "Employment income (EUR)", False, "35000"),
            FormField("self_employment_income", "Self-employment income (EUR)", False, "0"),
            FormField("rental_income", "Rental income (EUR)", False, "0"),
            FormField("other_income", "Other income (EUR)", False, "0"),
            FormField("gesy_contributions", "GeSy contributions paid (EUR)", False, "965"),
            FormField("social_insurance_contributions", "Social insurance paid (EUR)", False, "2870"),
            FormField("donations", "Approved donations (EUR)", False, "0"),
        ],
    ),
}


def get_topic(key: str) -> ChecklistTopic | None:
    return CHECKLIST_TOPICS.get(key.strip().lower())


def get_form(key: str) -> FormDefinition | None:
    return FORMS.get(key.strip().lower())
