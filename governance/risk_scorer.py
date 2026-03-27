"""
governance/risk_scorer.py
CiteGuard AI — Response Risk Scorer
Owner: Neha (AI Governance & Risk)

Runs AFTER the RAG pipeline generates a response.
Scores the response on confidence, citation strength, and risk level.
Designed for Azure Functions integration.

CHANGES FROM PREVIOUS VERSION (aligned to Final Architecture Lock Note):
  - Citation dataclass field names updated to match locked contract
    (architecture lock note §4-D):
        source_id          → doc_id
        relevance_score    → similarity_score
        is_current_version → is_active_version
        excerpt            → text
  - trust_score output changed from 0–100 integer → 0.0–1.0 float
    to match locked decision thresholds (architecture lock note §5)
  - _compute_trust_score() weights updated to produce 0.0–1.0 output
  - to_dict() rounds trust_score to 4 decimal places for audit log
  - score_response() entry point maps incoming citation dicts using
    the new locked field names
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
MIN_CITATIONS_FOR_MED_CONFIDENCE  = 1

# Relevance score thresholds (from vector DB similarity, 0.0–1.0)
HIGH_RELEVANCE_THRESHOLD = 0.80
MED_RELEVANCE_THRESHOLD  = 0.60

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
    """
    Represents a single source citation returned by the RAG pipeline.

    Field names match the locked citation object contract
    (architecture lock note §4-D). No field renaming without approval.
    """
    doc_id: str               # Document ID or filename (was: source_id)
    chunk_id: str             # Specific chunk ID
    similarity_score: float   # Cosine similarity score 0.0–1.0 (was: relevance_score)
    text: Optional[str] = None            # Text excerpt from the chunk (was: excerpt)
    # Architecture §5: F = freshness and version confidence
    # Set to False if document is expired or superseded
    is_active_version: bool = True        # (was: is_current_version)


@dataclass
class RiskScore:
    """
    Full risk assessment result for a generated response.

    Trust score is on a 0.0–1.0 float scale to match the locked
    decision thresholds (architecture lock note §5):
        ALLOW  >= 0.75
        REDACT >= 0.55
        DEFER  >= 0.40
        BLOCK   < 0.40

    Trust formula from architecture §5:
        T = wR·R + wC·C + wP·P + wF·F
    where R=retrieval quality, C=citation completeness,
    P=policy pass strength, F=freshness/version confidence.
    """
    # Overall trust score (0.0–1.0 float — matches locked decision thresholds)
    trust_score: float

    # Sub-scores (map to formula components)
    confidence_level: str    # R — "HIGH" | "MEDIUM" | "LOW"
    citation_strength: str   # C — "STRONG" | "MODERATE" | "WEAK" | "NONE"
    risk_flag: str           # P — "HIGH" | "MEDIUM" | "LOW" | "NONE"
    freshness_flag: str      # F — "CURRENT" | "STALE" | "UNKNOWN"

    # Numeric components (for transparency / explainability layer)
    citation_count: int
    avg_similarity_score: float       # (was: avg_relevance_score)
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
            # Trust score on 0.0–1.0 scale for locked threshold comparisons
            "trust_score": round(self.trust_score, 4),
            "confidence_level": self.confidence_level,
            "citation_strength": self.citation_strength,
            "risk_flag": self.risk_flag,
            "freshness_flag": self.freshness_flag,
            "citation_count": self.citation_count,
            # Locked field name (was avg_relevance_score)
            "avg_similarity_score": round(self.avg_similarity_score, 3),
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
        score  = scorer.score(response_text, citations)

    Usage (Azure Function):
        from governance.risk_scorer import score_response
        result = score_response(response_text, citations)

    trust_score in the returned dict is always 0.0–1.0 float.
    Pass directly into ComplianceEngine.evaluate() — no conversion needed.
    """

    def score(self, response_text: str, citations: list[Citation]) -> RiskScore:
        """
        Main entry point. Evaluates response + citations and returns a RiskScore.

        Args:
            response_text: The LLM-generated answer string.
            citations:     List of Citation objects (using locked field names).

        Returns:
            RiskScore dataclass with trust_score on 0.0–1.0 scale.
        """
        logger.info(f"[RiskScorer] Scoring response with {len(citations)} citation(s).")

        warnings = []

        # ── 1. Citation Strength (C) ──────────────────────────────────────
        citation_count = len(citations)
        avg_similarity = self._avg_similarity(citations)
        citation_strength, citation_reason = self._score_citations(
            citation_count, avg_similarity
        )

        # ── 2. Confidence Level (R) ───────────────────────────────────────
        confidence_level, confidence_reason = self._score_confidence(
            response_text, citation_count, avg_similarity
        )

        # ── 3. Risk Flag (P) ──────────────────────────────────────────────
        risk_flag, risk_reason, risk_warnings = self._score_risk(response_text)
        warnings.extend(risk_warnings)

        # ── 4. Freshness / Version Confidence (F) ────────────────────────
        freshness_flag, freshness_reason, stale_count, fresh_warnings = \
            self._score_freshness(citations)
        warnings.extend(fresh_warnings)

        # ── 5. Compute Overall Trust Score (0.0–1.0) ─────────────────────
        trust_score = self._compute_trust_score(
            citation_strength, confidence_level, risk_flag, freshness_flag
        )

        logger.info(
            f"[RiskScorer] Trust: {trust_score:.4f} | "
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
            avg_similarity_score=avg_similarity,
            stale_citation_count=stale_count,
            confidence_reason=confidence_reason,
            citation_reason=citation_reason,
            risk_reason=risk_reason,
            freshness_reason=freshness_reason,
            warnings=warnings,
        )

    # ── Sub-Scorers ───────────────────────────────────────────────────────

    def _avg_similarity(self, citations: list[Citation]) -> float:
        """Average similarity_score across all citations (locked field name)."""
        if not citations:
            return 0.0
        return sum(c.similarity_score for c in citations) / len(citations)

    def _score_citations(
        self, count: int, avg_similarity: float
    ) -> tuple[str, str]:
        if count == 0:
            return (
                "NONE",
                "No source documents were retrieved. Response is ungrounded.",
            )
        if count >= MIN_CITATIONS_FOR_HIGH_CONFIDENCE and avg_similarity >= HIGH_RELEVANCE_THRESHOLD:
            return (
                "STRONG",
                f"{count} citation(s) with avg similarity {avg_similarity:.2f} — well grounded.",
            )
        if count >= MIN_CITATIONS_FOR_MED_CONFIDENCE and avg_similarity >= MED_RELEVANCE_THRESHOLD:
            return (
                "MODERATE",
                f"{count} citation(s) with avg similarity {avg_similarity:.2f} — moderately grounded.",
            )
        return (
            "WEAK",
            f"{count} citation(s) but similarity score ({avg_similarity:.2f}) is low.",
        )

    def _score_confidence(
        self, response_text: str, count: int, avg_similarity: float
    ) -> tuple[str, str]:
        text_lower = response_text.lower()

        for phrase in UNCERTAINTY_PHRASES:
            if phrase in text_lower:
                return (
                    "LOW",
                    f"Response contains uncertainty phrase: '{phrase}'.",
                )

        if count >= MIN_CITATIONS_FOR_HIGH_CONFIDENCE and avg_similarity >= HIGH_RELEVANCE_THRESHOLD:
            return (
                "HIGH",
                "Response is well-supported by multiple high-similarity sources.",
            )
        if count >= MIN_CITATIONS_FOR_MED_CONFIDENCE and avg_similarity >= MED_RELEVANCE_THRESHOLD:
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
    ) -> float:
        """
        Weighted trust formula — architecture doc §5:
            T = wR·R + wC·C + wP·P + wF·F

        Output is 0.0–1.0 float to match locked decision thresholds:
            ALLOW  >= 0.75
            REDACT >= 0.55
            DEFER  >= 0.40
            BLOCK   < 0.40

        Weight distribution (sums to 1.0):
            R (retrieval/confidence) : 0.35
            C (citation strength)    : 0.35
            P (policy/risk penalty)  : 0.20 (deducted)
            F (freshness)            : 0.10
        """
        confidence_points = {"HIGH": 0.35, "MEDIUM": 0.22, "LOW": 0.08}
        citation_points   = {"STRONG": 0.35, "MODERATE": 0.22, "WEAK": 0.08, "NONE": 0.0}
        risk_deduction    = {"LOW": 0.0, "MEDIUM": 0.10, "HIGH": 0.20, "NONE": 0.0}
        freshness_points  = {"CURRENT": 0.10, "UNKNOWN": 0.05, "STALE": 0.0}

        score = (
            confidence_points.get(confidence_level, 0.0)
            + citation_points.get(citation_strength, 0.0)
            + freshness_points.get(freshness_flag, 0.05)
            - risk_deduction.get(risk_flag, 0.0)
        )
        # Clamp to [0.0, 1.0]
        return max(0.0, min(1.0, score))

    def _score_freshness(self, citations: list[Citation]) -> tuple:
        """
        Checks whether retrieved citations are active-version documents.

        Uses is_active_version (locked field name, was is_current_version).
        Architecture §5: F = freshness and version confidence.
        Compliance doc §3.2: freshness checks against document effective/expiry dates.
        Returns (freshness_flag, reason, stale_count, warnings).
        """
        if not citations:
            return "UNKNOWN", "No citations to assess freshness.", 0, []

        # is_active_version is the locked field name (was is_current_version)
        stale = [c for c in citations if not c.is_active_version]
        stale_count = len(stale)
        warnings = []

        if stale_count == 0:
            return (
                "CURRENT",
                f"All {len(citations)} citation(s) are from active document versions.",
                0,
                [],
            )

        stale_ids = [c.doc_id for c in stale]  # locked field name (was source_id)
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
    Callable from an Azure Function or backend pipeline step.

    Args:
        response_text:  The LLM-generated answer string.
        raw_citations:  List of dicts using the locked citation field names
                        (architecture lock note §4-D):
                            doc_id            (was: source_id)
                            chunk_id
                            similarity_score  (was: relevance_score)
                            text              (was: excerpt, optional)
                            is_active_version (was: is_current_version, default True)

    Returns a dict safe to serialise as JSON.
    trust_score in the returned dict is 0.0–1.0 float — pass directly
    into check_compliance() without any conversion.
    """
    citations = [
        Citation(
            doc_id=c.get("doc_id", "unknown"),              # locked field name
            chunk_id=c.get("chunk_id", "unknown"),
            similarity_score=float(c.get("similarity_score", 0.0)),  # locked field name
            text=c.get("text"),                              # locked field name
            is_active_version=bool(c.get("is_active_version", True)),  # locked field name
        )
        for c in raw_citations
    ]
    result = RiskScorer().score(response_text, citations)
    return result.to_dict()
