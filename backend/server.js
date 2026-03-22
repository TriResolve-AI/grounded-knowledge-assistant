require("dotenv").config();
const express = require("express");

const app = express();
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

// IMPORTANT: This keeps the server alive
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});