"""
governance/filter.py
CiteGuard AI — Query Governance Filter
Owner: Neha (AI Governance & Risk)

Runs BEFORE the query reaches the LLM / RAG pipeline.
Checks:
  - Query length / empty
  - PII detection
  - Prompt injection / jailbreak
  - Out-of-scope topics
  - Role-based access admissibility  (architecture §3.3, compliance §3.4)
  - Sensitive topic advisory

Designed for Azure Functions integration.
"""

import re
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────
# Role / Access Policy
# ──────────────────────────────────────────────
# Maps user roles to the data classification levels they may query.
# Extend this as your RBAC/ABAC policy evolves.
# Architecture doc §3.3: "Apply query-time policy filters (role, region, data class)"
# Compliance doc §3.4: "User authentication and RBAC/ABAC policy evaluation"

ROLE_ALLOWED_DATA_CLASSES: dict[str, list[str]] = {
    "admin":    ["public", "internal", "confidential", "restricted"],
    "analyst":  ["public", "internal", "confidential"],
    "viewer":   ["public", "internal"],
    "guest":    ["public"],
}

# Data classification keywords — used to detect what class a query is touching
DATA_CLASS_SIGNALS: dict[str, str] = {
    "restricted":    "restricted",
    "top secret":    "restricted",
    "highly confidential": "restricted",
    "confidential":  "confidential",
    "privileged":    "confidential",
    "attorney-client": "confidential",
    "trade secret":  "confidential",
    "internal":      "internal",
    "proprietary":   "internal",
}


# ──────────────────────────────────────────────
# Data Classes
# ──────────────────────────────────────────────

@dataclass
class FilterResult:
    """Result returned by the governance filter."""
    allowed: bool                          # True = query can proceed
    reason: Optional[str] = None           # Why it was blocked (if blocked)
    category: Optional[str] = None         # Block category label
    sanitized_query: Optional[str] = None  # Cleaned query (if allowed)
    warnings: list = field(default_factory=list)   # Non-blocking advisory notes
    # Passed downstream so the retrieval layer can apply role + data-class filters
    # Architecture §3.3 / Compliance §3.4
    policy_context: dict = field(default_factory=dict)


# ──────────────────────────────────────────────
# Block Lists & Patterns
# ──────────────────────────────────────────────

# Topics that are completely out of scope for a regulated document assistant
OUT_OF_SCOPE_KEYWORDS = [
    "weather", "sports", "recipe", "movie", "song", "joke",
    "stock price", "crypto", "dating", "gaming", "social media",
    "celebrity", "news headlines", "horoscope",
]

# PII patterns — should never be submitted as part of a query
PII_PATTERNS = [
    r"\b\d{3}-\d{2}-\d{4}\b",           # SSN
    r"\b\d{16}\b",                        # Credit card (16 digits)
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b",  # Email
    r"\b\d{10}\b",                        # Phone number (10 digits)
    r"\bpassword\s*[:=]\s*\S+",          # Passwords
]

# Prompt injection / jailbreak attempts
INJECTION_PATTERNS = [
    r"ignore (all |previous |your )?(instructions|rules|guidelines)",
    r"forget (everything|all instructions|your role)",
    r"you are now",
    r"pretend (you are|to be)",
    r"act as (a|an) (?!analyst|assistant|reviewer)",  # Allows legit roles
    r"bypass (safety|compliance|filter|rules)",
    r"do not (follow|apply|use) (the )?(rules|guidelines|policy)",
    r"jailbreak",
    r"DAN mode",
    r"developer mode",
    r"override (governance|compliance|safety)",
]

# Personally sensitive regulated content that needs a warning (not a block)
SENSITIVE_TOPIC_KEYWORDS = [
    "patient name", "medical record", "diagnosis", "treatment plan",
    "client account", "confidential", "privileged", "attorney-client",
    "trade secret", "proprietary",
]

# Minimum and maximum query lengths
MIN_QUERY_LENGTH = 5
MAX_QUERY_LENGTH = 1000


# ──────────────────────────────────────────────
# Core Filter Class
# ──────────────────────────────────────────────

class GovernanceFilter:
    """
    Pre-LLM query filter for CiteGuard AI.

    Usage (standalone):
        gf = GovernanceFilter()
        result = gf.evaluate(query, user_role="analyst")

    Usage (Azure Function):
        role = req.headers.get("X-User-Role", "guest")
        result = GovernanceFilter().evaluate(req.params.get("query", ""), user_role=role)
        if not result.allowed:
            return func.HttpResponse(result.reason, status_code=400)
    """

    def evaluate(self, query: str, user_role: str = "viewer") -> FilterResult:
        """
        Main entry point. Runs all checks in order.
        Returns FilterResult with allowed=True or False.

        Args:
            query:     Raw user query string.
            user_role: Role from auth layer (e.g. "admin", "analyst", "viewer", "guest").
                       Defaults to "viewer" (safest assumption).
        """
        logger.info(f"[GovernanceFilter] Evaluating query (len={len(query)}, role={user_role})")

        # 1. Basic length / empty check
        length_check = self._check_length(query)
        if not length_check.allowed:
            return length_check

        # 2. PII detection — hard block
        pii_check = self._check_pii(query)
        if not pii_check.allowed:
            return pii_check

        # 3. Prompt injection — hard block
        injection_check = self._check_injection(query)
        if not injection_check.allowed:
            return injection_check

        # 4. Out-of-scope topics — hard block
        scope_check = self._check_scope(query)
        if not scope_check.allowed:
            return scope_check

        # 5. Role-based data class access — hard block if role can't access detected class
        # Architecture §3.3: query-time policy filters (role, region, data class)
        role_check, detected_data_class = self._check_role_access(query, user_role)
        if not role_check.allowed:
            return role_check

        # 6. Sensitive topic advisory — soft warning only
        warnings = self._check_sensitive_topics(query)

        # 7. Sanitize the query (strip extra whitespace, normalize)
        sanitized = self._sanitize(query)

        # Build policy context for downstream retrieval layer
        allowed_classes = ROLE_ALLOWED_DATA_CLASSES.get(user_role, ["public"])
        policy_context = {
            "user_role": user_role,
            "allowed_data_classes": allowed_classes,
            "detected_data_class": detected_data_class,
        }

        logger.info(f"[GovernanceFilter] Query approved. Policy context: {policy_context}")
        return FilterResult(
            allowed=True,
            sanitized_query=sanitized,
            warnings=warnings,
            policy_context=policy_context,
        )

    # ── Individual Checks ──────────────────────

    def _check_length(self, query: str) -> FilterResult:
        stripped = query.strip()
        if not stripped:
            return FilterResult(
                allowed=False,
                reason="Query is empty. Please enter a question.",
                category="EMPTY_QUERY",
            )
        if len(stripped) < MIN_QUERY_LENGTH:
            return FilterResult(
                allowed=False,
                reason=f"Query too short (minimum {MIN_QUERY_LENGTH} characters).",
                category="QUERY_TOO_SHORT",
            )
        if len(stripped) > MAX_QUERY_LENGTH:
            return FilterResult(
                allowed=False,
                reason=f"Query exceeds maximum length of {MAX_QUERY_LENGTH} characters.",
                category="QUERY_TOO_LONG",
            )
        return FilterResult(allowed=True)

    def _check_pii(self, query: str) -> FilterResult:
        for pattern in PII_PATTERNS:
            if re.search(pattern, query, re.IGNORECASE):
                logger.warning("[GovernanceFilter] PII detected in query.")
                return FilterResult(
                    allowed=False,
                    reason=(
                        "Your query appears to contain personal or sensitive data "
                        "(e.g. SSN, email, phone). Please remove it and try again."
                    ),
                    category="PII_DETECTED",
                )
        return FilterResult(allowed=True)

    def _check_injection(self, query: str) -> FilterResult:
        for pattern in INJECTION_PATTERNS:
            if re.search(pattern, query, re.IGNORECASE):
                logger.warning("[GovernanceFilter] Prompt injection attempt detected.")
                return FilterResult(
                    allowed=False,
                    reason=(
                        "Your query contains language that attempts to override "
                        "system guidelines. This is not permitted."
                    ),
                    category="PROMPT_INJECTION",
                )
        return FilterResult(allowed=True)

    def _check_scope(self, query: str) -> FilterResult:
        lower = query.lower()
        for keyword in OUT_OF_SCOPE_KEYWORDS:
            if keyword in lower:
                return FilterResult(
                    allowed=False,
                    reason=(
                        f"This assistant only answers questions grounded in your "
                        f"uploaded documents. The topic '{keyword}' is out of scope."
                    ),
                    category="OUT_OF_SCOPE",
                )
        return FilterResult(allowed=True)

    def _check_role_access(self, query: str, user_role: str) -> tuple:
        """
        Detects if the query touches a data classification the user role
        is not permitted to access.
        Returns (FilterResult, detected_data_class_or_None).
        Compliance doc §3.4: RBAC/ABAC policy evaluation at query time.
        """
        allowed_classes = ROLE_ALLOWED_DATA_CLASSES.get(user_role, ["public"])
        lower = query.lower()
        detected_class = None

        for signal, data_class in DATA_CLASS_SIGNALS.items():
            if signal in lower:
                detected_class = data_class
                if data_class not in allowed_classes:
                    logger.warning(
                        f"[GovernanceFilter] Role '{user_role}' attempted to access "
                        f"'{data_class}' data (signal: '{signal}')."
                    )
                    return (
                        FilterResult(
                            allowed=False,
                            reason=(
                                f"Your role ('{user_role}') does not have access to "
                                f"'{data_class}' classified content. "
                                "Contact your administrator if you believe this is an error."
                            ),
                            category="ACCESS_DENIED",
                        ),
                        detected_class,
                    )
                break  # Only flag the highest-sensitivity class found

        return FilterResult(allowed=True), detected_class

    def _check_sensitive_topics(self, query: str) -> list:
        warnings = []
        lower = query.lower()
        for keyword in SENSITIVE_TOPIC_KEYWORDS:
            if keyword in lower:
                warnings.append(
                    f"Advisory: Query references '{keyword}'. "
                    "Ensure only approved documents are in the knowledge base."
                )
        return warnings

    def _sanitize(self, query: str) -> str:
        """Strip extra whitespace and normalize line breaks."""
        return " ".join(query.split())


# ──────────────────────────────────────────────
# Azure Function Entry Point
# ──────────────────────────────────────────────

def run_filter(query: str, user_role: str = "viewer") -> dict:
    """
    Callable from an Azure Function HTTP trigger.

    Args:
        query:     Raw user query string.
        user_role: Role from the auth/identity layer (e.g. "analyst", "viewer").
                   Pass via request header: req.headers.get("X-User-Role", "viewer")

    Example in your Azure Function:
        from governance.filter import run_filter
        role   = req.headers.get("X-User-Role", "viewer")
        result = run_filter(req.params.get("query", ""), user_role=role)
        if not result["allowed"]:
            return func.HttpResponse(result["reason"], status_code=400)

    Returns a dict safe to serialize as JSON in an HttpResponse.
    The policy_context key should be forwarded to the retrieval layer.
    """
    result = GovernanceFilter().evaluate(query, user_role=user_role)
    return {
        "allowed": result.allowed,
        "reason": result.reason,
        "category": result.category,
        "sanitized_query": result.sanitized_query,
        "warnings": result.warnings,
        "policy_context": result.policy_context,  # Forward to retrieval layer
    }