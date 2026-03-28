const express = require("express");
const router = express.Router();
const auditService = require("../services/auditService");

/**
 * POST /rag - Query the RAG system and log audit record
 * Expected body: { query: string, ... }
 */
router.post("/rag", async (req, res) => {
  const { query, userId, sessionId } = req.body;

  // Validate request
  if (!query) {
    return res.status(400).json({ error: "Query is required" });
  }

  try {
    // Create a schema-compliant audit record with safe defaults for fields that
    // cannot yet be determined (RAG pipeline not integrated in this route).
    const auditRecord = {
      full_query: query,
      full_response: '',
      decision_status: 'pending',
      trust_score: 0,
      risk_score: 1,
      allow_flag: false,
      allowed_data_class: 'public',
      detected_data_class: 'public',
      conform_access_flag: false,
      violation_access_flag: false,
      sensitive_data_flag: false,
      prompt_abuse_flag: false,
      citation_insufficient_flag: true,
      blocked_rules_flag: false,
      warned_rules_flag: false,
      blocked_rule_ids: [],
      warned_rule_ids: [],
      citation_count: 0,
      citations: [],
      userId: userId || "anonymous",
      sessionId: sessionId || null,
      method: req.method,
      path: req.path,
      userAgent: req.get("user-agent") || null,
      status: "success"
    };

    // Write audit record and capture the returned record (which has request_id)
    const writtenRecord = await auditService.writeAuditRecord(auditRecord);

    // TODO: Integrate with actual RAG pipeline and governance checks
    // For now, return a placeholder response
    res.json({
      message: "RAG query processed",
      query,
      timestamp: new Date().toISOString(),
      auditId: writtenRecord.request_id
    });
  } catch (error) {
    console.error("Error processing RAG query:", error);

    // Write failure audit record
    try {
      await auditService.writeAuditRecord({
        full_query: query,
        full_response: '',
        decision_status: 'error',
        trust_score: 0,
        risk_score: 1,
        allow_flag: false,
        allowed_data_class: 'public',
        detected_data_class: 'public',
        conform_access_flag: false,
        violation_access_flag: true,
        sensitive_data_flag: false,
        prompt_abuse_flag: false,
        citation_insufficient_flag: true,
        blocked_rules_flag: true,
        warned_rules_flag: false,
        blocked_rule_ids: [],
        warned_rule_ids: [],
        citation_count: 0,
        citations: [],
        userId: userId || "anonymous",
        sessionId: sessionId || null,
        status: "error",
        errorMessage: error.message
      });
    } catch (auditError) {
      console.error("Error writing failure audit record:", auditError);
    }

    res.status(500).json({ error: "Failed to process RAG query" });
  }
});

module.exports = router;
