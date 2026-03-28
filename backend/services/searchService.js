// backend/services/searchService.js
const { searchClient } = require("../config/azureConfig");

class SearchService {
  constructor() {
    this.searchClient = searchClient;
  }

  /**
   * Search for documents with complete citation metadata
   * @param {string} query - User query
   * @param {Object} options - Search options
   * @returns {Promise<Array>} Search results with metadata
   */
  async search(query, options = {}) {
    if (!this.searchClient) {
      throw new Error("Azure Search service is not configured. Set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_KEY.");
    }
    const {
      top = 5,
      skip = 0,
      filter = null,
      select = [
        "content",
        "sourceFile", 
        "chunkIndex",
        "docVersion",
        "isActiveVersion",
        "docTitle",
        "docAuthor",
        "docPublishDate",
        "docId"
      ]
    } = options;

    try {
      const searchOptions = {
        select: select,
        top: top,
        skip: skip,
        includeTotalCount: true
      };

      if (filter) {
        searchOptions.filter = filter;
      }

      const results = await this.searchClient.search(query, searchOptions);
      
      const documents = [];
      for await (const result of results.results) {
        documents.push({
          id: result.id,
          content: result.content,
          score: result["@search.score"] || 0,
          metadata: {
            sourceFile: result.sourceFile,
            chunkIndex: result.chunkIndex,
            docVersion: result.docVersion,
            isActiveVersion: result.isActiveVersion,
            docTitle: result.docTitle,
            docAuthor: result.docAuthor,
            docPublishDate: result.docPublishDate,
            docId: result.docId,
            ingestedAt: result.ingestedAt
          }
        });
      }

      return {
        documents: documents,
        totalCount: results.count || 0
      };
    } catch (error) {
      console.error("[searchService] Search error:", error);
      throw error;
    }
  }

  /**
   * Upload documents to search index with full metadata
   */
  async uploadDocuments(documents) {
    if (!this.searchClient) {
      throw new Error("Azure Search service is not configured. Set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_KEY.");
    }
    try {
      const result = await this.searchClient.uploadDocuments(documents);
      return result;
    } catch (error) {
      console.error("[searchService] Upload error:", error);
      throw error;
    }
  }

  /**
   * Delete documents by filter
   */
  async deleteDocuments(filter) {
    if (!this.searchClient) {
      throw new Error("Azure Search service is not configured. Set AZURE_SEARCH_ENDPOINT and AZURE_SEARCH_KEY.");
    }
    try {
      // First search for documents to delete
      const searchResults = await this.searchClient.search("*", {
        filter: filter,
        select: ["id"]
      });

      const documentsToDelete = [];
      for await (const result of searchResults.results) {
        documentsToDelete.push({ id: result.id });
      }

      if (documentsToDelete.length > 0) {
        await this.searchClient.deleteDocuments(documentsToDelete);
      }

      return documentsToDelete.length;
    } catch (error) {
      console.error("[searchService] Delete error:", error);
      throw error;
    }
  }
}

module.exports = new SearchService();