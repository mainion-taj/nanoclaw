---
name: acp
description: Agent Coding Protocol — spawn autonomous Claude Code sessions for long-running coding tasks. Agents report progress milestones and a final summary to the chat. Invoke with /acp spawn claude [task description]. Cross-agent: Mai and Doc can request ACP spawns via A2A.
---

# /acp — Agent Coding Protocol

Spawn an autonomous Claude Code subagent for long-running coding tasks (PR review, feature implementation, refactoring, research, etc.).

## Invocation

```
/acp spawn claude [task description]
```

Or from another agent via A2A:
```
/acp spawn claude [task] --bind [chat_jid]
```

## When to use this skill

Trigger when the user sends `/acp spawn claude ...` or when an A2A message arrives requesting an ACP spawn (format: `ACP_SPAWN: [task]`).

## What to do

1. **Parse the task** from the message after `/acp spawn claude`
2. **Confirm spawn** with a brief one-liner: "Spawning coding agent for: [short task summary]..."
3. **Launch the subagent** using the Agent tool with `run_in_background: true`
4. **Do not wait** — return immediately after confirming the spawn

## Subagent prompt template

Use this exact structure when spawning the Agent:

```
You are an autonomous coding agent spawned via ACP (Agent Coding Protocol).

TASK: [paste the full task description here]

REPORTING INSTRUCTIONS:
- Use mcp__nanoclaw__send_message to report to the user
- Send a brief update (1-2 sentences max) at each major milestone — NOT for every small step
- Milestone examples: "Started analyzing codebase", "Found the issue — fixing now", "PR ready for review"
- Send a FINAL SUMMARY when done: what you did, what changed, any issues found, next steps if any
- Keep all messages concise — the user sees these in Telegram
- Do NOT send implementation details, diffs, or code in messages (use the workspace for that)

TOOLS AVAILABLE: Use Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch as needed.

START WORKING immediately. Don't ask for clarification unless completely blocked.
```

## Cross-agent A2A spawning

If an A2A message arrives with prefix `ACP_SPAWN:`, treat the remainder as the task description and spawn accordingly. The spawned agent should report to the originating peer's bound chat (included in the A2A message as `--bind tg:XXXXXXXXX`).

## Example flow

User: `/acp spawn claude review the PR at github.com/org/repo/pull/42 and summarize issues`

You respond: "Spawning coding agent for PR #42 review..."

Then spawn the subagent with the task. The subagent sends:
- "Reading PR #42..." (optional first update)
- "Found 3 issues: [brief list]" (milestone)
- Final summary with full findings

You go back to being available for other tasks immediately.
