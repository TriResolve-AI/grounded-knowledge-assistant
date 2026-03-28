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
  process.env.AZURE_SEARCH_INDEX || "cg-knowledge-index",
  new AzureKeyCredential(process.env.AZURE_SEARCH_KEY)
);

// ─── OpenAI ───────────────────────────────────────────────────────────────────
const openaiClient = new OpenAIClient(
  process.env.AZURE_OPENAI_ENDPOINT,
  new OAICredential(process.env.AZURE_OPENAI_KEY)
);

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