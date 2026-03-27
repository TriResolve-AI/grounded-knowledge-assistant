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
    // Create audit record for this RAG request
    const auditRecord = {
      action: "rag_query",
      query,
      userId: userId || "anonymous",
      sessionId: sessionId || null,
      method: req.method,
      path: req.path,
      userAgent: req.get("user-agent") || null,
      status: "success"
    };

    // Write audit record
    await auditService.writeAuditRecord(auditRecord);

    // TODO: Integrate with actual RAG pipeline and governance checks
    // For now, return a placeholder response
    res.json({
      message: "RAG query processed",
      query,
      timestamp: new Date().toISOString(),
      auditId: auditRecord.requestId
    });
  } catch (error) {
    console.error("Error processing RAG query:", error);

    // Write failure audit record
    try {
      await auditService.writeAuditRecord({
        action: "rag_query",
        query,
        userId: userId || "anonymous",
        sessionId: sessionId || null,
        status: "error",
        error: error.message
      });
    } catch (auditError) {
      console.error("Error writing failure audit record:", auditError);
    }

    res.status(500).json({ error: "Failed to process RAG query" });
  }
});

module.exports = router;
