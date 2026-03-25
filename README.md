# Grounded Knowledge Assistant (Governed RAG System)

A governed Retrieval-Augmented Generation (RAG) system designed for regulated industries. This solution delivers traceable, source-grounded answers with built-in compliance checks, hallucination mitigation, and auditability.

## 🚀 Key Features
- Source-grounded answers with citations
- Governance and compliance layer
- Trust score + explainability
- Audit trail logging

## 🏗️ Architecture
See `/docs/architecture.md`

## 📊 Evaluation
See `/evaluation/`

## 🛡️ Governance
See `/governance/`

## 👥 Team
- Portia — Product, Architecture, Governance
- Nadia — Evaluation, Metrics
- Megan — Backend, Security
- Esthefany — Data, RAG Pipeline
- Neha — Governance, Risk

---

## ▶️ Run Locally

### 1) Configure environment variables
Copy `.env.example` (if present) or create `.env` with:
- `PORT=3000`
- `AZURE_OPENAI_ENDPOINT=https://<your-azure-openai>.openai.azure.com/`
- `AZURE_OPENAI_KEY=<your-azure-openai-key>`
- `AZURE_OPENAI_DEPLOYMENT=<your-deployment-name>`
- `AZURE_SEARCH_ENDPOINT=https://<your-search-service>.search.windows.net`
- `AZURE_SEARCH_KEY=<your-search-key>`
- `AZURE_SEARCH_INDEX=<your-index-name>`

> If `OPENAI_API_KEY` is not set, this code uses Azure OpenAI when available and otherwise falls back to a local mock response for faster local development.

### 2) Start backend
```bash
cd /Users/testtaker/governed-rag-backend
npm install
npm start
```
Verify backend:
```bash
curl http://localhost:3000/health
```

### 3) Start frontend
```bash
cd /Users/testtaker/governed-rag-backend/frontend
npm install
npm run dev
```
Open browser at URL printed by Vite (usually `http://localhost:5173`).

### 4) API endpoints
- `GET /health` - health check
- `POST /query` - search tools (body: `{ "query": "..." }`)
- `POST /govern` - policy validation (body: `{ "type":"query","content":"..."}`)
- `POST /rag` - full RAG+governance pipeline (body: `{ "query": "...", "user_role": "user" }`)
- `GET /rag?query=...&user_role=...` - same pipeline

### 5) Troubleshooting
- If 403/404 from Azure Search/OpenAI, fallback is used and you still get static results.
- Set `OPENAI_API_KEY` to use public OpenAI APIs instead of Azure.
- Confirm `.env` values are correctly loaded and re-start backend after edits.

---

## 🔗 Broader Initiative

> 🔗 This project is part of a broader initiative under **AI for Regulated Enterprises**, focused on building compliant AI systems for real-world use cases.
