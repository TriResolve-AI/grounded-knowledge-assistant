// backend/services/openaiService.js
const { openaiClient } = require("../config/azureConfig");

class OpenAIService {
  constructor() {
    this.client = openaiClient;
    this.embeddingDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || "text-embedding-ada-002";
    this.completionDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
  }

  /**
   * Generate embeddings for text
   */
  async generateEmbedding(text) {
    try {
      const response = await this.client.getEmbeddings(
        this.embeddingDeployment,
        [text]
      );
      return response.data[0].embedding;
    } catch (error) {
      console.error("[openaiService] Embedding error:", error);
      throw error;
    }
  }

  /**
   * Generate a grounded answer using citations
   */
  async generateGroundedAnswer(query, citations) {
    try {
      // Build context from citations
      const context = citations.map((citation, idx) => {
        return `[Source ${idx + 1}: ${citation.doc_id} (v${citation.metadata.doc_version})]\n${citation.text}`;
      }).join("\n\n");

      const prompt = `You are a helpful assistant that answers questions based only on the provided context.
      
Context:
${context}

Question: ${query}

Instructions:
- Answer based ONLY on the context provided
- If the answer cannot be found in the context, say "I cannot find this information in the available documents"
- Cite which sources you're using
- Be concise and accurate

Answer:`;

      const response = await this.client.getCompletions(
        this.completionDeployment,
        prompt,
        {
          maxTokens: 500,
          temperature: 0.3,
          topP: 0.95
        }
      );

      return response.choices[0].text.trim();
    } catch (error) {
      console.error("[openaiService] Completion error:", error);
      throw error;
    }
  }
}

module.exports = new OpenAIService();