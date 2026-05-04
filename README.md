# aware

Local-first web app for agent-driven coding on existing git repos/worktrees.

## Requirements

- Node.js with `node:sqlite` support (Node 22+ recommended)
- pnpm 9.15.x
- A git repo and an existing git worktree to register in the app

## Model defaults

Default agent profile:

- name: `Main`
- provider: `openai-codex`
- model: `openai-codex/gpt-5.5`
- auth: OpenAI subscription OAuth from the Agents page, or an API key saved there

Other built-in model choices:

- `kimi-coding/k2p6` with `KIMI_API_KEY`
- `zai/glm-5.1` with `Z_AI_API_KEY` or `ZAI_API_KEY`

If Kimi auth is missing but Z.AI auth is available, runs fall back to `zai/glm-5.1`.

## Run

```bash
pnpm install --ignore-scripts
pnpm dev
```

The local API listens on `http://127.0.0.1:8787` and the web app opens at `http://127.0.0.1:5173` by default.

Override local dev ports and DB path with env vars:

```bash
API_PORT=8789 WEB_PORT=5179 AWARE_DB="$PWD/.aware/manual-test.sqlite" pnpm dev
```

Data is stored in SQLite at `.aware/db.sqlite` under the server working directory by default. Set `AWARE_DB=/path/to/db.sqlite` (or `DB_PATH`) to override it.

## Flow

1. Add an existing git repo path.
2. Add an existing worktree path for that repo.
3. Confirm the default `Main` agent or create another on the Agents page.
4. Create a task for the selected worktree.
5. Start a run.
6. Review run events, files, diffs, and annotations.
7. Annotate files or diff lines and send feedback or direct chat context back to the agent.

## Safety

- Only allowlisted worktrees are used.
- File reads reject path traversal and symlink escapes.
- Prompts forbid commit/push without approval.
- Approval APIs exist for commit/push gates.
