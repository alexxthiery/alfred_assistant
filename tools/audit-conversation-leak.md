# Conversation leak audit — manual rerun

To re-measure capture-leak rate after persona changes, paste the prompt
below into an Agent call (`subagent_type=general-purpose`). Substitute
`{{START_DATE}}` / `{{END_DATE}}` with the audit window (typically last 7
days) and `{{TRANSCRIPT_PATH}}` with the most recent Claude Code session
jsonl path. Find it via:

```bash
# Find the newest session jsonl for the _AI_box project under ~/.claude/projects/
# (the project dir name encodes the absolute path with hyphens substituted for slashes).
/bin/ls -lht ~/.claude/projects/*--AI-box*/*.jsonl | head -1
```

The audit reports per-day:
- Total user messages
- Capture verb invocations (`wiki capture` / `predict` / `hypothesize` / `patch --observation`)
- Capturable-but-uncaptured signal, with proposed category routing
- `wiki search` invocation count
- Contradiction-surfacing count
- Verdict: leak rate, strategic importance of what was lost

Target after Phase 10:
- leak rate < 30% (was ~100% before)
- `wiki search` >= 1 per substantive topical turn (was 0/day)
- >= 1 contradiction surfaced if {{USER_NAME}} re-states a prior principle

---

## Subagent prompt (parameterized)

```
You are auditing a user's recent interactions with their personal AI
assistant ("Alfred"). The goal: assess how much capturable signal is
being lost between conversation and the user's typed-graph vault.

The interactions live in a Claude Code session transcript at:
  {{TRANSCRIPT_PATH}}

This is a JSONL file, one JSON object per line. Each line has a `type`
field (`user`, `assistant`, `tool_use`, `tool_result`, etc.) and a
`timestamp` field. Audit window: **{{START_DATE}}** through **{{END_DATE}}**
(inclusive, ISO dates like 2026-05-18).

Per day in the window, extract:

1. **User messages**: only the user-typed prompts (not system reminders,
   not hook output). Filter by timestamp prefix matching the day. The
   user field is typically at `.message.content` in entries where
   `.type == "user"` and content is a string (not a tool_result).

2. **Capture activity**: count tool_use entries where Bash command
   contains `wiki capture`, `wiki predict`, `wiki hypothesize`, or
   `wiki patch --observation`. Distinguish real-vault invocations from
   test-fixture / smoke-test invocations (test paths like /tmp/* or
   slugs like `capture-*`, `secret-patch-test`, etc.).

3. **Search activity**: count tool_use entries where Bash command
   contains `wiki search` or `wiki resolve` against the real vault.

4. **Contradiction-surfacing**: scan assistant responses for the
   pattern of citing a prior principle/decision/observation BEFORE
   proposing a course of action that contradicts it. Look for phrases
   like "you said on YYYY-MM-DD ...", "this contradicts ...",
   "principle X conflicts with proposal Y", or cited obs-ids
   (`<!--obs:XXXXXX-->`) introduced as a check on a proposal.

5. **Capturable-but-uncaptured signal**: scan user messages for things
   that look like:
   - **Opinions** ("I prefer X over Y", "X is the best")
   - **Hypotheses** ("I think X", "X might Y", "X probably Z")
   - **Decisions** ("I've decided X", "going with Y", "I'm dropping Z")
   - **Predictions** ("X will happen by Y")
   - **Questions** ("why does X?", "I wonder if Y")
   - **Third-party claims** ("Person says X")
   - **Self/world facts** ("my X is Y", "Z happened on date")

   For each candidate, note: (a) one-line paraphrase, (b) the category
   it would route to, (c) whether the assistant captured it
   (yes/no/partial).

Return a structured report under 900 words with:

**Per-day overview**: counts of user messages, capture invocations
(real-vault vs test), search/resolve invocations, contradiction-surfaces.

**Per-day capturable signal**: bulleted list of the strongest 6-10
candidates the assistant missed. Format:
`[category] paraphrased text (captured: yes/no/partial)`.

**Verdict**: 3-5 sentences. What's the leak rate? Were lost items
strategically important (long-half-life insights, decisions,
calibratable predictions) or trivial? Is the user's stated North Star
(intellectual companion that pushes back, finds connections, manages
life, supports IFS/psychology) being served by current behavior?

**Reflex evaluation**: rate each of the three reflexes 0-2 (0=not
firing, 1=partial, 2=consistent):
- Reflex 1 (search before answering): did the assistant query the
  vault before answering topical questions?
- Reflex 2 (volunteer captures at breakpoints): did the assistant
  STOP and propose captures at natural breakpoints?
- Reflex 3 (surface contradictions before proposing): did the
  assistant cross-reference prior principles before proposing builds?

**Trend vs prior audit**: if a prior audit on a comparable window
exists, compare leak rate, search count, contradiction count.

Important constraints:
- Do NOT load the whole file into a single Read call (it can be 40MB+).
  Use grep with line numbers, then targeted Reads.
  Example: `grep -n '"timestamp":"{{START_DATE}}' file.jsonl | head -200`
  then Read specific line ranges.
- jq helps:
  `cat file.jsonl | jq -c 'select(.type=="user" and (.timestamp // "" | startswith("{{START_DATE}}"))) | .message.content' | head -100`
- Preserve PII as it appears in the transcript. This is internal
  analysis for the user themselves; no redaction needed.
- If a user message is itself a system-reminder or hook payload,
  exclude it.
- Report only. Do not write code or modify any files.
```

---

## Notes

- Audit cadence: rerun every 2-4 weeks after a persona change. Not more
  often than weekly; the signal is too noisy in short windows.
- The audit IS the eval for persona changes. Before claiming "the
  persona is better," rerun it.
- The audit subagent prompt above was validated on the May 18-19, 2026
  audit window that originated this artifact. Found ~100% leak rate
  and identified the specific persona gaps (Reflex 1/2/3 inertness)
  that Phase 10 addresses.
