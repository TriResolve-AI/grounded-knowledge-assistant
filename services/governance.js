// services/governance.js
// Governance and compliance control layer for RAG backend

class GovernanceFilter {
    constructor() {
        this.blockedPatterns = [
            { pattern: /ssn|social security number/i, category: 'PII_DETECTED' },
            { pattern: /password|credential|token|secret/i, category: 'ACCESS_DENIED' },
            { pattern: /drop\s+table|eval\(|prompt injection|ignore previous/i, category: 'PROMPT_INJECTION' }
        ];
    }

    async evaluate(query, user_role) {
        const cleaned = (query || '').toString().trim();
        if (!cleaned) {
            return { allowed: false, reason: 'Empty query' };
        }

        for (const blocked of this.blockedPatterns) {
            if (blocked.pattern.test(cleaned)) {
                return {
                    allowed: false,
                    reason: 'Query contains blocked content',
                    category: blocked.category
                };
            }
        }

        if (cleaned.length < 3) {
            return {
                allowed: false,
                reason: 'Query is out of scope',
                category: 'OUT_OF_SCOPE'
            };
        }

        const sanitized_query = cleaned.replace(/\s+/g, ' ');

        const defaultContext = {
            allowed_data_classes: ['public']
        };

        if (user_role === 'admin') {
            defaultContext.allowed_data_classes = ['public', 'private', 'confidential'];
        } else if (user_role === 'user') {
            defaultContext.allowed_data_classes = ['public', 'private'];
        } else if (user_role === 'auditor') {
            defaultContext.allowed_data_classes = ['public'];
        }

        return {
            allowed: true,
            reason: null,
            sanitized_query,
            policy_context: defaultContext
        };
    }
}

class Citation {
    constructor({ doc_id, chunk_id, similarity_score, is_active_version }) {
        this.doc_id = doc_id;
        this.chunk_id = chunk_id;
        this.similarity_score = similarity_score;
        this.is_active_version = Boolean(is_active_version);
    }
}

class RiskScore {
    constructor({ trust_score, hallucination_risk, citation_coverage }) {
        this.trust_score = trust_score;
        this.hallucination_risk = hallucination_risk;
        this.citation_coverage = citation_coverage;
    }

    to_dict() {
        return {
            trust_score: this.trust_score,
            hallucination_risk: this.hallucination_risk,
            citation_coverage: this.citation_coverage
        };
    }
}

class RiskScorer {
    async score(response_text, citations = []) {
        const baseScore = citations.length > 0 ? 0.6 : 0.35;
        const citationQuality = citations.filter(c => c.is_active_version).length / (citations.length || 1);
        const lengthFactor = Math.min(Math.max((response_text || '').length / 250, 0.1), 1);

        const trust_score = Math.min(1, baseScore + citationQuality * 0.25 + lengthFactor * 0.15);
        const hallucination_risk = 1 - trust_score;
        const citation_coverage = citations.length > 0 ? 1 : 0;

        return new RiskScore({ trust_score, hallucination_risk, citation_coverage });
    }
}

class ComplianceEngine {
    async evaluate({ query, response_text, risk_score_result, raw_citations, user_role }) {
        const trust = risk_score_result.trust_score || 0;
        let decision_status = 'BLOCK';
        let user_disclaimer = 'The response is blocked due to policy.';

        if (trust >= 0.75) {
            decision_status = 'ALLOW';
            user_disclaimer = 'Response is compliant.';
        } else if (trust >= 0.55) {
            decision_status = 'REDACT';
            user_disclaimer = 'Response is provided with redaction warning.';
        } else if (trust >= 0.40) {
            decision_status = 'DEFER';
            user_disclaimer = 'Response requires human review before release.';
        }

        const audit_entry = {
            timestamp: new Date().toISOString(),
            query,
            user_role,
            decision_status,
            trust_score: trust,
            citation_count: raw_citations.length,
            reason: user_disclaimer
        };

        return { decision_status, user_disclaimer, audit_entry };
    }
}

/**
 * Logs compliance events for audit trail
 * @param {string} eventType - Type of event (query, response, error)
 * @param {object} context - Event context data
 */
function auditLog(eventType, context) {
    const timestamp = new Date().toISOString();
    console.log(`[AUDIT] ${timestamp} | ${eventType}:`, JSON.stringify(context));
}

/**
 * Persists audit logs (mock implementation)
 */
async function saveAuditLog(auditEntry) {
    // In a production system this would write to a persistent log store (DB/S3/Blob store)
    console.log('[AUDIT] Saved audit entry:', JSON.stringify(auditEntry));
    return true;
}

async function validateQuery(query) {
    const filter = new GovernanceFilter();
    const result = await filter.evaluate(query, 'user');
    return {
        approved: result.allowed,
        reason: result.reason || null
    };
}

async function validateResponse(response, sourceDocument) {
    if (!response || typeof response !== 'string') {
        return {
            approved: false,
            reason: 'Response is empty or invalid'
        };
    }

    if (typeof sourceDocument !== 'string' || sourceDocument.trim().length === 0) {
        return {
            approved: false,
            reason: 'No source grounding provided'
        };
    }

    return {
        approved: true,
        response
    };
}

async function filterResults(results) {
    return results || [];
}

module.exports = {
    GovernanceFilter,
    RiskScorer,
    ComplianceEngine,
    Citation,
    validateQuery,
    validateResponse,
    filterResults,
    auditLog,
    saveAuditLog
};