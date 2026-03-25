from dataclasses import dataclass, asdict
from datetime import datetime
from typing import List, Dict, Any


@dataclass
class FilterResult:
    allowed: bool
    reason: str = None
    sanitized_query: str = None
    policy_context: Dict[str, Any] = None


@dataclass
class Citation:
    source_id: str
    chunk_id: str
    relevance_score: float
    is_current_version: bool


@dataclass
class RiskScore:
    trust_score: float
    hallucination_risk: float
    citation_coverage: float

    def to_dict(self):
        return asdict(self)


class GovernanceFilter:
    def __init__(self):
        self.blocked_patterns = [
            "ssn",
            "social security number",
            "drop table",
            "password",
            "eval("
        ]

    def evaluate(self, query: str, user_role: str) -> FilterResult:
        if not query or not isinstance(query, str) or not query.strip():
            return FilterResult(allowed=False, reason="Empty query")

        normalized = query.strip().lower()
        for pattern in self.blocked_patterns:
            if pattern in normalized:
                return FilterResult(allowed=False, reason="Query contains blocked content")

        sanitized_query = " ".join(query.strip().split())
        allowed_data_classes = ["public"]

        if user_role == "admin":
            allowed_data_classes = ["public", "private", "confidential"]
        elif user_role == "user":
            allowed_data_classes = ["public", "private"]
        elif user_role == "auditor":
            allowed_data_classes = ["public"]

        return FilterResult(
            allowed=True,
            sanitized_query=sanitized_query,
            policy_context={"allowed_data_classes": allowed_data_classes}
        )


class RiskScorer:
    def score(self, response_text: str, citations: List[Citation]) -> RiskScore:
        has_citation = len(citations) > 0
        base_score = 0.6 if has_citation else 0.35
        citation_quality = sum(1 for c in citations if c.is_current_version) / (len(citations) or 1)
        length_factor = min(max(len(response_text or "") / 250, 0.1), 1.0)

        trust_score = min(1.0, base_score + citation_quality * 0.25 + length_factor * 0.15)
        hallucination_risk = 1 - trust_score
        citation_coverage = 1.0 if has_citation else 0.0
        return RiskScore(trust_score, hallucination_risk, citation_coverage)


class ComplianceEngine:
    def evaluate(self, query: str, response_text: str, risk_score_result: Dict[str, Any], raw_citations: List[Dict[str, Any]], user_role: str):
        trust = float(risk_score_result.get("trust_score", 0))
        decision_status = "BLOCK"
        user_disclaimer = "The response is blocked due to policy."

        if trust >= 0.75:
            decision_status = "ALLOW"
            user_disclaimer = "Response is compliant."
        elif trust >= 0.55:
            decision_status = "REDACT"
            user_disclaimer = "Response is provided with redaction warning."
        elif trust >= 0.40:
            decision_status = "DEFER"
            user_disclaimer = "Response requires human review before release."

        audit_entry = {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "query": query,
            "user_role": user_role,
            "decision_status": decision_status,
            "trust_score": trust,
            "citation_count": len(raw_citations),
            "reason": user_disclaimer
        }

        return {
            "decision_status": decision_status,
            "user_disclaimer": user_disclaimer,
            "audit_entry": audit_entry
        }


# mock retrieval + LLM

def run_vector_search(sanitized_query: str, allowed_classes: List[str]) -> List[Dict[str, Any]]:
    return [
        {
            "doc_id": "doc-101",
            "chunk_id": "chunk-1",
            "similarity_score": 0.92,
            "is_active_version": True,
            "text": "This is the authoritative answer for query part 1."
        },
        {
            "doc_id": "doc-102",
            "chunk_id": "chunk-2",
            "similarity_score": 0.85,
            "is_active_version": True,
            "text": "Supporting context for compliance and governance."
        }
    ]


def generate_llm_answer(sanitized_query: str, raw_citations: List[Dict[str, Any]]) -> str:
    evidence = "\n".join(
        f"{i + 1}. [{c['doc_id']}:{c['chunk_id']}] {c.get('text','')}" for i, c in enumerate(raw_citations)
    )
    return f"Answer to: {sanitized_query}. Based on evidence:\n{evidence}"


def save_audit_log(audit_entry: Dict[str, Any]):
    print("[AUDIT] saved", audit_entry)


def process_user_query(user_query: str, user_role: str):
    filter_engine = GovernanceFilter()
    filter_result = filter_engine.evaluate(user_query, user_role)

    if not filter_result.allowed:
        return {"status": "blocked", "reason": filter_result.reason}

    sanitized_query = filter_result.sanitized_query
    allowed_data_classes = filter_result.policy_context["allowed_data_classes"]

    raw_citations = run_vector_search(sanitized_query, allowed_data_classes)
    llm_draft_response = generate_llm_answer(sanitized_query, raw_citations)

    formatted_citations = [
        Citation(
            source_id=c["doc_id"],
            chunk_id=c["chunk_id"],
            relevance_score=c["similarity_score"],
            is_current_version=c["is_active_version"]
        )
        for c in raw_citations
    ]

    risk_engine = RiskScorer()
    risk_score = risk_engine.score(llm_draft_response, formatted_citations)
    risk_dict = risk_score.to_dict()

    compliance_engine = ComplianceEngine()
    compliance_report = compliance_engine.evaluate(
        query=sanitized_query,
        response_text=llm_draft_response,
        risk_score_result=risk_dict,
        raw_citations=raw_citations,
        user_role=user_role
    )

    save_audit_log(compliance_report["audit_entry"])

    decision = compliance_report["decision_status"]

    if decision == "ALLOW":
        return {
            "status": "success",
            "answer": llm_draft_response,
            "trust_score": risk_dict["trust_score"],
            "citations": raw_citations
        }
    elif decision == "REDACT":
        return {
            "status": "warning",
            "answer": llm_draft_response,
            "disclaimer": compliance_report["user_disclaimer"],
            "trust_score": risk_dict["trust_score"]
        }
    elif decision == "DEFER":
        return {
            "status": "escalated",
            "message": "This query requires human-in-the-loop review.",
            "disclaimer": compliance_report["user_disclaimer"]
        }
    else:
        return {
            "status": "blocked",
            "message": compliance_report["user_disclaimer"]
        }
