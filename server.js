require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Import services
const searchService = require('./services/searchService');
const governance = require('./services/governance');

// Debug log to confirm execution
console.log("Starting server...");

// Health route
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Backend is running",
    port: process.env.PORT
  });
});

// Query route for searching governance tools
app.post("/query", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "Query is required" });
    }

    const results = await searchService.searchGovernanceTools(query);
    res.json({ results });
  } catch (error) {
    console.error("Query error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Govern route for validation
app.post("/govern", async (req, res) => {
  try {
    const { type, content } = req.body;
    if (!type || !content) {
      return res.status(400).json({ error: "Type and content are required" });
    }

    let result;
    if (type === 'query') {
      result = await governance.validateQuery(content);
    } else if (type === 'response') {
      result = await governance.validateResponse(content, req.body.sourceDocument || '');
    } else {
      return res.status(400).json({ error: "Invalid type. Use 'query' or 'response'" });
    }

    res.json(result);
  } catch (error) {
    console.error("Govern error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// RAG pipeline route for full governance + search
app.post('/rag', async (req, res) => {
  try {
    const { query, user_role } = req.body;
    if (!query || !user_role) {
      return res.status(400).json({ error: 'query and user_role are required' });
    }

    const result = await searchService.processUserQuery(query, user_role);
    if (result.status === 'error') {
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('RAG error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Convenience GET route for quick browser testing
app.get('/rag', async (req, res) => {
  try {
    const query = req.query.query || req.body?.query;
    const user_role = req.query.user_role || req.body?.user_role;

    if (!query || !user_role) {
      return res.status(400).json({
        error: 'query and user_role are required (via query params or JSON body)'
      });
    }

    const result = await searchService.processUserQuery(query, user_role);
    if (result.status === 'error') {
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('RAG GET error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// IMPORTANT: This keeps the server alive
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});