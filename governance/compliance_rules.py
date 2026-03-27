"""
governance/compliance_rules.py

CiteGuard AI — Compliance Rules Engine
Owner: Neha (AI Governance & Risk)

Enforces mandatory compliance rules on every response.
Aligns to architecture.md §3.5 and compliance-framework.md §4–§7.
Designed for Azure Functions integration.

CHANGES FROM PREVIOUS VERSION (aligned to Final Architecture Lock Note):
  - Rule IDs updated from CR-001..CR-009 → GOV-001..GOV-006
  - Trust score scale changed from 0–100 integer → 0.0–1.0 float
    to match locked decision thresholds (ALLOW >= 0.75, etc.)
  - MINIMUM_TRUST_SCORE updated to 0.40 (maps to BLOCK threshold)
  - GOV-006 added for human escalation / DEFER path (LOW confidence
    + HIGH risk) so it surfaces as its own rule ID in Power BI
  - Citation field names updated to match locked contract:
      source_id       → doc_id
      relevance_score → similarity_score
      is_current_version → is_active_version
      excerpt         → text
  - _determine_decision_status() thresholds updated to 0–1 scale
  - Audit entry updated to emit GOV- rule IDs
"""

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Compliance Rule Registry
# ──────────────────────────────────────────────
# severity: "BLOCK" = hard fail → decision becomes BLOCK or DEFER
#           "WARN"  = soft advisory → compliance still passes but disclaimer shown
#
# Rule ID mapping (locked in Final Architecture Lock Note §5):
#   GOV-001  sensitive_data          — query-time, hard BLOCK
#   GOV-002  prompt_abuse            — query-time, hard BLOCK
#   GOV-003  citation_insufficient   — response-time, hard BLOCK
#   GOV-004  stale_source            — response-time, soft WARN
#   GOV-005  low_confidence          — response-time, soft WARN
#   GOV-006  human_escalation        — response-time, hard BLOCK → DEFER outcome
#
# GOV-001 and GOV-002 are fired by the query filter (filter.py) before
# the LLM is called. GOV-003..GOV-006 are fired here after generation.

COMPLIANCE_RULES = [
    {
        "id": "GOV-001",
        "name": "sensitive_data",
        "severity": "BLOCK",
        "description": (
            "Query contains restricted/confidential data class signals or PII. "
            "Fired at query time — no LLM call is made."
        ),
    },
    {
        "id": "GOV-002",
        "name": "prompt_abuse",
        "severity": "BLOCK",
        "description": (
            "Query contains prompt injection or jailbreak attempt. "
            "Fired at query time — no LLM call is made."
        ),
    },
    {
        "id": "GOV-003",
        "name": "citation_insufficient",
        "severity": "BLOCK",
        "description": (
            "Response has zero citations or was generated with no retrieved chunks. "
            "Ungrounded answers cannot be surfaced."
        ),
    },
    {
        "id": "GOV-004",
        "name": "stale_source",
        "severity": "WARN",
        "description": (
            "One or more citations reference a document that is not the current "
            "version. Freshness warning shown to user. "
            "Compliance doc §3.2: freshness checks against effective/expiry dates."
        ),
    },
    {
        "id": "GOV-005",
        "name": "low_confidence",
        "severity": "WARN",
        "description": (
            "Trust score is below threshold or confidence level is LOW. "
            "Disclaimer shown to user."
        ),
    },
    {
        "id": "GOV-006",
        "name": "human_escalation",
        "severity": "BLOCK",
        "description": (
            "Response is both LOW confidence AND HIGH risk — requires human-in-the-loop "
            "review before release. Decision outcome is DEFER. "
            "Compliance doc §7: escalation mandatory for low-trust + high-risk."
        ),
    },
]

# Trust score thresholds — 0.0–1.0 scale (locked in architecture lock note §5)
TRUST_THRESHOLD_ALLOW  = 0.75   # >= ALLOW (and no blocking rule)
TRUST_THRESHOLD_REDACT = 0.55   # >= REDACT (and no blocking rule, HIGH risk flag)
TRUST_THRESHOLD_DEFER  = 0.40   # >= DEFER  (or warned rules require review)
TRUST_THRESHOLD_BLOCK  = 0.40   # <  BLOCK

# Minimum response text length (characters)
MINIMUM_RESPONSE_LENGTH = 20


# ──────────────────────────────────────────────
# Data Classes
# ──────────────────────────────────────────────

@dataclass
class RuleResult:
    """Result of evaluating a single compliance rule."""
    rule_id: str
    rule_name: str
    severity: str           # "BLOCK" | "WARN"
    passed: bool
    message: str            # Explanation for audit log / UI
    # Business function category — used by Nadia's Power BI Page 3
    # Compliance framework §9: policy violation rate by category
    business_function: str = "general"  # "grounding" | "access" | "risk" | "freshness" | "general"


@dataclass
class ComplianceReport:
    """Full compliance evaluation result for one response."""
    compliant: bool             # False = at least one BLOCK failed
    # Locked decision outcomes (architecture lock note §5 / compliance doc §4–§5)
    decision_status: str        # "ALLOW" | "REDACT" | "DEFER" | "BLOCK"
    blocked_rules: list         # Rules that caused a hard block
    warned_rules: list          # Rules that issued soft warnings
    passed_rules: list          # Rules that passed cleanly
    user_disclaimer: Optional[str]  # Message to display to end-user
    audit_entry: dict           # Ready-to-log audit record

    def to_dict(self) -> dict:
        return {
            "compliant": self.compliant,
            "decision_status": self.decision_status,
            # Locked governance output contract (architecture lock note §4-C)
            "blocked_rule_ids": [r.rule_id for r in self.blocked_rules],
            "warned_rule_ids": [r.rule_id for r in self.warned_rules],
            "user_disclaimer": self.user_disclaimer,
            # Full detail for audit log
            "blocked_by": [
                {"rule_id": r.rule_id, "rule_name": r.rule_name, "message": r.message}
                for r in self.blocked_rules
            ],
            "warnings": [
                {"rule_id": r.rule_id, "rule_name": r.rule_name, "message": r.message}
                for r in self.warned_rules
            ],
            "passed": [r.rule_id for r in self.passed_rules],
            "audit_entry": self.audit_entry,
        }


# ──────────────────────────────────────────────
# Core Compliance Engine
# ──────────────────────────────────────────────

class ComplianceEngine:
    """
    Evaluates a RAG response against all defined compliance rules.

    Trust score must be supplied on a 0.0–1.0 float scale to match
    the locked decision thresholds. risk_scorer.py normalises its
    0–100 integer output before calling this engine.
    """

    def evaluate(
        self,
        query: str,
        response_text: str,
        risk_score_result: dict,
        raw_citations: list = None,
        user_role: str = "viewer"
    ) -> ComplianceReport:
        """
        Runs all compliance rules and produces a ComplianceReport.

        Args:
            query:            Raw (sanitised) user query string.
            response_text:    LLM-generated answer.
            risk_score_result: Output of risk_scorer.score_response() —
                               trust_score must be 0.0–1.0 float.
            raw_citations:    List of citation dicts using the locked field names:
                              doc_id, chunk_id, similarity_score,
                              is_active_version, text.
            user_role:        Role from auth layer.
        """
        logger.info("[ComplianceEngine] Starting compliance evaluation.")
        blocked: list[RuleResult] = []
        warned: list[RuleResult] = []
        passed: list[RuleResult] = []

        trust_score      = float(risk_score_result.get("trust_score", 0.0))
        citation_count   = int(risk_score_result.get("citation_count", 0))
        citation_strength = risk_score_result.get("citation_strength", "NONE")
        confidence_level = risk_score_result.get("confidence_level", "LOW")
        risk_flag        = risk_score_result.get("risk_flag", "HIGH")

        # ── Evaluate each post-generation rule ──────
        # GOV-001 and GOV-002 are query-time rules fired by filter.py;
        # they are not re-evaluated here but will appear in blocked_rule_ids
        # if the query filter passes them through as pre-blocked flags.

        r = self._check_gov003(citation_count, citation_strength)
        self._bucket(r, blocked, warned, passed)

        r = self._check_gov004(risk_score_result)
        self._bucket(r, blocked, warned, passed)

        r = self._check_gov005(trust_score, confidence_level, response_text)
        self._bucket(r, blocked, warned, passed)

        r = self._check_gov006(confidence_level, risk_flag)
        self._bucket(r, blocked, warned, passed)

        # ── Determine decision status ─────────────
        # Thresholds from architecture lock note §5 (0.0–1.0 scale):
        #   ALLOW:  trust >= 0.75 and no blocking rule
        #   REDACT: trust >= 0.55 and no blocking rule (HIGH risk)
        #   DEFER:  trust >= 0.40 or warned rules require review (GOV-006)
        #   BLOCK:  blocking rule present or trust < 0.40
        decision_status = self._determine_decision_status(
            blocked, warned, trust_score, risk_flag
        )
        compliant = decision_status in ("ALLOW", "REDACT")

        # ── Build user-facing disclaimer ──────────
        disclaimer = self._build_disclaimer(
            blocked, warned, trust_score, confidence_level, risk_flag
        )

        # ── Build audit entry ─────────────────────
        audit_entry = self._build_audit_entry(
            query=query,
            response_text=response_text,
            raw_citations=raw_citations,
            user_role=user_role,
            decision_status=decision_status,
            trust_score=trust_score,
            compliant=compliant,
            blocked=blocked,
            warned=warned,
        )

        logger.info(
            f"[ComplianceEngine] Compliant: {compliant} | "
            f"Decision: {decision_status} | "
            f"Trust: {trust_score:.2f} | "
            f"Blocked: {[r.rule_id for r in blocked]} | "
            f"Warnings: {[r.rule_id for r in warned]}"
        )

        return ComplianceReport(
            compliant=compliant,
            decision_status=decision_status,
            blocked_rules=blocked,
            warned_rules=warned,
            passed_rules=passed,
            user_disclaimer=disclaimer,
            audit_entry=audit_entry,
        )

    # ── Individual Rule Checks ────────────────────────────────────────────────

    def _check_gov003(self, citation_count: int, citation_strength: str) -> RuleResult:
        """GOV-003 citation_insufficient — hard BLOCK."""
        passed = citation_count >= 1 and citation_strength != "NONE"
        return RuleResult(
            rule_id="GOV-003",
            rule_name="citation_insufficient",
            severity="BLOCK",
            passed=passed,
            business_function="grounding",
            message=(
                f"PASS: {citation_count} citation(s) with strength {citation_strength}."
                if passed else
                "FAIL: Response has no citations or no retrieved source chunks. "
                "Ungrounded answers cannot be surfaced."
            ),
        )

    def _check_gov004(self, risk_score_result: dict) -> RuleResult:
        """GOV-004 stale_source — soft WARN."""
        freshness_flag  = risk_score_result.get("freshness_flag", "UNKNOWN")
        stale_count     = risk_score_result.get("stale_citation_count", 0)
        passed = freshness_flag in ("CURRENT", "UNKNOWN")
        return RuleResult(
            rule_id="GOV-004",
            rule_name="stale_source",
            severity="WARN",
            passed=passed,
            business_function="freshness",
            message=(
                f"PASS: Citations are from current document versions (freshness={freshness_flag})."
                if passed else
                f"WARN: {stale_count} citation(s) are from outdated document version(s). "
                "Verify currency before acting on this response."
            ),
        )

    def _check_gov005(
        self, trust_score: float, confidence_level: str, response_text: str
    ) -> RuleResult:
        """GOV-005 low_confidence — soft WARN."""
        passed = (
            trust_score >= TRUST_THRESHOLD_DEFER
            and confidence_level != "LOW"
        )
        return RuleResult(
            rule_id="GOV-005",
            rule_name="low_confidence",
            severity="WARN",
            passed=passed,
            business_function="grounding",
            message=(
                f"PASS: Trust score {trust_score:.2f} and confidence {confidence_level} are acceptable."
                if passed else
                f"WARN: Trust score {trust_score:.2f} or confidence {confidence_level} is below "
                f"acceptable threshold ({TRUST_THRESHOLD_DEFER}). A disclaimer will be shown."
            ),
        )

    def _check_gov006(self, confidence_level: str, risk_flag: str) -> RuleResult:
        """GOV-006 human_escalation — hard BLOCK → DEFER outcome."""
        needs_escalation = (confidence_level == "LOW" and risk_flag == "HIGH")
        return RuleResult(
            rule_id="GOV-006",
            rule_name="human_escalation",
            severity="BLOCK",
            passed=not needs_escalation,
            business_function="risk",
            message=(
                "PASS: Confidence/risk combination does not require escalation."
                if not needs_escalation else
                "FAIL: LOW confidence + HIGH risk detected. Response must be reviewed "
                "by a qualified human before release. Decision: DEFER."
            ),
        )

    def _determine_decision_status(
        self,
        blocked: list,
        warned: list,
        trust_score: float,
        risk_flag: str,
    ) -> str:
        """
        Apply locked decision thresholds (architecture lock note §5).

        Priority order:
          1. GOV-006 present → DEFER (human escalation, not a hard block)
          2. Any other BLOCK rule → BLOCK
          3. trust < 0.40      → BLOCK
          4. trust >= 0.75 and no blocks → ALLOW
          5. trust >= 0.55 and HIGH risk → REDACT
          6. trust >= 0.40               → DEFER (warned rules present)
        """
        blocked_ids = [r.rule_id for r in blocked]

        if "GOV-006" in blocked_ids:
            return "DEFER"

        if blocked_ids:
            return "BLOCK"

        if trust_score < TRUST_THRESHOLD_BLOCK:
            return "BLOCK"

        if trust_score >= TRUST_THRESHOLD_ALLOW:
            return "ALLOW"

        if trust_score >= TRUST_THRESHOLD_REDACT and risk_flag == "HIGH":
            return "REDACT"

        return "DEFER"

    def _bucket(self, rule: RuleResult, blocked, warned, passed):
        if rule.passed:
            passed.append(rule)
        elif rule.severity == "BLOCK":
            blocked.append(rule)
        else:
            warned.append(rule)

    def _build_disclaimer(
        self,
        blocked: list,
        warned: list,
        trust_score: float,
        confidence_level: str,
        risk_flag: str,
    ) -> Optional[str]:
        if blocked:
            blocked_ids = [r.rule_id for r in blocked]
            if "GOV-006" in blocked_ids:
                return (
                    "🔄 This response requires human review before it can be released. "
                    "It has been flagged for escalation."
                )
            return (
                "⛔ This response did not pass compliance checks and cannot be displayed. "
                "Please refine your query or contact your administrator."
            )
        parts = []
        warned_ids = [r.rule_id for r in warned]
        if "GOV-005" in warned_ids or confidence_level == "LOW":
            parts.append(
                "ℹ️ This answer has low confidence. Verify with source documents before acting."
            )
        if "GOV-004" in warned_ids:
            parts.append(
                "⚠️ One or more cited documents may be outdated. "
                "Check document versions before relying on this response."
            )
        if risk_flag == "HIGH":
            parts.append(
                "⚠️ This response contains regulatory or legal language. "
                "Please consult a qualified professional before making decisions."
            )
        if risk_flag == "MEDIUM":
            parts.append(
                "ℹ️ Some parts of this answer may be subject to interpretation. "
                "Review the cited sources for full context."
            )
        return " ".join(parts) if parts else None

    def _build_audit_entry(
        self,
        query: str,
        response_text: str,
        raw_citations: list,
        user_role: str,
        decision_status: str,
        trust_score: float,
        compliant: bool,
        blocked: list,
        warned: list,
    ) -> dict:
        """
        Builds an immutable audit record for every request.
        Fields align to the locked audit contract (architecture lock note §4-A).
        Citations use the locked field names: doc_id, chunk_id,
        similarity_score, is_active_version, text.
        """
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "query_preview": query[:100] + ("..." if len(query) > 100 else ""),
            # Full content for RAI Toolbox metrics
            "full_query": query,
            "full_response": response_text,
            # Citations in locked contract shape (architecture lock note §4-D)
            "raw_citations": raw_citations or [],
            "user_role": user_role,
            # Locked governance output contract fields (architecture lock note §4-C)
            "decision_status": decision_status,
            "blocked_rule_ids": [r.rule_id for r in blocked],
            "warned_rule_ids": [r.rule_id for r in warned],
            # Trust score on 0.0–1.0 scale (matches locked thresholds)
            "trust_score": round(trust_score, 4),
            "compliant": compliant,
            "version_snapshot": {
                "model_version": "azure-openai-gpt4-1.0",
                "prompt_template_version": "1.0.0",
                "retrieval_index_version": "1.0.0",
                "policy_bundle_version": "1.0.0",
                "evaluation_config_version": "1.0.0",
                "governance_module_version": "2.0.0",
                "rule_count": len(COMPLIANCE_RULES),
                "schema": "citeguard-audit-v2",
            },
            "policy_violation_categories": [r.rule_id for r in blocked],
        }


# ──────────────────────────────────────────────
# Azure Function Entry Point
# ──────────────────────────────────────────────

def check_compliance(
    query: str,
    response_text: str,
    risk_score_dict: dict,
    raw_citations: list = None,
    user_role: str = "viewer"
) -> dict:
    """
    Callable from an Azure Function or backend pipeline step.

    Args:
        query:           Raw sanitised query string.
        response_text:   LLM-generated answer.
        risk_score_dict: Output of score_response() — trust_score must be
                         on 0.0–1.0 scale (normalise before calling if needed).
        raw_citations:   List of citation dicts with locked field names:
                         doc_id, chunk_id, similarity_score,
                         is_active_version, text.
        user_role:       Role from auth/identity layer.

    Returns a dict safe to serialise as JSON in an HttpResponse.
    """
    report = ComplianceEngine().evaluate(
        query=query,
        response_text=response_text,
        risk_score_result=risk_score_dict,
        raw_citations=raw_citations,
        user_role=user_role,
    )
    return report.to_dict()
