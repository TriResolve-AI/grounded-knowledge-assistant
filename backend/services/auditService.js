const crypto = require("crypto");
const blobService = require("./blobService");

const AUDIT_LOG_BLOB = process.env.AUDIT_LOG_BLOB || "audit_log_live.jsonl";
const AUDIT_SCHEMA_BLOB = "audit_log_schema.json";

let cachedSchema = null;

/**
 * Write an audit record to the live audit log file
 * @param {object} auditRecord - Audit record to write (should conform to audit_log_schema.json)
 * @returns {Promise<void>}
 */
async function writeAuditRecord(auditRecord) {
  const record = {
    requestId: auditRecord.requestId || crypto.randomUUID(),
    timestamp: auditRecord.timestamp || new Date().toISOString(),
    ...auditRecord
  };

  const schema = await getLockedAuditSchema();
  validateAgainstLockedSchema(record, schema);

  const existing = await blobService.downloadBlob(AUDIT_LOG_BLOB);
  const nextContent = `${existing || ""}${JSON.stringify(record)}\n`;
  await blobService.uploadBlob(AUDIT_LOG_BLOB, nextContent);

  return record;
}

/**
 * Read all audit records from the live audit log file
 * @returns {Promise<array>} - Array of audit records
 */
async function readAuditRecords() {
  const content = await blobService.downloadBlob(AUDIT_LOG_BLOB);
  if (!content || !content.trim()) {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Get recent audit records (paginated)
 * @param {number} limit - Number of records to return
 * @param {number} offset - Number of records to skip
 * @returns {Promise<object>} - Paginated audit records
 */
async function getAuditRecords(limit = 100, offset = 0) {
  const allRecords = await readAuditRecords();
  const total = allRecords.length;
  const records = allRecords.slice(-limit - offset, -offset || undefined).reverse();

  return {
    total,
    count: records.length,
    limit,
    offset,
    records
  };
}

async function getLockedAuditSchema() {
  if (cachedSchema) {
    return cachedSchema;
  }

  const schemaContent = await blobService.downloadBlob(AUDIT_SCHEMA_BLOB);
  if (!schemaContent) {
    throw new Error("Locked schema audit_log_schema.json was not found in audit container");
  }

  cachedSchema = JSON.parse(schemaContent);
  return cachedSchema;
}

function validateAgainstLockedSchema(record, schema) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((field) => record[field] === undefined || record[field] === null);

  if (missing.length > 0) {
    throw new Error(`Audit record missing required schema fields: ${missing.join(", ")}`);
  }
}

module.exports = {
  getLockedAuditSchema,
  writeAuditRecord,
  readAuditRecords,
  getAuditRecords
};
