// backend/services/retrievalService.js
const searchService = require('./searchService');
const openaiService = require('./openaiService');

class RetrievalService {
  constructor() {
    this.searchService = searchService;
    this.openaiService = openaiService;
  }

  /**
   * Retrieve citations with complete metadata
   * @param {string} query - User query
   * @param {Object} options - Retrieval options
   * @returns {Promise<Array>} Citation objects matching architecture contract
   */
  async retrieveCitations(query, options = {}) {
    const {
      topK = 5,
      minSimilarity = 0.0,
      includeInactive = false
    } = options;

    try {
      // Build filter for active documents
      let filter = null;
      if (!includeInactive) {
        filter = "isActiveVersion eq true";
      }

      // Perform search using your existing search service
      const searchResults = await this.searchService.search(query, {
        top: topK,
        filter: filter
      });

      // Transform to citation format required by architecture
      const citations = searchResults.documents
        .filter(doc => doc.score >= minSimilarity)
        .map(doc => ({
          doc_id: doc.metadata.docId || doc.metadata.sourceFile,
          chunk_id: `${doc.metadata.sourceFile}_chunk_${doc.metadata.chunkIndex}`,
          similarity_score: doc.score,
          is_active_version: doc.metadata.isActiveVersion === true,
          text: doc.content,
          metadata: {
            doc_title: doc.metadata.docTitle || "Untitled",
            doc_author: doc.metadata.docAuthor || "Unknown",
            doc_version: doc.metadata.docVersion || "1.0",
            publish_date: doc.metadata.docPublishDate || null,
            source_file: doc.metadata.sourceFile,
            ingested_at: doc.metadata.ingestedAt
          }
        }));

      return citations;
    } catch (error) {
      console.error("[retrievalService] Error retrieving citations:", error);
      throw new Error(`Retrieval failed: ${error.message}`);
    }
  }

  /**
   * Hybrid search using both text and embeddings
   */
  async hybridRetrieve(query, queryVector, options = {}) {
    const {
      topK = 5,
      minSimilarity = 0.0,
      vectorWeight = 0.5,
      textWeight = 0.5
    } = options;

    try {
      // Use search service with vector search
      // Note: You'll need to enhance searchService to support vector search
      const searchResults = await this.searchService.search(query, {
        top: topK,
        vector: queryVector,
        vectorWeight: vectorWeight
      });

      const citations = searchResults.documents
        .filter(doc => doc.score >= minSimilarity)
        .map(doc => ({
          doc_id: doc.metadata.docId || doc.metadata.sourceFile,
          chunk_id: `${doc.metadata.sourceFile}_chunk_${doc.metadata.chunkIndex}`,
          similarity_score: doc.score,
          is_active_version: doc.metadata.isActiveVersion === true,
          text: doc.content,
          metadata: {
            doc_title: doc.metadata.docTitle || "Untitled",
            doc_author: doc.metadata.docAuthor || "Unknown",
            doc_version: doc.metadata.docVersion || "1.0",
            publish_date: doc.metadata.docPublishDate || null,
            source_file: doc.metadata.sourceFile,
            ingested_at: doc.metadata.ingestedAt
          }
        }));

      return citations;
    } catch (error) {
      console.error("[retrievalService] Hybrid search error:", error);
      throw error;
    }
  }

  /**
   * Generate embeddings for a query using OpenAI service
   */
  async generateQueryEmbedding(query) {
    try {
      const embedding = await this.openaiService.generateEmbedding(query);
      return embedding;
    } catch (error) {
      console.error("[retrievalService] Embedding generation error:", error);
      throw error;
    }
  }
}

module.exports = new RetrievalService();