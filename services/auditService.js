const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { BlobServiceClient } = require("@azure/storage-blob");

const CONNECTION_STRING = process.env.AZURE_BLOB_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_BLOB_CONTAINER_NAME || "audit";
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
  return !CONNECTION_STRING;
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

async function appendLocalAuditLine(line) {
  await ensureLocalDataDir();
  await fs.appendFile(LOCAL_AUDIT_LOG_PATH, line, "utf8");
}

function getContainerClient() {
  if (!CONNECTION_STRING) {
    throw new Error("AZURE_BLOB_CONNECTION_STRING is required");
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  return blobServiceClient.getContainerClient(CONTAINER_NAME);
}

async function downloadBlobText(blobName) {
  if (isLocalFallbackEnabled()) {
    if (blobName === AUDIT_SCHEMA_BLOB) {
      return JSON.stringify(LOCAL_AUDIT_SCHEMA);
    }

    if (blobName === AUDIT_LOG_BLOB) {
      return readLocalAuditLog();
    }
  }

  const containerClient = getContainerClient();
  const blobClient = containerClient.getBlockBlobClient(blobName);

  const exists = await blobClient.exists();
  if (!exists) {
    return null;
  }

  const downloadResponse = await blobClient.download(0);
  const readableStream = downloadResponse.readableStreamBody;

  if (!readableStream) {
    return "";
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
    readableStream.on("end", () => resolve(chunks.join("")));
    readableStream.on("error", reject);
  });
}

async function appendAuditLine(line) {
  const containerClient = getContainerClient();
  await containerClient.createIfNotExists();
  const appendBlobClient = containerClient.getAppendBlobClient(AUDIT_LOG_BLOB);
  await appendBlobClient.createIfNotExists({
    blobHTTPHeaders: { blobContentType: "application/x-ndjson" }
  });
  const buffer = Buffer.from(line, "utf8");
  await appendBlobClient.appendBlock(buffer, buffer.length);
}

async function uploadBlobText(blobName, content) {
  const containerClient = getContainerClient();
  await containerClient.createIfNotExists();
  const blobClient = containerClient.getBlockBlobClient(blobName);
  const blobContentType = blobName.endsWith(".jsonl") || blobName.endsWith(".ndjson")
    ? "application/x-ndjson"
    : "application/json";
  await blobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: {
      blobContentType
    }
  });
}

async function getLockedAuditSchema() {
  if (cachedSchema) {
    return cachedSchema;
  }

  if (isLocalFallbackEnabled()) {
    cachedSchema = LOCAL_AUDIT_SCHEMA;
    return cachedSchema;
  }

  const schemaText = await downloadBlobText(AUDIT_SCHEMA_BLOB);
  if (!schemaText) {
    throw new Error("Locked schema audit_log_schema.json was not found in audit container");
  }

  cachedSchema = JSON.parse(schemaText);
  return cachedSchema;
}

function validateAgainstLockedSchema(record, schema) {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((field) => record[field] === undefined || record[field] === null);

  if (missing.length > 0) {
    throw new Error(`Audit record missing required schema fields: ${missing.join(", ")}`);
  }
}

async function readAuditRecords() {
  const raw = await downloadBlobText(AUDIT_LOG_BLOB);
  if (!raw || !raw.trim()) {
    return [];
  }

  const records = [];
  for (const line of raw.split("\n").filter((l) => l.trim().length > 0)) {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      console.warn("Failed to parse audit log line, skipping:", err.message);
    }
  }
  return records;
}

async function writeAuditRecord(auditRecord) {
  const record = {
    request_id: auditRecord.request_id || crypto.randomUUID(),
    timestamp: auditRecord.timestamp || new Date().toISOString(),
    ...auditRecord
  };

  const schema = await getLockedAuditSchema();
  validateAgainstLockedSchema(record, schema);

  const line = `${JSON.stringify(record)}\n`;

  if (isLocalFallbackEnabled()) {
    await appendLocalAuditLine(line);
  } else {
    await appendAuditLine(line);
  }

  return record;
}

async function getAuditRecords(limit = 100, offset = 0) {
  const containerClient = getContainerClient();
  const blobClient = containerClient.getBlockBlobClient(AUDIT_LOG_BLOB);

  const exists = await blobClient.exists();
  if (!exists) {
    return {
      total: 0,
      count: 0,
      limit,
      offset,
      records: []
    };
  }

  const downloadResponse = await blobClient.download(0);
  const readableStream = downloadResponse.readableStreamBody;

  if (!readableStream) {
    return {
      total: 0,
      count: 0,
      limit,
      offset,
      records: []
    };
  }

  const tailSize = limit + offset;
  const buffer = [];
  let total = 0;
  let leftover = "";

  await new Promise((resolve, reject) => {
    readableStream.on("data", (chunk) => {
      const text = leftover + chunk.toString("utf8");
      const lines = text.split("\n");
      leftover = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const record = JSON.parse(line);
        total += 1;
        buffer.push(record);

        if (buffer.length > tailSize) {
          buffer.shift();
        }
      }
    });

    readableStream.on("end", () => {
      if (leftover && leftover.trim()) {
        const record = JSON.parse(leftover);
        total += 1;
        buffer.push(record);

        if (buffer.length > tailSize) {
          buffer.shift();
        }
      }

      resolve();
    });

    readableStream.on("error", reject);
  });

  const effectiveLength = buffer.length;
  const start = Math.max(effectiveLength - offset - limit, 0);
  const end = Math.max(effectiveLength - offset, 0);
  const page = buffer.slice(start, end).reverse();
  return {
    total,
    count: page.length,
    limit,
    offset,
    records: page
  };
}

module.exports = {
  getLockedAuditSchema,
  getAuditRecords,
  readAuditRecords,
  writeAuditRecord
};
