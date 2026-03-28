// backend/routes/documents.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { blobServiceClient, searchClient } = require('../config/azureConfig');
const searchService = require('../services/searchService');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.pdf', '.txt', '.html', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  }
});

/**
 * POST /documents/upload - Upload a new document
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  const documentId = uuidv4();
  
  try {
    const { file } = req;
    const { 
      doc_title = file.originalname,
      doc_author = "Unknown",
      doc_version = "1.0",
      is_active = "true"
    } = req.body;
    
    if (!file) {
      return res.status(400).json({
        success: false,
        error: "No file uploaded"
      });
    }
    
    // Upload to blob storage
    const containerClient = blobServiceClient.getContainerClient("raw-documents");
    await containerClient.createIfNotExists();
    
    const blobName = `documents/${documentId}/${file.originalname}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    await blockBlobClient.upload(file.buffer, file.size, {
      metadata: {
        doc_id: documentId,
        doc_title: doc_title,
        doc_author: doc_author,
        doc_version: doc_version,
        is_active_version: is_active,
        uploaded_at: new Date().toISOString()
      }
    });
    
    // Trigger ingestion (you might want to queue this)
    // For now, we'll return success and handle ingestion asynchronously
    
    res.json({
      success: true,
      document_id: documentId,
      filename: file.originalname,
      message: "Document uploaded successfully. Ingestion will begin shortly.",
      metadata: {
        title: doc_title,
        author: doc_author,
        version: doc_version,
        is_active: is_active === "true"
      }
    });
    
  } catch (error) {
    console.error("[DOCUMENTS] Upload error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /documents/ingest - Trigger ingestion for a document
 */
router.post('/ingest', async (req, res) => {
  const { document_id, blob_name } = req.body;
  
  if (!document_id && !blob_name) {
    return res.status(400).json({
      success: false,
      error: "Missing document_id or blob_name"
    });
  }
  
  try {
    // This would trigger your ingestion pipeline
    // You could use Azure Functions or a queue for this
    // For now, we'll just acknowledge the request
    
    res.json({
      success: true,
      message: "Ingestion triggered",
      document_id: document_id,
      status: "queued"
    });
    
  } catch (error) {
    console.error("[DOCUMENTS] Ingestion error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /documents - List all documents
 */
router.get('/', async (req, res) => {
  try {
    const { include_inactive = false, limit = 100 } = req.query;
    
    // Query search index for document metadata
    const filter = include_inactive === 'true' ? null : "isActiveVersion eq true";
    const results = await searchService.search("*", {
      top: parseInt(limit),
      filter: filter,
      select: ["docId", "docTitle", "docAuthor", "docVersion", "isActiveVersion", "sourceFile", "ingestedAt"]
    });
    
    // Group by document ID to get unique documents
    const documentsMap = new Map();
    results.documents.forEach(doc => {
      const docId = doc.metadata.docId;
      if (!documentsMap.has(docId)) {
        documentsMap.set(docId, {
          doc_id: docId,
          title: doc.metadata.docTitle,
          author: doc.metadata.docAuthor,
          current_version: doc.metadata.docVersion,
          is_active: doc.metadata.isActiveVersion,
          source_file: doc.metadata.sourceFile,
          ingested_at: doc.metadata.ingestedAt,
          chunk_count: 1
        });
      } else {
        const existing = documentsMap.get(docId);
        existing.chunk_count++;
      }
    });
    
    const documents = Array.from(documentsMap.values());
    
    res.json({
      success: true,
      total: documents.length,
      documents: documents
    });
    
  } catch (error) {
    console.error("[DOCUMENTS] List error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /documents/:id - Get document details
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  
  try {
    // Search for all chunks of this document
    const results = await searchService.search("*", {
      filter: `docId eq '${id}'`,
      top: 1000,
      select: ["docId", "docTitle", "docAuthor", "docVersion", "isActiveVersion", "sourceFile", "ingestedAt", "chunkIndex", "content"]
    });
    
    if (results.documents.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Document not found"
      });
    }
    
    const doc = results.documents[0];
    const versions = new Map();
    
    results.documents.forEach(chunk => {
      const version = chunk.metadata.docVersion;
      if (!versions.has(version)) {
        versions.set(version, {
          version: version,
          is_active: chunk.metadata.isActiveVersion,
          chunk_count: 1,
          ingested_at: chunk.metadata.ingestedAt
        });
      } else {
        versions.get(version).chunk_count++;
      }
    });
    
    res.json({
      success: true,
      document: {
        doc_id: doc.metadata.docId,
        title: doc.metadata.docTitle,
        author: doc.metadata.docAuthor,
        current_version: doc.metadata.docVersion,
        is_active: doc.metadata.isActiveVersion,
        source_file: doc.metadata.sourceFile,
        ingested_at: doc.metadata.ingestedAt,
        total_chunks: results.documents.length,
        versions: Array.from(versions.values())
      }
    });
    
  } catch (error) {
    console.error("[DOCUMENTS] Get error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /documents/:id - Deactivate or delete a document
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const { permanent = false } = req.query;
  
  try {
    if (permanent === 'true') {
      // Permanent deletion
      const deletedCount = await searchService.deleteDocuments(`docId eq '${id}'`);
      res.json({
        success: true,
        message: `Permanently deleted document ${id}`,
        chunks_deleted: deletedCount
      });
    } else {
      // Soft delete - mark as inactive
      const results = await searchService.search("*", {
        filter: `docId eq '${id}'`,
        top: 1000,
        select: ["id", "isActiveVersion"]
      });
      
      const updates = results.documents.map(doc => ({
        id: doc.id,
        isActiveVersion: false
      }));
      
      if (updates.length > 0) {
        await searchService.uploadDocuments(updates);
      }
      
      res.json({
        success: true,
        message: `Document ${id} marked as inactive`,
        chunks_updated: updates.length
      });
    }
    
  } catch (error) {
    console.error("[DOCUMENTS] Delete error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /documents/:id/activate - Activate a document version
 */
router.put('/:id/activate', async (req, res) => {
  const { id } = req.params;
  const { version } = req.body;
  
  try {
    // First, deactivate all versions of this document
    const allVersions = await searchService.search("*", {
      filter: `docId eq '${id}'`,
      top: 1000,
      select: ["id", "docVersion", "isActiveVersion"]
    });
    
    const updates = [];
    for (const doc of allVersions.documents) {
      updates.push({
        id: doc.id,
        isActiveVersion: doc.metadata.docVersion === version
      });
    }
    
    if (updates.length > 0) {
      await searchService.uploadDocuments(updates);
    }
    
    res.json({
      success: true,
      message: `Version ${version} of document ${id} is now active`,
      chunks_updated: updates.length
    });
    
  } catch (error) {
    console.error("[DOCUMENTS] Activate error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;