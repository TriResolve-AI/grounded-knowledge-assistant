// backend/config/azureConfig.js
require("dotenv").config();

const { BlobServiceClient } = require("@azure/storage-blob");
const { SearchIndexClient, SearchClient, AzureKeyCredential } = require("@azure/search-documents");
const { OpenAIClient, AzureKeyCredential: OAICredential } = require("@azure/openai");
const { DocumentAnalysisClient } = require("@azure/ai-form-recognizer");

function warnMissing(service, vars) {
  console.warn(
    `[azureConfig] ${service} client not configured — missing env var(s): ${vars.join(", ")}. ` +
    `Routes that depend on this service will return 503 until the vars are set.`
  );
}

// ─── Blob ─────────────────────────────────────────────────────────────────────
let blobServiceClient = null;
let containerClient = null;
if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
  blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  containerClient = blobServiceClient.getContainerClient(process.env.AZURE_BLOB_CONTAINER_NAME || "raw-documents");
} else {
  warnMissing("Blob Storage", ["AZURE_STORAGE_CONNECTION_STRING"]);
}

// ─── Search ───────────────────────────────────────────────────────────────────
let searchIndexClient = null;
let searchClient = null;
if (process.env.AZURE_SEARCH_ENDPOINT && process.env.AZURE_SEARCH_KEY) {
  searchIndexClient = new SearchIndexClient(
    process.env.AZURE_SEARCH_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
  );
  searchClient = new SearchClient(
    process.env.AZURE_SEARCH_ENDPOINT,
    process.env.AZURE_SEARCH_INDEX || "documents",
    new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
  );
} else {
  warnMissing("Azure Search", ["AZURE_SEARCH_ENDPOINT", "AZURE_SEARCH_KEY"]);
}

// ─── OpenAI ───────────────────────────────────────────────────────────────────
// Support both AZURE_OPENAI_API_KEY (Azure SDK convention) and AZURE_OPENAI_KEY (repo legacy)
const azureOpenAiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_KEY;
let openaiClient = null;
if (process.env.AZURE_OPENAI_ENDPOINT && azureOpenAiKey) {
  openaiClient = new OpenAIClient(
    process.env.AZURE_OPENAI_ENDPOINT,
    new OAICredential(azureOpenAiKey)
  );
} else {
  warnMissing("Azure OpenAI", ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY (or AZURE_OPENAI_KEY)"]);
}

// ─── Document Intelligence ────────────────────────────────────────────────────
let docIntelligenceClient = null;
if (process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT && process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY) {
  docIntelligenceClient = new DocumentAnalysisClient(
    process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT,
    new AzureKeyCredential(process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY)
  );
} else {
  warnMissing("Document Intelligence", ["AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT", "AZURE_DOCUMENT_INTELLIGENCE_API_KEY"]);
}

module.exports = {
  blobServiceClient,
  containerClient,
  searchIndexClient,
  searchClient,
  openaiClient,
  docIntelligenceClient,
};