// backend/config/azureConfig.js
require("dotenv").config();

const { BlobServiceClient } = require("@azure/storage-blob");
const { SearchIndexClient, SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { OpenAIClient, AzureKeyCredential: OAICredential } = require("@azure/openai");
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");

// ─── Blob ─────────────────────────────────────────────────────────────────────
const blobServiceClient = process.env.AZURE_STORAGE_CONNECTION_STRING
  ? BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING)
  : null;

const containerClient = blobServiceClient
  ? blobServiceClient.getContainerClient(process.env.AZURE_BLOB_CONTAINER_NAME || "raw-documents")
  : null;

// ─── Search ───────────────────────────────────────────────────────────────────
const searchIndexClient = (process.env.AZURE_SEARCH_ENDPOINT && process.env.AZURE_SEARCH_KEY)
  ? new SearchIndexClient(
      process.env.AZURE_SEARCH_ENDPOINT,
      new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
    )
  : null;

const searchClient = (process.env.AZURE_SEARCH_ENDPOINT && process.env.AZURE_SEARCH_KEY)
  ? new SearchClient(
      process.env.AZURE_SEARCH_ENDPOINT,
      process.env.AZURE_SEARCH_INDEX || "documents",
      new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
    )
  : null;

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openaiClient = (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY)
  ? new OpenAIClient(
      process.env.AZURE_OPENAI_ENDPOINT,
      new OAICredential(process.env.AZURE_OPENAI_API_KEY)
    )
  : null;

// ─── Document Intelligence ────────────────────────────────────────────────────
const docIntelligenceClient = (process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT && process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY)
  ? new DocumentAnalysisClient(
      process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
      new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY)
    )
  : null;

module.exports = {
  blobServiceClient,
  containerClient,
  searchIndexClient,
  searchClient,
  openaiClient,
  docIntelligenceClient,
};