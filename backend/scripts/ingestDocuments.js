// backend/scripts/ingestDocuments.js (Updated version)
require("dotenv").config({ path: "../.env" });

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
    indexName: process.env.AZURE_SEARCH_INDEX || "cg-knowledge-index", // Updated to match architecture
  },
  openai: {
    deploymentName: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-ada-002",
  },
  chunking: {
    chunkSize:    800,
    chunkOverlap: 100,
  },
};

// ─── Search index definition with ALL required fields for architecture ──────────────────────────────────
async function ensureSearchIndex() {
  const index = {
    name: config.search.indexName,
    fields: [
      // Core fields
      { name: "id",         type: "Edm.String",             key: true,  searchable: false, filterable: true },
      { name: "content",    type: "Edm.String",             searchable: true, filterable: false, retrievable: true },
      { name: "embedding",  type: "Collection(Edm.Single)", searchable: true,
        vectorSearchDimensions: 1536, vectorSearchProfileName: "default-profile" },
      
      // Citation metadata fields (REQUIRED by architecture)
      { name: "sourceFile",      type: "Edm.String", searchable: false, filterable: true, retrievable: true },
      { name: "chunkIndex",      type: "Edm.Int32",  searchable: false, filterable: true, retrievable: true },
      { name: "ingestedAt",      type: "Edm.DateTimeOffset", searchable: false, filterable: true, retrievable: true },
      { name: "docVersion",      type: "Edm.String", searchable: false, filterable: true, retrievable: true },
      { name: "isActiveVersion", type: "Edm.Boolean", searchable: false, filterable: true, retrievable: true },
      { name: "docTitle",        type: "Edm.String", searchable: true,  filterable: true, retrievable: true },
      { name: "docAuthor",       type: "Edm.String", searchable: true,  filterable: true, retrievable: true },
      { name: "docPublishDate",  type: "Edm.DateTimeOffset", searchable: false, filterable: true, retrievable: true },
      
      // Additional metadata for better tracking
      { name: "fileType",        type: "Edm.String", searchable: false, filterable: true, retrievable: true },
      { name: "docId",           type: "Edm.String", searchable: false, filterable: true, retrievable: true },
    ],
    vectorSearch: {
      profiles:   [{ name: "default-profile", algorithmConfigurationName: "default-algo" }],
      algorithms: [{ name: "default-algo", kind: "hnsw" }],
    },
  };

  try {
    await searchIndexClient.createOrUpdateIndex(index);
    console.log(`[index] "${config.search.indexName}" ready with all required fields`);
  } catch (err) {
    console.error("[index] Failed to create index:", err.message);
    throw err;
  }
}

// ─── Extract metadata from filename or document ──────────────────────────────────────────────────────────
function extractMetadata(blobName, fileType) {
  // Parse filename to extract metadata
  // Example format: "POLICY_HR_2024_v2.0.pdf" or "handbook_active_v1.pdf"
  const baseName = path.basename(blobName, fileType);
  const parts = baseName.split('_');
  
  // Default metadata
  const metadata = {
    docId: baseName,
    docTitle: baseName.replace(/_/g, ' '),
    docAuthor: "Unknown",
    docVersion: "1.0",
    isActiveVersion: true,
    docPublishDate: new Date().toISOString()
  };
  
  // Try to extract version from filename (e.g., v2.0, version_2)
  const versionMatch = baseName.match(/[Vv](\d+\.?\d*)/);
  if (versionMatch) {
    metadata.docVersion = versionMatch[1];
  }
  
  // Check if document is active version (look for 'active' in filename)
  if (baseName.toLowerCase().includes('inactive') || 
      baseName.toLowerCase().includes('deprecated')) {
    metadata.isActiveVersion = false;
  }
  
  return metadata;
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
    try {
      const poller = await docIntelligenceClient.beginAnalyzeDocumentFromUrl(
        "prebuilt-read",
        blobUrl
      );
      const result = await poller.pollUntilDone();
      return result.content || "";
    } catch (error) {
      console.error(`[extract] PDF extraction failed for ${blobName}:`, error.message);
      return null;
    }
  }

  console.warn(`[extract] Unsupported file type: ${fileType}, skipping.`);
  return null;
}

// ─── Chunking with sentence boundary awareness ──────────────────────────────────────────────────────────
function chunkText(text, chunkSize, overlap) {
  // Split into sentences first for better chunk boundaries
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;
  
  for (const sentence of sentences) {
    const sentenceLength = sentence.split(/\s+/).length;
    
    if (currentLength + sentenceLength > chunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push(currentChunk.join(' '));
      
      // Keep overlap: keep last N sentences based on overlap percentage
      const overlapSentences = Math.ceil(overlap / 20); // Rough estimate
      currentChunk = currentChunk.slice(-overlapSentences);
      currentLength = currentChunk.join(' ').split(/\s+/).length;
    }
    
    currentChunk.push(sentence);
    currentLength += sentenceLength;
  }
  
  // Add the last chunk
  if (currentChunk.length > 0) {
    chunks.push(currentChunk.join(' '));
  }
  
  // If no chunks were created (e.g., no sentences), fall back to word-based chunking
  if (chunks.length === 0) {
    const words = text.split(/\s+/);
    let i = 0;
    while (i < words.length) {
      const chunk = words.slice(i, i + chunkSize).join(" ");
      if (chunk.trim()) chunks.push(chunk);
      i += chunkSize - overlap;
    }
  }
  
  return chunks;
}

// ─── Embedding with error handling ────────────────────────────────────────────────
async function generateEmbedding(text) {
  try {
    const response = await openaiClient.getEmbeddings(
      config.openai.deploymentName,
      [text]
    );
    return response.data[0].embedding;
  } catch (error) {
    console.error("[embedding] Failed to generate embedding:", error.message);
    // Return empty array as fallback
    return new Array(1536).fill(0);
  }
}

// ─── Deactivate old versions of a document ──────────────────────────────────────────────────────────
async function deactivateOldVersions(docId, currentVersion) {
  try {
    const filter = `docId eq '${docId}' and docVersion ne '${currentVersion}'`;
    const results = await searchClient.search("*", {
      filter: filter,
      select: ["id"]
    });
    
    const updates = [];
    for await (const result of results.results) {
      updates.push({
        id: result.id,
        isActiveVersion: false
      });
    }
    
    if (updates.length > 0) {
      await searchClient.uploadDocuments(updates);
      console.log(`  → deactivated ${updates.length} old version(s) of ${docId}`);
    }
  } catch (error) {
    console.warn(`[deactivate] Could not deactivate old versions: ${error.message}`);
  }
}

// ─── Main ingestion loop ──────────────────────────────────────────────────────
async function ingest() {
  console.log("🚀 Starting document ingestion with architecture requirements...\n");

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

    console.log(`\n📄 [processing] ${blob.name}`);

    try {
      const blobUrl = `${containerClient.url}/${blob.name}`;
      
      // Extract metadata from filename
      const metadata = extractMetadata(blob.name, ext);
      
      // Extract text content
      const text = await extractText(blob.name, blobUrl, ext);
      if (!text || text.trim().length === 0) {
        console.warn(`[skip] ${blob.name} — no text extracted`);
        continue;
      }

      // Chunk the document
      const chunks = chunkText(text, config.chunking.chunkSize, config.chunking.chunkOverlap);
      console.log(`  → ${chunks.length} chunks created`);

      // Generate embeddings and create documents
      const documents = [];
      const timestamp = new Date().toISOString();
      
      for (let i = 0; i < chunks.length; i++) {
        console.log(`  → generating embedding for chunk ${i + 1}/${chunks.length}`);
        const embedding = await generateEmbedding(chunks[i]);
        
        documents.push({
          id: `${blob.name.replace(/[^a-zA-Z0-9-_]/g, "_")}_chunk_${i}`,
          content: chunks[i],
          embedding,
          sourceFile: blob.name,
          chunkIndex: i,
          ingestedAt: timestamp,
          docVersion: metadata.docVersion,
          isActiveVersion: metadata.isActiveVersion,
          docTitle: metadata.docTitle,
          docAuthor: metadata.docAuthor,
          docPublishDate: metadata.docPublishDate,
          fileType: ext,
          docId: metadata.docId
        });
      }

      // Upload in batches
      const batchSize = 100;
      for (let b = 0; b < documents.length; b += batchSize) {
        await searchClient.uploadDocuments(documents.slice(b, b + batchSize));
        console.log(`  → uploaded batch ${Math.floor(b / batchSize) + 1}`);
      }

      // Deactivate old versions if this is a new active version
      if (metadata.isActiveVersion) {
        await deactivateOldVersions(metadata.docId, metadata.docVersion);
      }

      console.log(`  ✅ indexed ${documents.length} chunks with complete metadata`);
      processed++;

    } catch (err) {
      console.error(`[error] ${blob.name}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n✨ Ingestion complete. Processed: ${processed}, Failed: ${failed}`);
}

// Run ingestion
ingest().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});