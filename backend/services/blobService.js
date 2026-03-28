const { BlobServiceClient } = require("@azure/storage-blob");

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_BLOB_CONTAINER_NAME || "audit";

function getBlobServiceClient() {
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required");
  }
  return BlobServiceClient.fromConnectionString(connectionString);
}

/**
 * Download a file from Azure Blob Storage
 * @param {string} blobName - Name of the blob to download
 * @returns {Promise<string|null>} - Content of the blob, or null if not found
 */
async function downloadBlob(blobName) {
  try {
    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const exists = await blockBlobClient.exists();
    if (!exists) {
      return null;
    }
    const downloadBlockBlobResponse = await blockBlobClient.download(0);
    const { readableStreamBody } = downloadBlockBlobResponse;
    if (!readableStreamBody) {
      return "";
    }
    const downloaded = await streamToString(readableStreamBody);
    return downloaded;
  } catch (error) {
    console.error(`Error downloading blob ${blobName}:`, error);
    throw error;
  }
}

/**
 * Convert stream to string
 * @param {stream.Readable} readableStream
 * @returns {Promise<string>}
 */
function streamToString(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data.toString("utf8"));
    });
    readableStream.on("end", () => {
      resolve(chunks.join(""));
    });
    readableStream.on("error", reject);
  });
}

/**
 * Upload a file to Azure Blob Storage
 * @param {string} blobName - Name of the blob to create/overwrite
 * @param {string} content - Content to upload
 * @returns {Promise<void>}
 */
async function uploadBlob(blobName, content) {
  try {
    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const contentLength = Buffer.byteLength(content, "utf8");
    await blockBlobClient.upload(content, contentLength);
    console.log(`Blob ${blobName} uploaded successfully`);
  } catch (error) {
    console.error(`Error uploading blob ${blobName}:`, error);
    throw error;
  }
}

/**
 * Atomically append a line to an Append Blob in Azure Blob Storage.
 * Creates the blob if it does not already exist.
 * @param {string} blobName - Name of the append blob
 * @param {string} line - Line to append (should end with "\n")
 * @returns {Promise<void>}
 */
async function appendBlobLine(blobName, line) {
  try {
    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);
    await containerClient.createIfNotExists();
    const appendBlobClient = containerClient.getAppendBlobClient(blobName);
    await appendBlobClient.createIfNotExists({
      blobHTTPHeaders: { blobContentType: "application/x-ndjson" }
    });
    const buffer = Buffer.from(line, "utf8");
    await appendBlobClient.appendBlock(buffer, buffer.length);
  } catch (error) {
    console.error(`Error appending to blob ${blobName}:`, error);
    throw error;
  }
}

/**
 * Get audit schema from Blob Storage
 * @returns {Promise<object>} - Parsed audit schema
 */
async function getAuditSchema() {
  try {
    const schemaContent = await downloadBlob("audit_log_schema.json");
    return JSON.parse(schemaContent);
  } catch (error) {
    console.error("Error fetching audit schema:", error);
    throw error;
  }
}

module.exports = {
  downloadBlob,
  uploadBlob,
  appendBlobLine,
  getAuditSchema
};
