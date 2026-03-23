"""
governance/risk_scorer.py
CiteGuard AI — Response Risk Scorer
Owner: Neha (AI Governance & Risk)

Runs AFTER the RAG pipeline generates a response.
Scores the response on confidence, citation strength, and risk level.
Designed for Azure Functions integration.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# Constants & Thresholds
# ──────────────────────────────────────────────

# Minimum number of citations required for a high-confidence answer
MIN_CITATIONS_FOR_HIGH_CONFIDENCE = 3
MIN_CITATIONS_FOR_MED_CONFIDENCE = 1

# Relevance score thresholds (from vector DB similarity, 0.0–1.0)
HIGH_RELEVANCE_THRESHOLD = 0.80
MED_RELEVANCE_THRESHOLD = 0.60

# Risk keywords that elevate the risk flag in a response
HIGH_RISK_KEYWORDS = [
    "terminate", "breach", "penalty", "lawsuit", "liability", "malpractice",
    "violation", "non-compliant", "sanction", "illegal", "fraud",
    "unauthorized", "forbidden", "prohibited", "criminal",
]

MEDIUM_RISK_KEYWORDS = [
    "may", "might", "could", "unclear", "uncertain", "subject to interpretation",
    "consult", "seek advice", "not defined", "ambiguous", "varies",
]

# Uncertainty phrases that lower confidence
UNCERTAINTY_PHRASES = [
    "i'm not sure", "i cannot find", "no relevant document",
    "insufficient information", "not mentioned", "not found",
    "unable to determine", "no data available",
]


# ──────────────────────────────────────────────
# Data Classes
# ──────────────────────────────────────────────

@dataclass
class Citation:
    """Represents a single source citation returned by the RAG pipeline."""
    source_id: str           # Document ID or filename
    chunk_id: str            # Specific chunk ID
    relevance_score: float   # Cosine similarity score (0.0–1.0)
    excerpt: Optional[str] = None        # Brief text excerpt from the chunk
    # Architecture §5: F = freshness and version confidence
    # Set to False if document is expired or superseded
    is_current_version: bool = True


@dataclass
class RiskScore:
    """
    Full risk assessment result for a generated response.
    Trust formula from architecture §5:
        T = wR·R + wC·C + wP·P + wF·F
    where R=retrieval quality, C=citation completeness,
    P=policy pass strength, F=freshness/version confidence.
    """
    # Overall trust score (0–100, scaled from 0–1 formula)
    trust_score: int

    # Sub-scores (maps to formula components)
    confidence_level: str        # R  — "HIGH" | "MEDIUM" | "LOW"
    citation_strength: str       # C  — "STRONG" | "MODERATE" | "WEAK" | "NONE"
    risk_flag: str               # P  — "HIGH" | "MEDIUM" | "LOW" | "NONE"
    freshness_flag: str          # F  — "CURRENT" | "STALE" | "UNKNOWN"

    # Numeric components (for transparency / explainability layer)
    citation_count: int
    avg_relevance_score: float
    stale_citation_count: int

    # Explanations (explainability layer — architecture §3.5)
    confidence_reason: str
    citation_reason: str
    risk_reason: str
    freshness_reason: str

    # Non-blocking advisory notes
    warnings: list = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "trust_score": self.trust_score,
            "confidence_level": self.confidence_level,
            "citation_strength": self.citation_strength,
            "risk_flag": self.risk_flag,
            "freshness_flag": self.freshness_flag,
            "citation_count": self.citation_count,
            "avg_relevance_score": round(self.avg_relevance_score, 3),
            "stale_citation_count": self.stale_citation_count,
            "confidence_reason": self.confidence_reason,
            "citation_reason": self.citation_reason,
            "risk_reason": self.risk_reason,
            "freshness_reason": self.freshness_reason,
            "warnings": self.warnings,
        }


# ──────────────────────────────────────────────
# Core Scorer Class
# ──────────────────────────────────────────────

class RiskScorer:
    """
    Post-generation response scorer for CiteGuard AI.

    Usage (standalone):
        scorer = RiskScorer()
        score = scorer.score(response_text, citations)

    Usage (Azure Function):
        from governance.risk_scorer import score_response
        result = score_response(response_text, citations)
    """

    def score(self, response_text: str, citations: list[Citation]) -> RiskScore:
        """
        Main entry point. Evaluates response + citations and returns a RiskScore.

        Args:
            response_text: The LLM-generated answer string.
            citations:     List of Citation objects from the RAG retrieval step.

        Returns:
            RiskScore dataclass with all sub-scores and explanations.
        """
        logger.info(f"[RiskScorer] Scoring response with {len(citations)} citation(s).")

        warnings = []

        # ── 1. Citation Strength (C) ──────────────
        citation_count = len(citations)
        avg_relevance = self._avg_relevance(citations)
        citation_strength, citation_reason = self._score_citations(
            citation_count, avg_relevance
        )

        # ── 2. Confidence Level (R) ───────────────
        confidence_level, confidence_reason = self._score_confidence(
            response_text, citation_count, avg_relevance
        )

        # ── 3. Risk Flag (P) ──────────────────────
        risk_flag, risk_reason, risk_warnings = self._score_risk(response_text)
        warnings.extend(risk_warnings)

        # ── 4. Freshness / Version Confidence (F) ─
        # Architecture §5: F = freshness and version confidence
        freshness_flag, freshness_reason, stale_count, fresh_warnings = \
            self._score_freshness(citations)
        warnings.extend(fresh_warnings)

        # ── 5. Compute Overall Trust Score (0–100) ─
        trust_score = self._compute_trust_score(
            citation_strength, confidence_level, risk_flag, freshness_flag
        )

        logger.info(
            f"[RiskScorer] Trust Score: {trust_score} | "
            f"Confidence: {confidence_level} | "
            f"Citation: {citation_strength} | "
            f"Risk: {risk_flag}"
        )

        return RiskScore(
            trust_score=trust_score,
            confidence_level=confidence_level,
            citation_strength=citation_strength,
            risk_flag=risk_flag,
            freshness_flag=freshness_flag,
            citation_count=citation_count,
            avg_relevance_score=avg_relevance,
            stale_citation_count=stale_count,
            confidence_reason=confidence_reason,
            citation_reason=citation_reason,
            risk_reason=risk_reason,
            freshness_reason=freshness_reason,
            warnings=warnings,
        )

    # ── Sub-Scorers ────────────────────────────

    def _avg_relevance(self, citations: list[Citation]) -> float:
        if not citations:
            return 0.0
        return sum(c.relevance_score for c in citations) / len(citations)

    def _score_citations(
        self, count: int, avg_relevance: float
    ) -> tuple[str, str]:
        if count == 0:
            return (
                "NONE",
                "No source documents were retrieved. Response is ungrounded.",
            )
        if count >= MIN_CITATIONS_FOR_HIGH_CONFIDENCE and avg_relevance >= HIGH_RELEVANCE_THRESHOLD:
            return (
                "STRONG",
                f"{count} citation(s) retrieved with avg relevance {avg_relevance:.2f} — well grounded.",
            )
        if count >= MIN_CITATIONS_FOR_MED_CONFIDENCE and avg_relevance >= MED_RELEVANCE_THRESHOLD:
            return (
                "MODERATE",
                f"{count} citation(s) retrieved with avg relevance {avg_relevance:.2f} — moderately grounded.",
            )
        return (
            "WEAK",
            f"{count} citation(s) retrieved but relevance score ({avg_relevance:.2f}) is low.",
        )

    def _score_confidence(
        self, response_text: str, count: int, avg_relevance: float
    ) -> tuple[str, str]:
        text_lower = response_text.lower()

        # Check for explicit uncertainty in the response
        for phrase in UNCERTAINTY_PHRASES:
            if phrase in text_lower:
                return (
                    "LOW",
                    f"Response contains uncertainty phrase: '{phrase}'.",
                )

        if count >= MIN_CITATIONS_FOR_HIGH_CONFIDENCE and avg_relevance >= HIGH_RELEVANCE_THRESHOLD:
            return (
                "HIGH",
                "Response is well-supported by multiple high-relevance sources.",
            )
        if count >= MIN_CITATIONS_FOR_MED_CONFIDENCE and avg_relevance >= MED_RELEVANCE_THRESHOLD:
            return (
                "MEDIUM",
                "Response has partial source support. Review citations before relying on this answer.",
            )
        return (
            "LOW",
            "Insufficient source support. This response may not be reliable.",
        )

    def _score_risk(self, response_text: str) -> tuple[str, str, list]:
        text_lower = response_text.lower()
        warnings = []

        for keyword in HIGH_RISK_KEYWORDS:
            if keyword in text_lower:
                return (
                    "HIGH",
                    f"Response contains high-risk regulatory/legal term: '{keyword}'. "
                    "Recommend human review before acting on this answer.",
                    [f"High-risk term detected: '{keyword}'. Flag for compliance review."],
                )

        medium_hits = [kw for kw in MEDIUM_RISK_KEYWORDS if kw in text_lower]
        if medium_hits:
            warnings.append(
                f"Moderate-risk language detected: {medium_hits}. "
                "Verify with a subject matter expert."
            )
            return (
                "MEDIUM",
                f"Response contains hedging/uncertainty language: {medium_hits}.",
                warnings,
            )

        return (
            "LOW",
            "No high-risk language detected in the response.",
            [],
        )

    def _compute_trust_score(
        self,
        citation_strength: str,
        confidence_level: str,
        risk_flag: str,
        freshness_flag: str = "CURRENT",
    ) -> int:
        """
        Weighted trust formula — architecture doc §5:
            T = wR·R + wC·C + wP·P + wF·F
        Mapped to 100-point scale:
          R (retrieval/confidence) : 35 pts
          C (citation strength)    : 35 pts
          P (policy/risk)          : 20 pts (deducted)
          F (freshness)            : 10 pts
        """
        confidence_points = {"HIGH": 35, "MEDIUM": 22, "LOW": 8}
        citation_points   = {"STRONG": 35, "MODERATE": 22, "WEAK": 8, "NONE": 0}
        risk_deduction    = {"LOW": 0, "MEDIUM": 10, "HIGH": 20, "NONE": 0}
        freshness_points  = {"CURRENT": 10, "UNKNOWN": 5, "STALE": 0}

        score = (
            confidence_points.get(confidence_level, 0)
            + citation_points.get(citation_strength, 0)
            + freshness_points.get(freshness_flag, 5)
            - risk_deduction.get(risk_flag, 0)
        )
        return max(0, min(100, score))

    def _score_freshness(self, citations: list) -> tuple:
        """
        Checks whether retrieved citations are current-version documents.
        Architecture §5: F = freshness and version confidence.
        Compliance doc §3.2: freshness checks against document effective/expiry dates.
        Returns (freshness_flag, reason, stale_count, warnings).
        """
        if not citations:
            return "UNKNOWN", "No citations to assess freshness.", 0, []

        stale = [c for c in citations if not c.is_current_version]
        stale_count = len(stale)
        warnings = []

        if stale_count == 0:
            return (
                "CURRENT",
                f"All {len(citations)} citation(s) are from current document versions.",
                0,
                [],
            )

        stale_ids = [c.source_id for c in stale]
        warnings.append(
            f"Stale document(s) detected in citations: {stale_ids}. "
            "These may be superseded. Verify with the document owner."
        )

        if stale_count == len(citations):
            return (
                "STALE",
                f"All {stale_count} citation(s) are from outdated document versions.",
                stale_count,
                warnings,
            )

        return (
            "UNKNOWN",
            f"{stale_count} of {len(citations)} citation(s) are from outdated versions.",
            stale_count,
            warnings,
        )


# ──────────────────────────────────────────────
# Azure Function Entry Point
# ──────────────────────────────────────────────

def score_response(response_text: str, raw_citations: list) -> dict:
    """
    Callable from an Azure Function or internal backend call.

    Args:
        response_text:  The LLM-generated answer string.
        raw_citations:  List of dicts with keys:
                        source_id, chunk_id, relevance_score,
                        excerpt (optional), is_current_version (optional, default True)

    Example in your Azure Function:
        from governance.risk_scorer import score_response
        result = score_response(response_text, citations_from_rag)

    Returns a dict safe to serialize as JSON.
    """
    citations = [
        Citation(
            source_id=c.get("source_id", "unknown"),
            chunk_id=c.get("chunk_id", "unknown"),
            relevance_score=float(c.get("relevance_score", 0.0)),
            excerpt=c.get("excerpt"),
            is_current_version=bool(c.get("is_current_version", True)),
        )
        for c in raw_citations
    ]
    result = RiskScorer().score(response_text, citations)
    return result.to_dict()