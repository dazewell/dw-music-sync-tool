# Copilot instructions for soundiiz-client

## Repository context

This repository is the home of a TypeScript Soundiiz client. It currently contains a small scaffold under `src/`: API/configuration modules, a service placeholder, CLI commands, and an Express web health endpoint. Backup, sync, and durable storage behavior remain to be implemented. Keep new code aligned with the documented boundaries and update the documentation when a deliberate design decision changes.

Read `docs/ARCHITECTURE.md` for component boundaries and data flow, and `docs/MEMORY.md` for durable domain knowledge and workflow conventions. Treat both as living documents: record verified facts, not guesses.

## Workspace standards

- Keep changes focused on the requested behavior. Do not introduce unrelated refactors or generated artifacts.
- Prefer small, composable modules with explicit inputs and outputs over global state or cross-layer reach-through.
- Keep credentials, tokens, exported playlists, and local databases out of source control. Use environment variables or an ignored local configuration file; provide safe examples only.
- Treat user playlist data as private. Avoid logging full track lists, tokens, cookies, or request headers. Redact identifiers where practical.
- Make external-service calls observable and retryable, but never silently convert an authentication, rate-limit, or data-integrity failure into success.
- Preserve deterministic behavior for backup and sync operations. A dry-run or preview should not mutate remote services or local backups.
- Use stable IDs and explicit timestamps for persisted entities. Preserve the source payload needed to diagnose mappings without coupling the domain model to one provider.

## Architecture and design patterns

- **Ports and adapters:** domain services depend on provider/storage interfaces; Soundiiz, Spotify, YouTube Music, filesystem, and database implementations live behind adapters.
- **Canonical model:** normalize playlists, tracks, folders, ownership, and provider references into provider-neutral domain types. Retain provider-specific metadata separately.
- **Pipeline boundaries:** fetch, normalize, compare, plan, apply, and verify are separate stages. A plan is an inspectable value; applying it is an explicit operation.
- **Idempotency:** backup writes and sync operations should be safe to retry. Use stable operation keys, compare-before-write, and checkpoints where a provider supports partial progress.
- **Error taxonomy:** distinguish configuration/authentication errors, transport/rate-limit errors, provider capability errors, validation/mapping errors, and storage errors. Add context and preserve the original cause.
- **Dependency direction:** interface/CLI layers may call application services; application services may call domain ports; adapters implement ports. Domain code must not import CLI, web, provider SDK, or persistence details.
- **Configuration:** load and validate configuration once at the application boundary. Pass typed configuration downward; do not read process environment variables throughout the domain.

## Code style

Follow the language's established formatter, linter, and type checker once the implementation language is selected. Prefer descriptive names, explicit return types where the language supports them, and early validation at boundaries. Avoid broad exception catches, `any`-style escapes, magic strings for provider names, and implicit fallback behavior. Comments should explain a non-obvious constraint, not restate code.

When adding an adapter, include the provider name in logs and errors, centralize request construction, and keep pagination, throttling, and retry policy in the adapter or shared transport layer. Never place provider-specific matching heuristics in the CLI.

## Testing and validation

- Add unit tests for normalization, matching, diff/plan generation, idempotency, and error classification.
- Use contract tests for each provider adapter. Mock external calls in unit tests and reserve live tests for an explicitly configured integration suite.
- Test pagination, empty playlists, duplicate tracks, unavailable tracks, renamed items, private/unowned playlists, rate limits, expired credentials, partial writes, and reruns after interruption.
- Assert that dry-run performs no writes and that secrets are absent from logs and serialized fixtures.
- Run the narrowest relevant formatter, linter, type checker, and test target, then the full suite when shared infrastructure changes. Report commands and failures accurately.

## Fleet and child-agent coordination protocol

The top-level agent is the **orchestrator**. It owns scope, architectural decisions, integration, and final verification. Child agents are specialists with bounded ownership, not independent project managers.

1. Before delegating, the orchestrator writes a precise objective: files or subsystem in scope, expected deliverable, acceptance checks, and explicit out-of-scope items.
2. Delegate independent work in parallel only when changes do not overlap. Assign one owner per file or concern; do not ask multiple agents to make competing edits to the same file.
3. A child agent must inspect existing conventions first, make the smallest complete change, run focused checks, and return a structured handoff: **changed files**, **decisions**, **tests**, **risks/blockers**, and **follow-up needed**.
4. Agents must not broaden scope, rewrite another agent's work, commit secrets, or claim a live-provider fact without evidence. If blocked, stop at the boundary and report the exact missing input.
5. The orchestrator reviews every handoff, resolves conflicts, integrates compatible changes, and runs cross-component tests. “Works locally” is not acceptance without the stated checks.
6. Keep shared state in the repository docs or task tracker, not in private assumptions. Update `docs/MEMORY.md` only with durable, verified knowledge and include a source or date for volatile provider behavior.
7. For failures, retry only after diagnosing the cause. Escalate authentication, destructive-operation, data-loss, or unresolved architecture decisions to the orchestrator rather than guessing.

### Anthropic-style orchestrator/subagent guidance

Use the orchestrator/subagent pattern: the orchestrator decomposes the problem, delegates self-contained tasks, and synthesizes results; subagents execute rather than re-plan the entire project. Prompts should include context, constraints, a clear stop condition, and the required output format. Prefer parallel independent exploration, then a deliberate integration pass. Keep handoffs concise and evidence-based, surface uncertainty explicitly, and avoid redundant re-checking. The orchestrator remains accountable for consistency, security, user intent, and final tests.

