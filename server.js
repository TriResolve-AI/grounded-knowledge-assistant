require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Import services
const searchService = require('./services/searchService');
const governance = require('./services/governance');
const auditService = require('./services/auditService');

// Debug log to confirm execution
console.log("Starting server...");

// Health route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Backend is running",
    port: process.env.PORT
  });
});

// Query route for searching governance tools
app.post("/query", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const results = await searchService.searchGovernanceTools(query);
    res.json({ results });
  } catch (error) {
    console.error("Query error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Govern route for validation
app.post("/govern", async (req, res) => {
  try {
    const { type, content } = req.body;
    if (!type || !content) {
      return res.status(400).json({ error: "Type and content are required" });
    }

    let result;
    if (type === 'query') {
      result = await governance.validateQuery(content);
    } else if (type === 'response') {
      result = await governance.validateResponse(content, req.body.sourceDocument || '');
    } else {
      return res.status(400).json({ error: "Invalid type. Use 'query' or 'response'" });
    }

    res.json(result);
  } catch (error) {
    console.error("Govern error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// RAG pipeline route for full governance + search
app.post('/rag', async (req, res) => {
  try {
    const { query, user_role } = req.body;
    if (!query || !user_role) {
      return res.status(400).json({ error: 'query and user_role are required' });
    }

    const result = await searchService.processUserQuery(query, user_role);

    const auditRecord = {
      timestamp: new Date().toISOString(),
      request_id: result.request_id,
      full_query: query,
      full_response: result.answer || '',
      decision_status: result.decision_status || 'BLOCK',
      trust_score: result.trust_score ?? 0,
      risk_score: result.risk_score ?? 1,
      allow_flag: result.flags?.allow_flag ?? false,
      allowed_data_class: result.flags?.allowed_data_class || 'public',
      detected_data_class: result.flags?.detected_data_class || 'public',
      conform_access_flag: result.flags?.conform_access_flag ?? false,
      violation_access_flag: result.flags?.violation_access_flag ?? true,
      sensitive_data_flag: result.flags?.sensitive_data_flag ?? false,
      prompt_abuse_flag: result.flags?.prompt_abuse_flag ?? false,
      citation_insufficient_flag: result.flags?.citation_insufficient_flag ?? true,
      blocked_rules_flag: result.flags?.blocked_rules_flag ?? false,
      warned_rules_flag: result.flags?.warned_rules_flag ?? false,
      blocked_rule_ids: result.blocked_rule_ids || [],
      warned_rule_ids: result.warned_rule_ids || [],
      citation_count: Array.isArray(result.citations) ? result.citations.length : 0,
      citations: result.citations || []
    };

    await auditService.writeAuditRecord(auditRecord);

    if (result.status === 'error') {
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('RAG error:', error.message);
    
    // Write error audit record
    try {
      await auditService.writeAuditRecord({
        action: 'rag_query',
        status: 'error',
        errorMessage: error.message
      });
    } catch (auditError) {
      console.error('Error writing error audit record:', auditError);
    }

    res.status(500).json({ error: error.message });
  }
});

// Convenience GET route for quick browser testing
app.get('/rag', async (req, res) => {
  try {
    const query = req.query.query || req.body?.query;
    const user_role = req.query.user_role || req.body?.user_role;

    if (!query || !user_role) {
      return res.status(400).json({
        error: 'query and user_role are required (via query params or JSON body)'
      });
    }

    const result = await searchService.processUserQuery(query, user_role);

    await auditService.writeAuditRecord({
      timestamp: new Date().toISOString(),
      request_id: result.request_id,
      full_query: query,
      full_response: result.answer || '',
      decision_status: result.decision_status || 'BLOCK',
      trust_score: result.trust_score ?? 0,
      risk_score: result.risk_score ?? 1,
      allow_flag: result.flags?.allow_flag ?? false,
      allowed_data_class: result.flags?.allowed_data_class || 'public',
      detected_data_class: result.flags?.detected_data_class || 'public',
      conform_access_flag: result.flags?.conform_access_flag ?? false,
      violation_access_flag: result.flags?.violation_access_flag ?? true,
      sensitive_data_flag: result.flags?.sensitive_data_flag ?? false,
      prompt_abuse_flag: result.flags?.prompt_abuse_flag ?? false,
      citation_insufficient_flag: result.flags?.citation_insufficient_flag ?? true,
      blocked_rules_flag: result.flags?.blocked_rules_flag ?? false,
      warned_rules_flag: result.flags?.warned_rules_flag ?? false,
      blocked_rule_ids: result.blocked_rule_ids || [],
      warned_rule_ids: result.warned_rule_ids || [],
      citation_count: Array.isArray(result.citations) ? result.citations.length : 0,
      citations: result.citations || []
    });

    if (result.status === 'error') {
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('RAG GET error:', error.message);

    res.status(500).json({ error: error.message });
  }
});

// Audit log routes
app.get('/audit-log', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const auditData = await auditService.getAuditRecords(limit, offset);

    res.json({
      success: true,
      data: auditData
    });
  } catch (error) {
    console.error('Error retrieving audit logs:', error);
    res.status(500).json({ error: 'Failed to retrieve audit logs' });
  }
});

app.get('/audit-log/schema', (req, res) => {
  auditService
    .getLockedAuditSchema()
    .then((schema) => {
      res.json({ success: true, schema });
    })
    .catch((error) => {
      console.error('Error retrieving audit schema:', error.message);
      res.status(500).json({ error: 'Failed to retrieve locked audit schema' });
    });
});

// IMPORTANT: This keeps the server alive
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});