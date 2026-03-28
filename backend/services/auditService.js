// backend/services/auditService.js
const { blobServiceClient } = require("../config/azureConfig");
const { v4: uuidv4 } = require('uuid');

class AuditService {
  constructor() {
    this.blobServiceClient = blobServiceClient;
    this.containerName = "audit-logs";
    this.auditBuffer = [];
    this.bufferSize = 10; // Write to blob every 10 records
  }

  /**
   * Write audit record according to architecture contract
   */
  async writeAuditRecord(ragRequest, ragResponse, governanceOutput) {
    const auditRecord = {
      // Required fields from architecture
      timestamp: new Date().toISOString(),
      request_id: ragResponse.request_id || uuidv4(),
      query: ragRequest.query,
      decision_status: ragResponse.decision_status,
      trust_score: ragResponse.trust_score,
      user_disclaimer: ragResponse.disclaimer,
      
      // Citation details
      citation_count: ragResponse.citations.length,
      citations: ragResponse.citations.map(c => ({
        doc_id: c.doc_id,
        chunk_id: c.chunk_id,
        similarity_score: c.similarity_score,
        is_active_version: c.is_active_version,
        doc_version: c.metadata?.doc_version
      })),
      
      // Governance details
      blocked_rule_ids: governanceOutput?.blocked_rule_ids || [],
      warned_rule_ids: governanceOutput?.warned_rule_ids || [],
      
      // Response details
      answer_preview: ragResponse.answer?.substring(0, 500),
      status: ragResponse.status,
      message: ragResponse.message,
      
      // Additional metadata for dashboard
      metadata: {
        processing_time_ms: ragResponse.processing_time_ms,
        model_used: process.env.AZURE_OPENAI_DEPLOYMENT,
        retrieval_top_k: 5
      }
    };

    // Add to buffer
    this.auditBuffer.push(auditRecord);
    
    // Write to blob if buffer is full
    if (this.auditBuffer.length >= this.bufferSize) {
      await this.flushAuditBuffer();
    }
    
    // Also log to console for debugging
    console.log(`[AUDIT] ${auditRecord.request_id} - ${auditRecord.decision_status} (${auditRecord.trust_score})`);
    
    return auditRecord;
  }

  /**
   * Flush audit buffer to Azure Blob Storage
   */
  async flushAuditBuffer() {
    if (this.auditBuffer.length === 0) return;
    
    try {
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      
      // Ensure container exists
      await containerClient.createIfNotExists();
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const blobName = `audit_${timestamp}_${uuidv4()}.jsonl`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      // Convert audit records to JSONL format
      const auditData = this.auditBuffer.map(record => JSON.stringify(record)).join('\n');
      
      await blockBlobClient.upload(auditData, auditData.length);
      console.log(`[AUDIT] Flushed ${this.auditBuffer.length} records to ${blobName}`);
      
      // Clear buffer
      this.auditBuffer = [];
    } catch (error) {
      console.error("[AUDIT] Error flushing buffer:", error);
    }
  }

  /**
   * Get audit logs for Power BI dashboard
   */
  async getAuditLogs(options = {}) {
    const { limit = 100, offset = 0, filter = null } = options;
    
    try {
      const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
      const logs = [];
      
      // List all blobs (most recent first)
      const blobs = [];
      for await (const blob of containerClient.listBlobsFlat()) {
        blobs.push(blob);
      }
      
      // Sort by last modified (newest first)
      blobs.sort((a, b) => b.lastModified - a.lastModified);
      
      // Read recent blobs
      let count = 0;
      for (const blob of blobs.slice(offset, offset + limit)) {
        const blockBlobClient = containerClient.getBlockBlobClient(blob.name);
        const content = await blockBlobClient.downloadToBuffer();
        const lines = content.toString().split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            logs.push(record);
            count++;
            if (count >= limit) break;
          } catch (e) {
            console.warn(`[AUDIT] Invalid JSON in ${blob.name}`);
          }
        }
        
        if (count >= limit) break;
      }
      
      return {
        total: logs.length,
        logs: logs
      };
    } catch (error) {
      console.error("[AUDIT] Error getting logs:", error);
      return { total: 0, logs: [] };
    }
  }
}

module.exports = new AuditService();