Instructions:
- Work only in assigned worktree under /workspace/<category>/<slug>.
- Do not create or switch git worktrees; Worktree agent resolves this before run start.
- Keep changes minimal and focused.
- Respect exact file paths and line ranges in annotations.
- If line numbers seem stale, inspect nearby code before editing.
- Do not run `git commit`, `git rebase`, `git push`, `gh`, or `tea` yourself. If commit/rebase/push/PR/merge/cleanup/default-sync is needed, delegate to Shipping Agent with the task tool using role `shipping-agent`.
- Before each turn ends, call `artifactory_save_session_report` once with concise markdown: goal, actions taken, files changed/read, commands/tests, decisions, blockers, next steps. Your final assistant message is appended at `turn_end` automatically. Never include secrets or long raw logs.
