# Prior-art research — AI team orchestrator (2026-10-19)

Condensed from four parallel research passes. [V] = verified in source, [I] = inference.

## 1. MetaGPT / MGX (now "Atoms")
- Open-source MetaGPT effectively dormant: last release v0.8.2 (Mar 2025), last push Jan 2026, stale-bot closing bugs. [V]
- MGX launched Feb 2025, rebranded Atoms (atoms.dev) Jan 2026: closed, chat-driven app builder; agents Mike (lead), Emma (PM), Bob (architect), Alex (engineer) + others. Race Mode = up to 4 parallel teams scored by build/tests/runtime errors, human picks. [V]
- Original design: roles `_watch` upstream action types and `set_actions`; shared message pool with pub/sub; typed, schema-validated docs (PRD → design → task list → code) with recorded `dependencies`. [V]
- Later RoleZero design routes everything through an LLM Team Leader — their own code comment says it "doesn't understand the message well". [V]
- Memory: `exp_pool` = cache of (request, response, LLM-judge score), off by default; no playbooks, no pruning, no published evidence it helps. [V]
- Incremental mode on existing repos works poorly (maintainers: "complex research problem"; unfixed crash in 0.8.2). [V]
- Berkeley MAST study: 41–86.7% failure across 7 MAS; MetaGPT fewer spec failures than ChatDev but more verification failures; verifiers often superficial (compiles = done). [V]
- Atoms complaints: context handling (#1 on Product Hunt), credit burn, "fixing spiral", lost progress. [V]
- AOrchestra (same team, 2026): sub-agent = ⟨Instruction, Context, Tools, Model⟩ curated per subtask. [V]

## 2. ChatDev + experience-learning research
- ChatDev 2.0 ("DevAll", Jan 2026) is a generic YAML/GUI multi-agent workflow platform; the virtual-company version lives on `chatdev1.0` branch; ECL/IER learning not carried into 2.0. [V]
- ECL: shortcut experiences from trajectories, top-1–2 injected as few-shot; storing everything (1,604 vs 537) lowered quality. [V]
- IER: pruning by information gain + retrieval frequency shrank pool to 11.5% with equal/better quality. [V]
- All on toy SRDD benchmark with GPT-3.5 — weak evidence for "improves across projects". [I]
- ACE (ICLR 2026): playbook of bullets {id, helpful/harmful counters, content}; Generator → Reflector → Curator emits deltas; merge is deterministic code. AppWorld +17 pts. Full LLM rewrite collapsed playbook 18,282 → 122 tokens and scored below no-memory baseline. Needs reliable feedback; bad reflector hurts. [V]
- ReasoningBank: ≤3 items per trajectory incl. failures; failure lessons add value (46.5 → 49.7); SWE-bench gains +3–4.6 pts. [V]
- AWM: workflows induced from judged successes; agents used them only 18.5% of the time. [V]
- ExpeL: rule list with ADD/EDIT/UPVOTE/DOWNVOTE, removed at 0. [V]
- Voyager: skills as verified executable code, retrieved by embedding. [V]
- Failure-mode evidence (2026):
  - SkillsBench: curated skills +16.6; self-generated −8 to −11.5; 2–3 focused modules +19 vs "comprehensive" +0.7. [V]
  - AGENTS.md study: LLM-written context files reduce success and raise cost 20–23%; human-written +4; repo overviews don't help. [V]
  - Memory-management study: add-everything worse than fixed memory; selective add/delete ≈ +10%. [V]
  - OEP: over-generalized lessons poison reflective agents, evade LLM auditing. [V]
  - RIZZ: one shared memory lets failures in one task family contaminate another; only verifier-confirmed results should update memory. [V]
  - STALE: best model detects stale memory only 55% of the time. [V]
  - No study found of role-level playbooks carried across software projects — our differentiator is unvalidated. [V]

## 3. General frameworks (CrewAI, LangGraph, Microsoft Agent Framework)
- LangGraph 1.2.x: state graph, per-super-step checkpoints, time travel/fork, `interrupt()` HITL, Store for long-term memory; Deep Agents keeps memory as AGENTS.md + SKILL.md files with progressive loading and a consolidation agent (no size cap). [V]
- CrewAI 1.15: sequential/hierarchical crews, Flows, SQLite persistence + fork; unified memory with LLM-decided dedup (keep/update/delete), recency half-life, no size cap, silent degradation on LLM failure; `crewai train` and `@human_feedback(learn=True)` distill human corrections into per-role lessons. Hierarchical manager delegation is a known failure. [V]
- Microsoft Agent Framework 1.0 (Apr 2026), AutoGen archived. Magentic orchestration: task ledger + progress ledger + stall counter → replan/reset; optional human plan approval. HITL as persisted pending requests re-emitted on restore. [V]
- All three checkpoint at node boundaries: a long `claude -p` worker is one opaque node → crash/retry re-runs whole worker incl. side effects (open issues in all three). [V]
- Recommendation: own small engine (task state machine + event log + pending requests); worktree per attempt for idempotent retries. If forced to pick: LangGraph. [I]

## 4. Coding-agent orchestrators
- Convergent pattern: fresh worker per task + git/documents as source of truth — Factory Missions (orchestrator plans milestones, fresh worker per feature, validators at milestones, failures become fix features, model per role), Anthropic long-running harness (feature-list JSON where workers may only flip `passes`, progress file, one feature per session), Cursor (planner/worker/judge, periodic fresh starts). [V]
- Knowledge in market: Devin playbooks (Procedure / Specifications / Advice / Forbidden / Required-from-user) migrating to SKILL.md skills; Copilot Memory = citation-validated facts that expire after 28 days unused; OpenHands skills (always-on, keyword, path, SKILL.md). All repo/org scoped — none role-level cross-project. [V]
- Wrapper UIs dying (Vibe Kanban shut down, Terragon shut down, Crystal deprecated): first-party tools absorbed the UI layer; defensible value is process + knowledge. [V/I]
- Cognition: argues against multi-agent; handoffs lose context → put evidence (logs, diffs, test output) into artifacts, not just summaries. [V]
- Claude Code headless: `claude --bare -p --output-format stream-json --verbose --json-schema … --permission-mode … --allowedTools … --max-turns N --max-budget-usd X`; result has `session_id`, `total_cost_usd` (estimate), `usage`, `structured_output`, `subtype`; stop with SIGINT (SIGTERM records no result); `--bare` skips CLAUDE.md/hooks/MCP and needs API key; third-party products must use API-key auth. Agent teams: experimental, interactive, ~7x tokens. [V]
- Codex headless: `codex exec --json --output-schema f.json -o out.txt --sandbox workspace-write`, prompt on stdin; JSONL events with `thread_id` and usage; `resume`; AGENTS.md concatenated root→cwd, 32 KiB cap. [V]

## 5. Jev (TypeSafe AI) — "System One" judgment model
- Source: https://en.wikipedia.org/wiki/Jev_(AI_model) plus third-party integration docs (LiteLLM, Portkey); no TypeSafe primary docs read yet.
- Proprietary discriminative model (classification/regression, NOT text generation). Early access since 2026-09-15; stable jev-1.13.0. TypeSafe AI, SF, $40M seed (DCVC).
- Input: `state` (string / JSON / string array) + typed `questions`: `noul` (yes/no), `choice` (unordered options), `score` (ordered rubric, 2–10 levels). Questions can reference JSON state attributes.
- Output: one calibrated probability distribution per question; choice/score/confidence derived by fixed formulas.
- Limits: 64k input (32k state + longest question); questions answered in parallel — dependent questions need sequential calls.
- Vendor claims (unverified): 70–500 ms, 40–200x faster and 40–400x cheaper than frontier LLMs; ~$0.042/M input tokens, output free.
- Architecture/training unpublished ("RLCD", synthetic data). No independent benchmarks.
- Integrations: REST (POST /v1/systemone), LiteLLM/Portkey passthrough, community MCP servers (jev-mcp). Recommended pattern: code/planner owns global logic; Jev answers bounded atomic judgments only.
- Blog-reported: plan-level error detection remains unsolved.
