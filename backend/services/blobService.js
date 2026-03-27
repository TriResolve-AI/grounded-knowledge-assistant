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
 * @returns {Promise<string>} - Content of the blob
 */
async function downloadBlob(blobName) {
  try {
    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const downloadBlockBlobResponse = await blockBlobClient.download(0);
    const downloaded = await streamToString(downloadBlockBlobResponse.readableStreamBody);
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
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.upload(content, content.length);
    console.log(`Blob ${blobName} uploaded successfully`);
  } catch (error) {
    console.error(`Error uploading blob ${blobName}:`, error);
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
  getAuditSchema
};
