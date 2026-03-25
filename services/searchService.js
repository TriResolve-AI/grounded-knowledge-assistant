const axios = require('axios');
const governance = require('./governance');
const openaiService = require('./openaiService');

/**
 * Search for governance tools using a query string.
 * Integrates with governance checks and OpenAI for semantic enhancement.
 * @param {string} query - The search query
 * @returns {Promise<Array>} - List of governance tools matching the query
 */
async function enrichToolLinks(tools, query) {
    const withoutUrl = tools.filter(t => !t.url);
    if (withoutUrl.length === 0) {
        return tools;
    }

    const prompt = `You are an AI assistant that converts governance tool names into real public website URLs.
Given a query: "${query}" and tool metadata in JSON with name + description, return a JSON array where each object includes id and url (either existing url or inferred high-confidence website). If you cannot infer, use an empty string. Do not include extra text.`;

    const dataForAI = withoutUrl.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description
    }));

    try {
        const augmentPrompt = `${prompt}\n\nTools:\n${JSON.stringify(dataForAI)}`;
        const aiResponse = await openaiService.callOpenAI(augmentPrompt, process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o');

        let parsed;
        try {
            parsed = JSON.parse(aiResponse);
        } catch (err) {
            console.warn('[SEARCH] could not parse AI URL response:', err.message);
            return tools;
        }

        const urlMap = new Map(parsed.map(item => [item.id, item.url]));

        return tools.map(tool => {
            if (tool.url) return tool;
            const candidate = urlMap.get(tool.id);
            return {
                ...tool,
                url: candidate || `https://example.com/tools/${tool.name.toLowerCase().replace(/\s+/g, '-')}`
            };
        });
    } catch (err) {
        console.warn('[SEARCH] URL enrichment failed:', err.message);
        return tools.map(tool => ({
            ...tool,
            url: tool.url || `https://example.com/tools/${tool.name.toLowerCase().replace(/\s+/g, '-')}`
        }));
    }
}

async function searchGovernanceTools(query) {
    try {
        // Validate query through governance layer
        const validation = await governance.validateQuery(query);
        if (!validation || !validation.approved) {
            throw new Error(validation?.reason || 'Query blocked by governance policy');
        }

        // Enhance query using OpenAI for semantic understanding
        let enhancedQuery;
        try {
            enhancedQuery = await openaiService.enhanceQuery(query);
        } catch (error) {
            console.warn('[SEARCH] Enhancement failed, using original query:', error.message);
            enhancedQuery = query;
        }

        // Query actual Azure Search index / fallback list
        const tools = await _queryToolsIndex(enhancedQuery);

        // Enrich missing tool URLs using Azure OpenAI inference
        const enrichedTools = await enrichToolLinks(tools, query);

        // Apply governance filtering to results
        const filteredTools = await governance.filterResults(enrichedTools);

        return filteredTools;
    } catch (error) {
        console.error('Search error:', error.message);
        throw error;
    }
}

/**
 * Internal: Query governance tools index
 * @param {string} query - Enhanced query string
 * @returns {Promise<Array>} - Raw search results
 */
async function _queryToolsIndex(query) {
    const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const key = process.env.AZURE_SEARCH_KEY;
    const indexName = process.env.AZURE_SEARCH_INDEX;
    const apiVersion = process.env.AZURE_SEARCH_API_VERSION || '2021-04-30-Preview';

    if (endpoint && key && indexName) {
        const searchUrl = `${endpoint.replace(/\/+$/, '')}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${apiVersion}`;
        try {
            const resp = await axios.post(
                searchUrl,
                {
                    search: query,
                    top: 10,
                    queryType: 'simple'
                },
                {
                    headers: {
                        'api-key': key,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (!resp.data || !Array.isArray(resp.data.value)) {
                console.warn('[SEARCH] Azure Search returned no value array', resp.data);
                return [];
            }

            return resp.data.value.map((item, idx) => ({
                id: item.id || idx + 1,
                name: item.name || item.title || `Tool ${idx + 1}`,
                description: item.description || item.summary || 'No description available',
                url: item.url || item.link || item.website || `https://example.com/tools/${(item.name || item.title || 'tool').toString().toLowerCase().replace(/\s+/g, '-')}`
            }));
        } catch (err) {
            console.error('[SEARCH] Azure Search query failed', err.message || err);
            // Fallback to static mock data when Azure search fails
        }
    }

    // Fallback static dataset with real governance/compliance tools
    return [
        {
            id: 1,
            name: 'Microsoft Compliance Manager',
            description: 'Helps organizations comply with global, local, and industry regulations',
            url: 'https://learn.microsoft.com/microsoft-365/compliance/compliance-manager-overview'
        },
        {
            id: 2,
            name: 'OneTrust',
            description: 'Privacy, security and third-party risk management platform with compliance automation features',
            url: 'https://www.onetrust.com/'
        },
        {
            id: 3,
            name: 'ServiceNow GRC',
            description: 'Governance, Risk and Compliance solution integrated in enterprise workflows',
            url: 'https://www.servicenow.com/products/governance-risk-and-compliance.html'
        },
        {
            id: 4,
            name: 'Diligent Compliance',
            description: 'Risk and compliance management software for regulated industries',
            url: 'https://www.diligent.com/risk/compliance/'
        },
        {
            id: 5,
            name: 'SAP GRC',
            description: 'Integrated solution for governance, risk management, and compliance',
            url: 'https://www.sap.com/products/governance-risk-compliance.html'
        }
    ];
}

async function runVectorSearch(sanitizedQuery, allowed_classes = ['public']) {
    console.log('[SEARCH] running vector search', { sanitizedQuery, allowed_classes });

    // Mock vector results (in real system, apply allowed_classes filter)
    return [
        { doc_id: 'doc-101', chunk_id: 'chunk-1', similarity_score: 0.92, is_active_version: true, text: 'This is the authoritative answer for query part 1.' },
        { doc_id: 'doc-102', chunk_id: 'chunk-2', similarity_score: 0.85, is_active_version: true, text: 'Supporting context for compliance and governance.' }
    ];
}

async function generateLLMAnswer(sanitizedQuery, raw_citations) {
    const citationText = raw_citations && raw_citations.length > 0
        ? raw_citations.map((c, idx) => `${idx + 1}. [${c.doc_id}:${c.chunk_id}] ${c.text || ''}`).join('\n')
        : 'No citations available.';

    const prompt = `User query: ${sanitizedQuery}\n\nEvidence:\n${citationText}\n\nGenerate a concise, grounded response based on the evidence.`;

    if (!process.env.OPENAI_API_KEY) {
        console.warn('[SEARCH] OPENAI_API_KEY not set; using mock response for testing');
        return `Mock response for query: ${sanitizedQuery}. Evidence: ${citationText}`;
    }

    return await openaiService.callOpenAI(prompt);
}

async function processUserQuery(user_query, user_role) {
    try {
        const filterEngine = new governance.GovernanceFilter();
        const filterResult = await filterEngine.evaluate(user_query, user_role);

        if (!filterResult.allowed) {
            return {
                status: 'blocked',
                reason: filterResult.reason
            };
        }

        const sanitized_query = filterResult.sanitized_query;
        const allowed_data_classes = filterResult.policy_context.allowed_data_classes;

        const raw_citations = await runVectorSearch(sanitized_query, allowed_data_classes);
        const llm_draft_response = await generateLLMAnswer(sanitized_query, raw_citations);

        const formatted_citations = raw_citations.map(c => new governance.Citation({
            source_id: c.doc_id,
            chunk_id: c.chunk_id,
            relevance_score: c.similarity_score,
            is_current_version: c.is_active_version
        }));

        const risk_engine = new governance.RiskScorer();
        const risk_score = await risk_engine.score(llm_draft_response, formatted_citations);
        const risk_dict = risk_score.to_dict();

        const compliance_engine = new governance.ComplianceEngine();
        const compliance_report = await compliance_engine.evaluate({
            query: sanitized_query,
            response_text: llm_draft_response,
            risk_score_result: risk_dict,
            raw_citations,
            user_role
        });

        await governance.saveAuditLog(compliance_report.audit_entry);
        governance.auditLog('RAG_PROCESS', {
            query: sanitized_query,
            user_role,
            decision: compliance_report.decision_status,
            trust_score: risk_dict.trust_score
        });

        if (compliance_report.decision_status === 'ALLOW') {
            return {
                status: 'success',
                answer: llm_draft_response,
                trust_score: risk_dict.trust_score,
                citations: raw_citations
            };
        } else if (compliance_report.decision_status === 'REDACT') {
            return {
                status: 'warning',
                answer: llm_draft_response,
                disclaimer: compliance_report.user_disclaimer,
                trust_score: risk_dict.trust_score
            };
        } else if (compliance_report.decision_status === 'DEFER') {
            return {
                status: 'escalated',
                message: 'This query requires human-in-the-loop review.',
                disclaimer: compliance_report.user_disclaimer
            };
        }

        return {
            status: 'blocked',
            message: compliance_report.user_disclaimer
        };
    } catch (error) {
        console.error('[RAG] processUserQuery error', error.message);
        return {
            status: 'error',
            message: 'Internal processing error',
            detail: error.message
        };
    }
}

module.exports = {
    searchGovernanceTools,
    processUserQuery,
    runVectorSearch,
    generateLLMAnswer
};