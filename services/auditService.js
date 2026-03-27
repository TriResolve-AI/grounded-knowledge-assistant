const crypto = require("crypto");
const { BlobServiceClient } = require("@azure/storage-blob");

const CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER_NAME = process.env.AZURE_BLOB_CONTAINER_NAME || "audit";
const AUDIT_LOG_BLOB = process.env.AUDIT_LOG_BLOB || "audit_log_live.jsonl";
const AUDIT_SCHEMA_BLOB = "audit_log_schema.json";

let cachedSchema = null;

function getContainerClient() {
  if (!CONNECTION_STRING) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");
  }

  const blobServiceClient = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  return blobServiceClient.getContainerClient(CONTAINER_NAME);
}

async function downloadBlobText(blobName) {
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

async function uploadBlobText(blobName, content) {
  const containerClient = getContainerClient();
  await containerClient.createIfNotExists();
  const blobClient = containerClient.getBlockBlobClient(blobName);
  await blobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: {
      blobContentType: "application/json"
    }
  });
}

async function getLockedAuditSchema() {
  if (cachedSchema) {
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

  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

async function writeAuditRecord(auditRecord) {
  const record = {
    requestId: auditRecord.requestId || crypto.randomUUID(),
    timestamp: auditRecord.timestamp || new Date().toISOString(),
    ...auditRecord
  };

  const schema = await getLockedAuditSchema();
  validateAgainstLockedSchema(record, schema);

  const existing = await downloadBlobText(AUDIT_LOG_BLOB);
  const nextContent = `${existing || ""}${JSON.stringify(record)}\n`;
  await uploadBlobText(AUDIT_LOG_BLOB, nextContent);

  return record;
}

async function getAuditRecords(limit = 100, offset = 0) {
  const records = await readAuditRecords();
  const total = records.length;
  const start = Math.max(total - offset - limit, 0);
  const end = Math.max(total - offset, 0);
  const page = records.slice(start, end).reverse();

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
