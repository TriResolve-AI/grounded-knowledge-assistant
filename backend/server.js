require("dotenv").config();
const express = require("express");
const cors = require("cors");

const queryRoutes = require("./routes/query");
const auditRoutes = require("./routes/audit");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

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

// Mount routes
app.use(queryRoutes);
app.use(auditRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: "Internal server error",
    message: err.message
  });
});

// IMPORTANT: This keeps the server alive
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});