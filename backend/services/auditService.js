const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const blobService = require("./blobService");

const AUDIT_LOG_BLOB = process.env.AUDIT_LOG_BLOB || "audit_log_live.jsonl";
const AUDIT_SCHEMA_BLOB = "audit_log_schema.json";
const LOCAL_DATA_DIR = path.join(__dirname, "..", "data");
const LOCAL_AUDIT_LOG_PATH = path.join(LOCAL_DATA_DIR, AUDIT_LOG_BLOB);

const LOCAL_AUDIT_SCHEMA = {
  title: "Local audit schema fallback",
  required: [
    "request_id",
    "timestamp",
    "full_query",
    "full_response",
    "decision_status",
    "trust_score",
    "risk_score",
    "allow_flag",
    "allowed_data_class",
    "detected_data_class",
    "conform_access_flag",
    "violation_access_flag",
    "sensitive_data_flag",
    "prompt_abuse_flag",
    "citation_insufficient_flag",
    "blocked_rules_flag",
    "warned_rules_flag",
    "blocked_rule_ids",
    "warned_rule_ids",
    "citation_count",
    "citations"
  ]
};

let cachedSchema = null;

function isLocalFallbackEnabled() {
  return !process.env.AZURE_STORAGE_CONNECTION_STRING;
}

async function ensureLocalDataDir() {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });
}

async function readLocalAuditLog() {
  try {
    return await fs.readFile(LOCAL_AUDIT_LOG_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeLocalAuditLog(line) {
  await ensureLocalDataDir();
  await fs.appendFile(LOCAL_AUDIT_LOG_PATH, line, "utf8");
}

/**
 * Write an audit record to the live audit log file
 * @param {object} auditRecord - Audit record to write (should conform to audit_log_schema.json)
 * @returns {Promise<void>}
 */
async function writeAuditRecord(auditRecord) {
  const record = {
    request_id: auditRecord.request_id || auditRecord.requestId || crypto.randomUUID(),
    timestamp: auditRecord.timestamp || new Date().toISOString(),
    ...auditRecord
  };
  // Ensure consistent snake_case field name (remove camelCase duplicate if spread re-introduced it)
  delete record.requestId;

  const schema = await getLockedAuditSchema();
  validateAgainstLockedSchema(record, schema);

  const line = `${JSON.stringify(record)}\n`;

  if (isLocalFallbackEnabled()) {
    await writeLocalAuditLog(line);
  } else {
    await blobService.appendBlobLine(AUDIT_LOG_BLOB, line);
  }

  return record;
}

/**
 * Read all audit records from the live audit log file
 * @returns {Promise<array>} - Array of audit records
 */
async function readAuditRecords() {
  const content = isLocalFallbackEnabled()
    ? await readLocalAuditLog()
    : await blobService.downloadBlob(AUDIT_LOG_BLOB);
  if (!content || !content.trim()) {
    return [];
  }

  const records = [];
  for (const line of content.split("\n").filter((l) => l.trim().length > 0)) {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      console.warn("Failed to parse audit log line, skipping:", err.message);
    }
  }
  return records;
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

  if (isLocalFallbackEnabled()) {
    cachedSchema = LOCAL_AUDIT_SCHEMA;
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
