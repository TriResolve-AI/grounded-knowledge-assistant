// backend/config/azureConfig.js
require("dotenv").config();

const { BlobServiceClient } = require("@azure/storage-blob");
const { SearchIndexClient, SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { OpenAIClient, AzureKeyCredential: OAICredential } = require("@azure/openai");
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");

// ─── Blob ─────────────────────────────────────────────────────────────────────
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_BLOB_CONNECTION_STRING
);
const containerClient = blobServiceClient.getContainerClient(
  process.env.AZURE_BLOB_CONTAINER_NAME || "raw-documents"
);

// ─── Search ───────────────────────────────────────────────────────────────────
const searchIndexClient = new SearchIndexClient(
  process.env.AZURE_SEARCH_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
);
const searchClient = new SearchClient(
  process.env.AZURE_SEARCH_ENDPOINT,
  process.env.AZURE_SEARCH_INDEX || "documents",
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
);

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openaiClient = new OpenAIClient(
  process.env.AZURE_OPENAI_ENDPOINT,
  new OAICredential(process.env.AZURE_OPENAI_KEY)
);

// ─── Document Intelligence ────────────────────────────────────────────────────
const docIntelligenceClient = new DocumentAnalysisClient(
  process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY)
);

module.exports = {
  containerClient,
  searchIndexClient,
  searchClient,
  openaiClient,
  docIntelligenceClient,
};