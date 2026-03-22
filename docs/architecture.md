# Architecture

## 1. Purpose

Grounded Knowledge Assistant is a governed Retrieval-Augmented Generation (RAG) platform for regulated environments. The architecture is designed to provide:

- Source-grounded responses with explicit citations
- Policy-aware safety and compliance checks
- Verifiable audit trails for every answer
- Explainable trust scoring for downstream users

## 2. System Overview

The system is organized into five layers:

1. Ingestion and Data Governance Layer
2. Retrieval and Ranking Layer
3. Generation and Grounding Layer
4. Governance and Policy Enforcement Layer
5. Observability, Evaluation, and Audit Layer

## 3. Logical Components

### 3.1 Ingestion and Data Governance

Responsibilities:

- Connect to approved enterprise sources (documents, policies, procedures, knowledge bases)
- Normalize and chunk documents
- Attach metadata (source owner, jurisdiction, document class, effective date, retention policy)
- Enforce ingestion policy (allowlists, PII handling rules, data classification)

Outputs:

- Clean document chunks
- Metadata records
- Versioned provenance pointers

### 3.2 Embedding and Indexing

Responsibilities:

- Generate embeddings for each approved chunk
- Persist vectors in a vector store
- Persist metadata in a filterable store
- Support re-indexing by document version and policy changes

Outputs:

- Searchable vector index
- Filterable metadata index

### 3.3 Query Processing and Retrieval

Responsibilities:

- Accept user query and context
- Apply query-time policy filters (role, region, data class)
- Retrieve top-k candidates using semantic search
- Re-rank by relevance, freshness, and policy compatibility

Outputs:

- Ranked evidence set
- Retrieval diagnostics (scores, filters used, rejected sources)

### 3.4 Generation and Grounding

Responsibilities:

- Build constrained prompt with retrieved evidence only
- Generate answer with citation mapping to evidence chunks
- Reject unsupported claims when evidence is insufficient

Outputs:

- Draft answer
- Citation set
- Unsupported claim flags

### 3.5 Governance and Compliance

Responsibilities:

- Run policy checks (regulatory constraints, sensitive topics, disclosure requirements)
- Validate citation completeness and evidence coverage
- Compute trust score based on retrieval quality and policy outcomes
- Decide final action: allow, redact, defer, or block

Outputs:

- Final answer decision
- Compliance decision rationale
- Trust and explainability signals

### 3.6 Audit and Monitoring

Responsibilities:

- Persist immutable interaction logs
- Track model, prompt, index, and policy versions per request
- Emit monitoring metrics and evaluation traces

Outputs:

- Audit trail entries
- Operational metrics
- Evaluation datasets for offline review

## 4. End-to-End Request Flow

1. User submits a question.
2. Query service authenticates user and loads policy context.
3. Retrieval service fetches and re-ranks evidence chunks.
4. Generation service creates grounded response draft with citations.
5. Governance service evaluates policy constraints and evidence sufficiency.
6. Trust service computes trust score and explainability summary.
7. Response is returned (or safely blocked/deferred).
8. Full trace is logged for audit and evaluation.

## 5. Trust Score (Conceptual)

Trust score is a composite measure in $[0, 1]$ combining:

$$
T = w_r R + w_c C + w_p P + w_f F
$$

Where:

- $R$: retrieval quality signal (relevance and coverage)
- $C$: citation completeness and claim-evidence alignment
- $P$: policy/compliance pass strength
- $F$: freshness and version confidence
- $w_*$: configurable weights with $\sum w_* = 1$

Low-trust responses can be auto-deferred to human review.

## 6. Deployment Model (Reference)

- Frontend: user interface and analyst console
- Backend API: orchestration, retrieval, generation, governance
- Data plane: vector DB, metadata store, object storage
- Policy engine: rule evaluation and decision service
- Logging pipeline: append-only audit storage and metrics backend

## 7. Security and Privacy Considerations

- Least-privilege access to data sources and indexes
- Encryption in transit and at rest
- Data minimization during prompt assembly
- Sensitive data detection and redaction controls
- Tenant and region isolation where required

## 8. Failure Modes and Safe Handling

- No sufficient evidence: respond with abstain/defer behavior
- Policy violation detected: block or redact response
- Retrieval outage: fail closed with transparent error state
- Low trust threshold: require escalation/human-in-the-loop

## 9. Versioning and Change Control

Every response should capture:

- Model version
- Prompt template version
- Retrieval index version
- Policy bundle version
- Evaluation configuration version

This enables reproducibility and regulator-facing traceability.

## 10. Related Documents

- Compliance framework: /docs/compliance-framework.md
- Evaluation plan: /evaluation/
- Governance assets: /governance/
