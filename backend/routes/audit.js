const express = require("express");
const router = express.Router();
const auditService = require("../services/auditService");

/**
 * GET /audit-log - Retrieve live audit records
 * Query params: limit (default 100), offset (default 0)
 */
router.get("/audit-log", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const auditData = await auditService.getAuditRecords(limit, offset);

    res.json({
      success: true,
      data: auditData
    });
  } catch (error) {
    console.error("Error retrieving audit logs:", error);
    res.status(500).json({ error: "Failed to retrieve audit logs" });
  }
});

/**
 * GET /audit-log/schema - Retrieve the audit log schema from Azure Blob
 */
router.get("/audit-log/schema", async (req, res) => {
  try {
    const schema = await auditService.getLockedAuditSchema();
    res.json({
      success: true,
      schema
    });
  } catch (error) {
    console.error("Error retrieving audit schema:", error);
    res.status(500).json({ error: "Failed to retrieve audit schema" });
  }
});

module.exports = router;
