// backend/scripts/ingestDocuments.js
require("dotenv").config({ path: "../.env" });

// ── replaced buildClients() with a single import ──
const {
  containerClient,
  searchIndexClient,
  searchClient,
  openaiClient,
  docIntelligenceClient,
} = require("../config/azureConfig");

const path = require("path");

// ─── Config ───────────────────────────────────────────────────────────────────
const config = {
  search: {
    indexName: process.env.AZURE_SEARCH_INDEX || "documents",
  },
  openai: {
    deploymentName: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-ada-002",
  },
  chunking: {
    chunkSize:    800,
    chunkOverlap: 100,
  },
};

// ─── Search index definition ──────────────────────────────────────────────────
async function ensureSearchIndex() {
  const index = {
    name: config.search.indexName,
    fields: [
      { name: "id",         type: "Edm.String",             key: true,  searchable: false },
      { name: "content",    type: "Edm.String",             searchable: true, filterable: false },
      { name: "embedding",  type: "Collection(Edm.Single)", searchable: true,
        vectorSearchDimensions: 1536, vectorSearchProfileName: "default-profile" },
      { name: "sourceFile", type: "Edm.String",             searchable: false, filterable: true },
      { name: "fileType",   type: "Edm.String",             searchable: false, filterable: true },
      { name: "chunkIndex", type: "Edm.Int32",              searchable: false, filterable: false },
      { name: "ingestedAt", type: "Edm.DateTimeOffset",     searchable: false, filterable: true },
    ],
    vectorSearch: {
      profiles:   [{ name: "default-profile", algorithmConfigurationName: "default-algo" }],
      algorithms: [{ name: "default-algo", kind: "hnsw" }],
    },
  };

  try {
    await searchIndexClient.createOrUpdateIndex(index);
    console.log(`[index] "${config.search.indexName}" ready`);
  } catch (err) {
    console.error("[index] Failed to create index:", err.message);
    throw err;
  }
}

// ─── Text extraction ──────────────────────────────────────────────────────────
async function extractText(blobName, blobUrl, fileType) {
  if (fileType === ".txt" || fileType === ".html") {
    const response = await fetch(blobUrl);
    let text = await response.text();
    if (fileType === ".html") {
      text = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
    return text;
  }

  if (fileType === ".pdf") {
    const poller = await docIntelligenceClient.beginAnalyzeDocumentFromUrl(
      "prebuilt-read",
      blobUrl
    );
    const result = await poller.pollUntilDone();
    return result.content || "";
  }

  console.warn(`[extract] Unsupported file type: ${fileType}, skipping.`);
  return null;
}

// ─── Chunking ─────────────────────────────────────────────────────────────────
function chunkText(text, chunkSize, overlap) {
  const words  = text.split(/\s+/);
  const chunks = [];
  let i = 0;

  while (i < words.length) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (chunk.trim()) chunks.push(chunk);
    i += chunkSize - overlap;
  }

  return chunks;
}

// ─── Embedding ────────────────────────────────────────────────────────────────
async function generateEmbedding(text) {
  const response = await openaiClient.getEmbeddings(
    config.openai.deploymentName,
    [text]
  );
  return response.data[0].embedding;
}

// ─── Main ingestion loop ──────────────────────────────────────────────────────
async function ingest() {
  console.log("Starting ingestion...\n");

  await ensureSearchIndex();

  const supportedTypes = [".pdf", ".txt", ".html"];
  let processed = 0;
  let failed    = 0;

  for await (const blob of containerClient.listBlobsFlat()) {
    const ext = path.extname(blob.name).toLowerCase();

    if (!supportedTypes.includes(ext)) {
      console.log(`[skip] ${blob.name} — unsupported type`);
      continue;
    }

    console.log(`[processing] ${blob.name}`);

    try {
      const blobUrl = `${containerClient.url}/${blob.name}`;

      const text = await extractText(blob.name, blobUrl, ext);
      if (!text || text.trim().length === 0) {
        console.warn(`[skip] ${blob.name} — no text extracted`);
        continue;
      }

      const chunks = chunkText(text, config.chunking.chunkSize, config.chunking.chunkOverlap);
      console.log(`  → ${chunks.length} chunks`);

      const documents = [];
      for (let i = 0; i < chunks.length; i++) {
        const embedding = await generateEmbedding(chunks[i]);
        documents.push({
          id:         `${blob.name}-chunk-${i}`.replace(/[^a-zA-Z0-9-_]/g, "_"),
          content:    chunks[i],
          embedding,
          sourceFile: blob.name,
          fileType:   ext,
          chunkIndex: i,
          ingestedAt: new Date().toISOString(),
        });
      }

      const batchSize = 100;
      for (let b = 0; b < documents.length; b += batchSize) {
        await searchClient.uploadDocuments(documents.slice(b, b + batchSize));
      }

      console.log(`  → indexed ${documents.length} chunks`);
      processed++;

    } catch (err) {
      console.error(`[error] ${blob.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nIngestion complete. Processed: ${processed}, Failed: ${failed}`);
}

ingest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});