// backend/routes/query.js
const express = require('express');
const router = express.Router();
const retrievalService = require('../services/retrievalService');
const openaiService = require('../services/openaiService');
const auditService = require('../services/auditService');
const governanceService = require('../services/governance');
const { v4: uuidv4 } = require('uuid');

/**
 * POST /query - Main query endpoint (compatible with original)
 * This now uses the new RAG flow with proper citations
 */
router.post('/', async (req, res) => {
  const startTime = Date.now();
  const requestId = uuidv4();
  const { query, role = "user" } = req.body;

  if (!query) {
    return res.status(400).json({
      success: false,
      error: "Missing query parameter",
      request_id: requestId
    });
  }

  console.log(`[QUERY:${requestId}] Role: ${role}, Query: "${query.substring(0, 100)}"`);

  try {
    // Step 1: Retrieve citations with metadata
    const citations = await retrievalService.retrieveCitations(query, {
      topK: 5,
      minSimilarity: 0.4
    });

    // Step 2: Calculate trust score
    let trustScore = 0;
    let decisionStatus = "BLOCK";
    let disclaimer = "";
    let message = "";

    if (citations.length === 0) {
      trustScore = 0;
      decisionStatus = "DEFER";
      disclaimer = "No relevant documents found in trusted sources.";
      message = "Unable to find sufficient evidence to answer this query.";
    } else {
      // Calculate average similarity
      const avgSimilarity = citations.reduce((sum, c) => sum + c.similarity_score, 0) / citations.length;
      const allActive = citations.every(c => c.is_active_version);
      const activeBoost = allActive ? 1.0 : 0.8;
      trustScore = Math.min(avgSimilarity * activeBoost, 1.0);
      
      // Apply governance
      const governanceInput = {
        query: query,
        trust_score: trustScore,
        citations: citations,
        role: role
      };
      
      const governanceOutput = await governanceService.evaluate(governanceInput);
      
      // Determine decision
      if (governanceOutput.decision === "BLOCK") {
        decisionStatus = "BLOCK";
        disclaimer = governanceOutput.disclaimer || "Response blocked by governance rules.";
        message = governanceOutput.message || "Query violates governance policies.";
        trustScore = 0;
      } else if (governanceOutput.decision === "DEFER") {
        decisionStatus = "DEFER";
        disclaimer = governanceOutput.disclaimer || "Response requires human review.";
        message = governanceOutput.message || "Query triggered warning rules.";
      } else if (trustScore >= 0.75) {
        decisionStatus = "ALLOW";
        disclaimer = "Response generated from trusted, active documents.";
        message = "High confidence answer.";
      } else if (trustScore >= 0.55) {
        decisionStatus = "REDACT";
        disclaimer = "Response may require review - moderate confidence.";
        message = "Answer generated but confidence is moderate.";
      } else {
        decisionStatus = "DEFER";
        disclaimer = "Low confidence response - recommend human review.";
        message = "Evidence is weak or uses outdated sources.";
      }
    }

    // Step 3: Generate answer if allowed
    let answer = "";
    if (decisionStatus !== "BLOCK" && citations.length > 0) {
      try {
        answer = await openaiService.generateGroundedAnswer(query, citations);
      } catch (error) {
        console.error(`[QUERY:${requestId}] LLM error:`, error);
        answer = "Error generating answer. Please try again.";
        decisionStatus = "BLOCK";
        message = "Failed to generate answer.";
      }
    }

    // Step 4: Format response (keeping original format for compatibility)
    const processingTime = Date.now() - startTime;
    
    const response = {
      success: decisionStatus === "ALLOW" || decisionStatus === "REDACT",
      query: query,
      answer: answer,
      citations: citations.map(c => ({
        text: c.text,
        source: c.doc_id,
        chunk_id: c.chunk_id,
        similarity_score: c.similarity_score,
        version: c.metadata.doc_version,
        is_active: c.is_active_version
      })),
      trust_score: trustScore,
      decision: decisionStatus,
      disclaimer: disclaimer,
      message: message,
      processing_time_ms: processingTime,
      request_id: requestId
    };

    // Step 5: Write to audit log
    await auditService.writeAuditRecord(
      { query, role, request_id: requestId },
      {
        ...response,
        status: decisionStatus,
        citations: citations
      },
      {
        blocked_rule_ids: [],
        warned_rule_ids: []
      }
    );

    console.log(`[QUERY:${requestId}] Completed: ${decisionStatus} (${trustScore.toFixed(2)}) in ${processingTime}ms`);
    res.json(response);

  } catch (error) {
    console.error(`[QUERY:${requestId}] Error:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
      request_id: requestId
    });
  }
});

/**
 * POST /query/batch - Handle multiple queries
 */
router.post('/batch', async (req, res) => {
  const { queries } = req.body;
  
  if (!queries || !Array.isArray(queries)) {
    return res.status(400).json({
      success: false,
      error: "Missing or invalid queries array"
    });
  }
  
  const results = [];
  for (const query of queries) {
    const mockReq = { body: { query: query.query, role: query.role } };
    const mockRes = {
      json: (data) => results.push(data),
      status: () => mockRes
    };
    
    try {
      await router.handle(mockReq, mockRes);
    } catch (error) {
      results.push({ error: error.message, query: query.query });
    }
  }
  
  res.json({
    success: true,
    results: results
  });
});

module.exports = router;