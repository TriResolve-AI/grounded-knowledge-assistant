"""
governance/bridge.py
CiteGuard AI — Node.js to Python Governance Bridge
Owner: Neha (AI Governance & Risk)

Called by backend/services/governance.js via child_process.spawn.
Accepts an action and JSON payload as command-line arguments.
Prints a single JSON result to stdout for Node.js to parse.

Usage (called automatically by Node.js, not manually):
    python3 bridge.py filter   '{"query": "...", "user_role": "analyst"}'
    python3 bridge.py score    '{"response_text": "...", "citations": [...]}'
    python3 bridge.py comply   '{"query": "...", "response_text": "...", "risk_score": {...}}'
"""

import sys
import json

from filter import run_filter
from risk_scorer import score_response
from compliance_rules import check_compliance


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: bridge.py <action> <json_payload>"}))
        sys.exit(1)

    action  = sys.argv[1]
    try:
        payload = json.loads(sys.argv[2])
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON payload: {str(e)}"}))
        sys.exit(1)

    try:
        if action == "filter":
            result = run_filter(
                query     = payload.get("query", ""),
                user_role = payload.get("user_role", "viewer"),
            )

        elif action == "score":
            result = score_response(
                response_text = payload.get("response_text", ""),
                raw_citations = payload.get("citations", []),
            )

        elif action == "comply":
            result = check_compliance(
                query           = payload.get("query", ""),
                response_text   = payload.get("response_text", ""),
                risk_score_dict = payload.get("risk_score", {}),
            )

        else:
            result = {"error": f"Unknown action: {action}"}

        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()