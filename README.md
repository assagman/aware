# Agent IDE

Local-first web app for agent-driven coding on existing git repos/worktrees.

## Model defaults

Primary:

- provider: `kimi-coding`
- model: `k2p6`
- Flue model id: `kimi-coding/k2p6`
- env: `KIMI_API_KEY`

Fallback:

- provider: `zai`
- model: `glm-5.1`
- Flue model id: `zai/glm-5.1`
- env: `Z_AI_API_KEY` or `ZAI_API_KEY`

## Run

```bash
pnpm install --ignore-scripts
KIMI_API_KEY=... pnpm dev
```

Open web at `http://127.0.0.1:5173`.

## Flow

1. Add existing git repo path.
2. Add existing worktree path.
3. Confirm default Kimi agent or create another.
4. Create task.
5. Start run.
6. Review run events, files, diffs.
7. Annotate diff lines and send feedback.

## Safety

- Only allowlisted worktrees are used.
- File reads reject path traversal.
- Prompts forbid commit/push without approval.
- Approval API exists for commit/push gates.
