"""
governance/compliance_rules.py
CiteGuard AI — Compliance Rules Engine
Owner: Neha (AI Governance & Risk)

Enforces mandatory compliance rules on every response.
Aligns to architecture.md §3.5 and compliance-framework.md §4–§7.
Designed for Azure Functions integration.
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
# Compliance doc §4: decision outcomes are Allow / Redact / Defer / Block

COMPLIANCE_RULES = [
    {
        "id": "CR-001",
        "name": "Citation Required",
        "severity": "BLOCK",
        "description": "Every response must include at least one source citation.",
    },
    {
        "id": "CR-002",
        "name": "Minimum Trust Score",
        "severity": "BLOCK",
        "description": "Responses with a trust score below 30 must not be surfaced.",
    },
    {
        "id": "CR-003",
        "name": "High-Risk Response Review",
        "severity": "WARN",
        "description": "HIGH-risk responses must display a human-review advisory.",
    },
    {
        "id": "CR-004",
        "name": "Ungrounded Response Block",
        "severity": "BLOCK",
        "description": "Responses generated with zero retrieved chunks are not permitted.",
    },
    {
        "id": "CR-005",
        "name": "Low Confidence Advisory",
        "severity": "WARN",
        "description": "LOW confidence responses must display a disclaimer.",
    },
    {
        "id": "CR-006",
        "name": "Source Diversity",
        "severity": "WARN",
        "description": "Single-source responses should note limited source diversity.",
    },
    {
        "id": "CR-007",
        "name": "Response Length Sanity Check",
        "severity": "WARN",
        "description": "Unusually short responses may indicate a retrieval failure.",
    },
    {
        "id": "CR-008",
        "name": "Document Freshness Check",
        "severity": "WARN",
        "description": (
            "Responses citing stale or superseded documents must display a "
            "freshness warning. Compliance doc §3.2: freshness checks against "
            "effective/expiry dates."
        ),
    },
    {
        "id": "CR-009",
        "name": "Human Escalation Required",
        "severity": "BLOCK",
        "description": (
            "Responses that are both LOW confidence AND HIGH risk require "
            "human-in-the-loop review before release. "
            "Compliance doc §7: escalation mandatory for low-trust + high-risk."
        ),
    },
]

# Trust score below this → hard block
MINIMUM_TRUST_SCORE = 30

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
    compliant: bool                          # False = at least one BLOCK failed
    # Compliance doc §4–§5: explicit decision outcome
    decision_status: str                     # "ALLOW" | "REDACT" | "DEFER" | "BLOCK"
    blocked_rules: list                      # Rules that caused a hard block
    warned_rules: list                       # Rules that issued soft warnings
    passed_rules: list                       # Rules that passed cleanly
    user_disclaimer: Optional[str]           # Message to display to end-user
    audit_entry: dict                        # Ready-to-log audit record

    def to_dict(self) -> dict:
        return {
            "compliant": self.compliant,
            "decision_status": self.decision_status,
            "blocked_by": [
                {"rule_id": r.rule_id, "rule_name": r.rule_name, "message": r.message}
                for r in self.blocked_rules
            ],
            "warnings": [
                {"rule_id": r.rule_id, "rule_name": r.rule_name, "message": r.message}
                for r in self.warned_rules
            ],
            "passed": [r.rule_id for r in self.passed_rules],
            "user_disclaimer": self.user_disclaimer,
            "audit_entry": self.audit_entry,
        }


# ──────────────────────────────────────────────
# Core Compliance Engine
# ──────────────────────────────────────────────

class ComplianceEngine:
    """
    Evaluates a RAG response against all defined compliance rules.

    Usage (standalone):
        engine = ComplianceEngine()
        report = engine.evaluate(
            query="What is the termination clause?",
            response_text="The contract states...",
            risk_score_result=score_response(...),  # from risk_scorer.py
        )

    Usage (Azure Function):
        from governance.compliance_rules import check_compliance
        report = check_compliance(query, response_text, risk_score_dict)
        if not report["compliant"]:
            return func.HttpResponse(
                json.dumps(report), status_code=451  # 451 = Unavailable For Legal Reasons
            )
    """

    def evaluate(
        self,
        query: str,
        response_text: str,
        risk_score_result: dict,
    ) -> ComplianceReport:
        """
        Runs all compliance rules and produces a ComplianceReport.

        Args:
            query:             The original (sanitized) user query.
            response_text:     The LLM-generated answer.
            risk_score_result: Dict from risk_scorer.score_response(...)
                               Keys: trust_score, citation_count, citation_strength,
                                     confidence_level, risk_flag, warnings, ...
        """
        logger.info("[ComplianceEngine] Starting compliance evaluation.")

        blocked: list[RuleResult] = []
        warned: list[RuleResult] = []
        passed: list[RuleResult] = []

        trust_score = risk_score_result.get("trust_score", 0)
        citation_count = risk_score_result.get("citation_count", 0)
        citation_strength = risk_score_result.get("citation_strength", "NONE")
        confidence_level = risk_score_result.get("confidence_level", "LOW")
        risk_flag = risk_score_result.get("risk_flag", "HIGH")

        # ── Evaluate each rule ─────────────────

        # CR-001: Citation Required
        r = self._check_cr001(citation_count)
        self._bucket(r, blocked, warned, passed)

        # CR-002: Minimum Trust Score
        r = self._check_cr002(trust_score)
        self._bucket(r, blocked, warned, passed)

        # CR-003: High-Risk Response Review
        r = self._check_cr003(risk_flag)
        self._bucket(r, blocked, warned, passed)

        # CR-004: Ungrounded Response Block
        r = self._check_cr004(citation_strength, response_text)
        self._bucket(r, blocked, warned, passed)

        # CR-005: Low Confidence Advisory
        r = self._check_cr005(confidence_level)
        self._bucket(r, blocked, warned, passed)

        # CR-006: Source Diversity
        r = self._check_cr006(citation_count)
        self._bucket(r, blocked, warned, passed)

        # CR-007: Response Length Sanity Check
        r = self._check_cr007(response_text)
        self._bucket(r, blocked, warned, passed)

        # CR-008: Document Freshness Check
        # Compliance doc §3.2: freshness checks against effective/expiry dates
        r = self._check_cr008(risk_score_result)
        self._bucket(r, blocked, warned, passed)

        # CR-009: Human Escalation Required
        # Compliance doc §7: low-trust + high-risk = mandatory human review
        r = self._check_cr009(confidence_level, risk_flag)
        self._bucket(r, blocked, warned, passed)

        # ── Determine decision status ──────────
        # Compliance doc §5: Allow / Redact / Defer / Block
        decision_status = self._determine_decision_status(
            blocked, warned, confidence_level, risk_flag
        )
        compliant = decision_status in ("ALLOW", "REDACT")

        # ── Build user-facing disclaimer ───────
        disclaimer = self._build_disclaimer(blocked, warned, confidence_level, risk_flag)

        # ── Build audit entry ──────────────────
        audit_entry = self._build_audit_entry(
            query, trust_score, compliant, blocked, warned
        )

        logger.info(
            f"[ComplianceEngine] Compliant: {compliant} | "
            f"Blocked rules: {[r.rule_id for r in blocked]} | "
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

    # ── Individual Rule Checks ─────────────────

    def _check_cr001(self, citation_count: int) -> RuleResult:
        passed = citation_count >= 1
        return RuleResult(
            rule_id="CR-001", rule_name="Citation Required",
            severity="BLOCK", passed=passed, business_function="grounding",
            message=(
                "PASS: Response includes citations."
                if passed
                else "FAIL: Response has no citations. Cannot surface ungrounded answers."
            ),
        )

    def _check_cr002(self, trust_score: int) -> RuleResult:
        passed = trust_score >= MINIMUM_TRUST_SCORE
        return RuleResult(
            rule_id="CR-002", rule_name="Minimum Trust Score",
            severity="BLOCK", passed=passed, business_function="grounding",
            message=(
                f"PASS: Trust score {trust_score} meets minimum ({MINIMUM_TRUST_SCORE})."
                if passed
                else f"FAIL: Trust score {trust_score} is below minimum threshold ({MINIMUM_TRUST_SCORE})."
            ),
        )

    def _check_cr003(self, risk_flag: str) -> RuleResult:
        passed = risk_flag != "HIGH"
        return RuleResult(
            rule_id="CR-003", rule_name="High-Risk Response Review",
            severity="WARN", passed=passed, business_function="risk",
            message=(
                "PASS: No high-risk language detected."
                if passed
                else "WARN: Response contains high-risk terms. Human review recommended before acting."
            ),
        )

    def _check_cr004(self, citation_strength: str, response_text: str) -> RuleResult:
        passed = citation_strength != "NONE"
        return RuleResult(
            rule_id="CR-004", rule_name="Ungrounded Response Block",
            severity="BLOCK", passed=passed, business_function="grounding",
            message=(
                "PASS: Response is grounded in retrieved document chunks."
                if passed
                else "FAIL: Response was generated with no retrieved source chunks. Cannot proceed."
            ),
        )

    def _check_cr005(self, confidence_level: str) -> RuleResult:
        passed = confidence_level != "LOW"
        return RuleResult(
            rule_id="CR-005", rule_name="Low Confidence Advisory",
            severity="WARN", passed=passed, business_function="grounding",
            message=(
                "PASS: Confidence level is acceptable."
                if passed
                else "WARN: Confidence is LOW. A disclaimer will be shown to the user."
            ),
        )

    def _check_cr006(self, citation_count: int) -> RuleResult:
        passed = citation_count > 1
        return RuleResult(
            rule_id="CR-006", rule_name="Source Diversity",
            severity="WARN", passed=passed, business_function="grounding",
            message=(
                f"PASS: {citation_count} sources referenced — good diversity."
                if passed
                else "WARN: Only 1 source referenced. Consider expanding the knowledge base."
            ),
        )

    def _check_cr007(self, response_text: str) -> RuleResult:
        passed = len(response_text.strip()) >= MINIMUM_RESPONSE_LENGTH
        return RuleResult(
            rule_id="CR-007", rule_name="Response Length Sanity Check",
            severity="WARN", passed=passed, business_function="general",
            message=(
                "PASS: Response length is within expected range."
                if passed
                else f"WARN: Response is suspiciously short ({len(response_text)} chars). Possible retrieval failure."
            ),
        )

    # ── Helpers ───────────────────────────────

    def _check_cr008(self, risk_score_result: dict) -> RuleResult:
        freshness_flag = risk_score_result.get("freshness_flag", "UNKNOWN")
        stale_count = risk_score_result.get("stale_citation_count", 0)
        passed = freshness_flag in ("CURRENT", "UNKNOWN")
        return RuleResult(
            rule_id="CR-008", rule_name="Document Freshness Check",
            severity="WARN", passed=passed, business_function="freshness",
            message=(
                f"PASS: Citations are from current document versions (freshness={freshness_flag})."
                if passed
                else f"WARN: {stale_count} citation(s) are from outdated document version(s). "
                     "Verify currency before acting on this response."
            ),
        )

    def _check_cr009(self, confidence_level: str, risk_flag: str) -> RuleResult:
        needs_escalation = (confidence_level == "LOW" and risk_flag == "HIGH")
        return RuleResult(
            rule_id="CR-009", rule_name="Human Escalation Required",
            severity="BLOCK", passed=not needs_escalation, business_function="risk",
            message=(
                "PASS: Confidence/risk combination does not require escalation."
                if not needs_escalation
                else "FAIL: LOW confidence + HIGH risk detected. "
                     "This response must be reviewed by a qualified human before release."
            ),
        )

    def _determine_decision_status(
        self,
        blocked: list,
        warned: list,
        confidence_level: str,
        risk_flag: str,
    ) -> str:
        """
        Maps rule outcomes to a formal decision status.
        Compliance doc §5: Allow / Redact / Defer / Block.

        Logic:
          BLOCK  → any BLOCK-severity rule failed
          DEFER  → CR-009 specifically failed (escalation to human)
          REDACT → only WARNs failed and risk is HIGH (partial release with disclaimer)
          ALLOW  → all rules passed (warnings are advisory only)
        """
        blocked_ids = [r.rule_id for r in blocked]

        if "CR-009" in blocked_ids:
            return "DEFER"   # Human-in-the-loop required before any release

        if blocked_ids:
            return "BLOCK"   # Hard policy violation — do not release

        if risk_flag == "HIGH":
            return "REDACT"  # Release with sensitive content flagged/disclaimed

        return "ALLOW"

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
        confidence_level: str,
        risk_flag: str,
    ) -> Optional[str]:
        if blocked:
            # Check if it's a DEFER (escalation) vs outright BLOCK
            blocked_ids = [r.rule_id for r in blocked]
            if "CR-009" in blocked_ids:
                return (
                    "🔄 This response requires human review before it can be released. "
                    "It has been flagged for escalation."
                )
            return (
                "⛔ This response did not pass compliance checks and cannot be displayed. "
                "Please refine your query or contact your administrator."
            )
        parts = []
        if confidence_level == "LOW":
            parts.append(
                "ℹ️ This answer has low confidence. Verify with source documents before acting."
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
        trust_score: int,
        compliant: bool,
        blocked: list,
        warned: list,
    ) -> dict:
        """
        Builds an immutable audit record for every request.
        Architecture §3.6 + Compliance §3.5: immutable event logging,
        policy decision logging with rule-level outcomes.
        """
        return {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "query_preview": query[:100] + ("..." if len(query) > 100 else ""),
            "trust_score": trust_score,
            "compliant": compliant,
            "blocked_rule_ids": [r.rule_id for r in blocked],
            "warned_rule_ids": [r.rule_id for r in warned],
            # Architecture §9: all 5 version fields required for Power BI dashboard (Nadia)
            # and regulator-facing traceability
            "version_snapshot": {
                "model_version": "azure-openai-gpt4-1.0",
                "prompt_template_version": "1.0.0",
                "retrieval_index_version": "1.0.0",
                "policy_bundle_version": "1.0.0",
                "evaluation_config_version": "1.0.0",
                "governance_module_version": "1.0.0",
                "rule_count": len(COMPLIANCE_RULES),
                "schema": "citeguard-audit-v1",
            },
            # Policy violation categories for Nadia's Power BI Page 3
            # Compliance framework §9: policy violation rate by category
            "policy_violation_categories": [r.rule_id for r in blocked],
        }


# ──────────────────────────────────────────────
# Azure Function Entry Point
# ──────────────────────────────────────────────

def check_compliance(
    query: str,
    response_text: str,
    risk_score_dict: dict,
) -> dict:
    """
    Callable from an Azure Function or backend pipeline step.

    Args:
        query:           Sanitized user query string.
        response_text:   LLM-generated response string.
        risk_score_dict: Output dict from risk_scorer.score_response(...)

    Full pipeline example in your Azure Function:
        from governance.filter import run_filter
        from governance.risk_scorer import score_response
        from governance.compliance_rules import check_compliance

        role          = req.headers.get("X-User-Role", "viewer")
        filter_result = run_filter(query, user_role=role)
        if not filter_result["allowed"]:
            return func.HttpResponse(filter_result["reason"], status_code=400)

        rag_response, citations = call_rag_pipeline(
            filter_result["sanitized_query"],
            policy_context=filter_result["policy_context"],   # pass role/data-class filters
        )
        risk       = score_response(rag_response, citations)
        compliance = check_compliance(query, rag_response, risk)

        status_map = {"ALLOW": 200, "REDACT": 200, "DEFER": 202, "BLOCK": 451}
        return func.HttpResponse(
            json.dumps(compliance),
            status_code=status_map.get(compliance["decision_status"], 500),
        )

    Returns a dict safe to serialize as JSON.
    """
    report = ComplianceEngine().evaluate(query, response_text, risk_score_dict)
    return report.to_dict()