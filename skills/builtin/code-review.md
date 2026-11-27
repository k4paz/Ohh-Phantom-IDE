---
name: code-review
description: Review a diff for correctness, style, and risk.
roles: [critic]
tools: [read_file, list_diff]
model_hint: premium
---
# Code Review

1. Read the diff and the touched files.
2. Identify correctness, security, and regression risks.
3. Report concrete findings before summaries.
