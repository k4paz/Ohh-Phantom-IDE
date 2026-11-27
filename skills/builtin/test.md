---
name: test
description: Diagnose and run the project test suite.
roles: [worker]
tools: [read_file, run_tests]
model_hint: standard
---
# Test

1. Detect the project test command.
2. Run the focused suite when possible.
3. Report exact failures and reproducible commands.
