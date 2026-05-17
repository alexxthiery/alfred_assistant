---
id: decision-vault-as-graph
title: Vault-as-graph over flat notes
type: decision
created: 2025-12-01
updated: 2025-12-01
decided_on: 2025-12-01
tags: [decision, meta]
---

# Decision: vault-as-graph over flat notes

[[alice]] chose to maintain personal knowledge as a typed graph (one concept per page, typed relations) rather than flat markdown notes.

Rationale (prose, not lint-checked bullets): flat notes accumulate orphans, the graph forces every fact to attach somewhere; closed-set tags + types make automation tractable; LLM agents drive the writing through the CLI, and the schema is the contract.

- [decision] Adopt the Karpathy-style LLM-wiki pattern ^[example:setup]
- [fact] Reviewed alternatives: Obsidian flat notes, Logseq blocks, raw Org-mode ^[example:setup]
- mentions [[paper-llm-wiki-2024]]
- mentions [[spaced-repetition]]
