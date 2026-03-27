// backend/routes/audit.js
const express = require('express');
const router = express.Router();
const auditService = require('../services/auditService');
const { blobServiceClient } = require('../config/azureConfig');

/**
 * GET /audit - Get audit logs for Power BI dashboard
 */
router.get('/', async (req, res) => {
  try {
    const { 
      limit = 100, 
      offset = 0, 
      start_date, 
      end_date,
      decision_status,
      min_trust_score 
    } = req.query;
    
    let logs = await auditService.getAuditLogs({
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
    // Apply filters
    let filteredLogs = logs.logs;
    
    if (start_date) {
      const start = new Date(start_date);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) >= start);
    }
    
    if (end_date) {
      const end = new Date(end_date);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) <= end);
    }
    
    if (decision_status) {
      filteredLogs = filteredLogs.filter(log => log.decision_status === decision_status);
    }
    
    if (min_trust_score) {
      filteredLogs = filteredLogs.filter(log => log.trust_score >= parseFloat(min_trust_score));
    }
    
    // Prepare Power BI friendly format
    const powerBIData = filteredLogs.map(log => ({
      timestamp: log.timestamp,
      request_id: log.request_id,
      query: log.query,
      decision_status: log.decision_status,
      trust_score: log.trust_score,
      citation_count: log.citation_count,
      processing_time_ms: log.metadata?.processing_time_ms || 0,
      blocked_rules: log.blocked_rule_ids?.join(',') || '',
      warned_rules: log.warned_rule_ids?.join(',') || ''
    }));
    
    res.json({
      success: true,
      total: filteredLogs.length,
      logs: powerBIData,
      metadata: {
        filters_applied: { start_date, end_date, decision_status, min_trust_score },
        export_format: "powerbi_ready"
      }
    });
    
  } catch (error) {
    console.error("[AUDIT] Error fetching logs:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /audit/stats - Get audit statistics for dashboard
 */
router.get('/stats', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const logs = await auditService.getAuditLogs({ limit: 1000 });
    
    // Calculate statistics
    const stats = {
      total_queries: logs.logs.length,
      by_decision: {
        ALLOW: logs.logs.filter(l => l.decision_status === 'ALLOW').length,
        REDACT: logs.logs.filter(l => l.decision_status === 'REDACT').length,
        DEFER: logs.logs.filter(l => l.decision_status === 'DEFER').length,
        BLOCK: logs.logs.filter(l => l.decision_status === 'BLOCK').length
      },
      avg_trust_score: logs.logs.reduce((sum, l) => sum + l.trust_score, 0) / logs.logs.length,
      avg_citations: logs.logs.reduce((sum, l) => sum + l.citation_count, 0) / logs.logs.length,
      blocked_by_rule: {},
      timestamp: new Date().toISOString()
    };
    
    // Count blocked by rule
    logs.logs.forEach(log => {
      if (log.blocked_rule_ids) {
        log.blocked_rule_ids.forEach(rule => {
          stats.blocked_by_rule[rule] = (stats.blocked_by_rule[rule] || 0) + 1;
        });
      }
    });
    
    res.json({
      success: true,
      stats: stats,
      period_days: parseInt(days)
    });
    
  } catch (error) {
    console.error("[AUDIT] Error calculating stats:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /audit/export - Export audit logs as CSV for Power BI
 */
router.get('/export', async (req, res) => {
  try {
    const { start_date, end_date, format = 'csv' } = req.query;
    
    let logs = await auditService.getAuditLogs({ limit: 10000 });
    let filteredLogs = logs.logs;
    
    if (start_date) {
      const start = new Date(start_date);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) >= start);
    }
    
    if (end_date) {
      const end = new Date(end_date);
      filteredLogs = filteredLogs.filter(log => new Date(log.timestamp) <= end);
    }
    
    if (format === 'csv') {
      // Create CSV for Power BI
      const headers = [
        'timestamp', 'request_id', 'query', 'decision_status', 
        'trust_score', 'citation_count', 'processing_time_ms'
      ];
      
      const csvRows = [headers.join(',')];
      
      filteredLogs.forEach(log => {
        const row = [
          log.timestamp,
          log.request_id,
          `"${log.query.replace(/"/g, '""')}"`, // Escape quotes
          log.decision_status,
          log.trust_score,
          log.citation_count,
          log.metadata?.processing_time_ms || 0
        ];
        csvRows.push(row.join(','));
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=audit_log_${new Date().toISOString()}.csv`);
      res.send(csvRows.join('\n'));
      
    } else if (format === 'json') {
      res.json({
        success: true,
        total: filteredLogs.length,
        logs: filteredLogs
      });
    }
    
  } catch (error) {
    console.error("[AUDIT] Error exporting logs:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /audit/flush - Manually flush audit buffer
 */
router.post('/flush', async (req, res) => {
  try {
    await auditService.flushAuditBuffer();
    res.json({
      success: true,
      message: "Audit buffer flushed successfully"
    });
  } catch (error) {
    console.error("[AUDIT] Error flushing buffer:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;