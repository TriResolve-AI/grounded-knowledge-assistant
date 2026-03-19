# Compliance Framework

## 1. Objective

This framework defines how Grounded Knowledge Assistant enforces governance, risk, and compliance requirements across the RAG lifecycle. It is intended to support regulated deployments where explainability, traceability, and policy adherence are mandatory.

## 2. Compliance Principles

1. Grounding First: Every factual claim must map to approved source evidence.
2. Policy by Design: Governance checks are part of request execution, not post-processing.
3. Least Privilege: Access to sources and outputs is role- and context-constrained.
4. Auditability: Every decision is logged with enough detail for replay and review.
5. Human Oversight: High-risk or low-confidence outcomes are escalated.

## 3. Control Domains

### 3.1 Data Governance Controls

- Source allowlist and ownership verification
- Data classification and handling labels
- Retention and deletion policy enforcement
- PII/sensitive-data detection during ingestion and response generation

### 3.2 Retrieval and Grounding Controls

- Metadata-based retrieval filters (jurisdiction, document status, access class)
- Citation completeness checks before release
- Unsupported-claim detection with abstain/defer strategy
- Freshness checks against document effective and expiry dates

### 3.3 Model and Prompt Controls

- Approved model registry and version pinning
- Prompt template versioning and change approval
- Restricted system behaviors for regulated topics
- Safety policy gates for harmful or disallowed outputs

### 3.4 Access and Identity Controls

- User authentication and RBAC/ABAC policy evaluation
- Environment separation (dev, test, prod)
- Segregation of duties for policy editing vs runtime operations
- Session and request-level identity traceability

### 3.5 Audit and Evidence Controls

- Immutable event logging for request and response lifecycle
- Signed/hashed evidence references for integrity verification
- Policy decision logging with rule-level outcomes
- Retention schedule for audit artifacts and decision records

## 4. Policy Decision Lifecycle

1. Load context (user role, tenant, region, policy bundle).
2. Validate request admissibility.
3. Enforce retrieval constraints.
4. Evaluate generated answer for grounding and policy compliance.
5. Assign decision status: allow, redact, defer, or block.
6. Persist decision rationale and supporting evidence.

## 5. Decision Outcomes

- Allow: response meets grounding and policy requirements.
- Redact: response is partially allowed with sensitive content removed.
- Defer: insufficient confidence or elevated risk requires human review.
- Block: policy violation or unacceptable risk prevents release.

## 6. Risk Scoring and Thresholds

A risk score can be derived from policy violations, uncertainty, and sensitivity class:

$$
Risk = f(V, U, S, E)
$$

Where:

- $V$: violation severity
- $U$: uncertainty signal
- $S$: sensitivity classification
- $E$: evidence completeness gap

Example threshold policy:

- $Risk < 0.3$: allow
- $0.3 \le Risk < 0.6$: redact or cautionary response
- $Risk \ge 0.6$: defer or block

Thresholds should be calibrated through evaluation in regulated use cases.

## 7. Human-in-the-Loop Governance

Escalation is required for:

- Low trust / high risk decisions
- Novel policy boundary cases
- Repeated user attempts after blocks
- High-impact domains (legal, clinical, financial adjudication)

Human review actions should be logged with reviewer identity, rationale, and final disposition.

## 8. Change Management

All changes to policy, prompts, model versions, and retrieval behavior must include:

- Change request and business justification
- Risk assessment and approval
- Test and evaluation evidence
- Rollback plan
- Effective date and owner

## 9. Compliance Monitoring and Reporting

Recommended metrics:

- Citation coverage rate
- Unsupported-claim rate
- Policy violation rate by category
- Defer/block rate by business function
- Human override frequency and reasons

Reporting cadence should align with internal audit and external regulatory obligations.

## 10. Documentation and Artifacts

Minimum artifact set:

- Policy catalog and rule definitions
- Model and prompt inventory
- Data source register
- Audit log schema and retention policy
- Evaluation reports and drift analyses

## 11. Alignment and Extensibility

This framework is intentionally control-oriented and can be mapped to organization-specific obligations (for example, sector regulations, enterprise control frameworks, and internal risk policies). Mapping tables should be maintained in governance artifacts as requirements evolve.

## 12. Related Documents

- System architecture: /docs/architecture.md
- Governance folder: /governance/
- Evaluation assets: /evaluation/
