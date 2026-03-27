// backend/server.js
const express = require('express');
const cors = require('cors');
require('dotenv').config({ path: '../.env' });

// Import routes
const queryRoutes = require('./routes/query');
const auditRoutes = require('./routes/audit');
const documentRoutes = require('./routes/documents');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/query', queryRoutes);        // Main query endpoint
app.use('/audit', auditRoutes);        // Audit log endpoints
app.use('/documents', documentRoutes); // Document management

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    services: {
      query: '/query',
      audit: '/audit',
      documents: '/documents'
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Grounded Knowledge Assistant API',
    version: '1.0.0',
    endpoints: {
      query: '/query',
      audit: '/audit',
      documents: '/documents',
      health: '/health'
    },
    architecture: 'Governed AI Assistant with Audit Trail'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Start server
app.listen(port, () => {
  console.log(`\n🚀 Grounded Knowledge Assistant API running on port ${port}`);
  console.log(`\n📋 Available endpoints:`);
  console.log(`   POST   /query          - Ask a question`);
  console.log(`   GET    /audit          - View audit logs`);
  console.log(`   GET    /audit/stats    - View audit statistics`);
  console.log(`   GET    /audit/export   - Export audit logs`);
  console.log(`   POST   /documents/upload - Upload document`);
  console.log(`   GET    /documents      - List documents`);
  console.log(`   GET    /health         - Health check`);
  console.log(`\n✨ Ready for demo!`);
});