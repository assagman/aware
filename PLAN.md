# aware Local Web App Plan

## Context

Build local-first web app on top of Flue for new coding workflow: user navigates repo/worktree, creates tasks, runs one or more agents, reviews diffs, annotates files/lines/ranges, sends feedback back to agents.

Final product choices from interview:

- App shell: web app + local Node server.
- AI runtime: Flue only for all AI/agent operations.
- App owns: projects, worktrees, tasks, annotations, diffs, reviews, UI, persistence.
- Workspace mode: user selects existing repo + existing worktree only. No app-created worktrees in first version.
- UI libs: Pierre Diffs + Pierre Trees.
- Multi-agent: full orchestration from day one.
- Persistence: SQLite app DB + optional project metadata file.
- Change flow: agents edit selected isolated worktree directly; app also supports patch/apply path later.
- Editor: read/annotate first, direct file editing later.
- Safety: repo allowlist, serialize writes per worktree, command/tool log, approval before commit/push.

Exploration findings:

- Flue (`@flue/sdk`) is headless TS agent harness, not UI framework.
- Flue has sessions, SSE events, built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`, `task`).
- Flue `task` tool supports child agent sessions; use for multi-agent orchestration.
- Flue Node build exposes webhook/SSE routes; app can also embed SDK directly behind local API.
- Flue `sandbox: 'local'` mounts process cwd, so arbitrary user repo/worktree needs custom sandbox/mount wrapper or controlled server cwd per run.
- Pierre Diffs supports patch/file rendering, split/unified views, line selection, annotations, custom annotation rendering.
- Pierre Trees supports path-first file tree, search, git status, context menus.

## Approach

Use monorepo with React frontend, Node local API, shared types. Flue is wrapped behind app-level `AgentRuntime` so UI/task/db logic stays independent from Flue API churn.

High-level architecture:

```txt
React web UI
  -> local Node API
      -> SQLite
      -> Git/file/diff services
      -> annotation/task/agent profile services
      -> Flue AgentRuntime
          -> selected repo/worktree sandbox
```

Core rules:

1. User registers repo root and one or more existing worktree paths.
2. App validates paths with git commands and stores allowlisted paths in SQLite.
3. Each task is bound to one selected worktree.
4. Writes are serialized per worktree to avoid multi-agent conflicts.
5. Multi-agent orchestration starts from a coordinator run that may spawn Flue child tasks.
6. Agents can inspect/read in parallel, but write phase is controlled by worktree lock.
7. All Flue events and tool calls stream to UI and persist as run log.
8. Diffs come from git (`git diff`, `git diff --staged`, `git diff base...HEAD`) and render via Pierre Diffs.
9. File tree comes from backend path listing and renders via Pierre Trees.
10. Annotations are first-class context objects sent into prompts.
11. Commit/push commands require explicit user approval.

## Files to modify

New repo/app expected. Proposed file layout:

```txt
package.json
pnpm-workspace.yaml
tsconfig.base.json

apps/web/
  package.json
  vite.config.ts
  src/main.tsx
  src/app/router.tsx
  src/app/api.ts
  src/pages/FilesPage.tsx
  src/pages/TasksPage.tsx
  src/pages/AgentsPage.tsx
  src/pages/RunDetailPage.tsx
  src/components/FileTreePanel.tsx
  src/components/DiffReviewPanel.tsx
  src/components/AnnotationComposer.tsx
  src/components/AgentRunStream.tsx
  src/components/TaskComposer.tsx
  src/components/AgentProfileForm.tsx
  src/state/useAppStore.ts

apps/server/
  package.json
  src/index.ts
  src/db/schema.ts
  src/db/client.ts
  src/routes/projects.ts
  src/routes/worktrees.ts
  src/routes/tasks.ts
  src/routes/agents.ts
  src/routes/files.ts
  src/routes/diffs.ts
  src/routes/annotations.ts
  src/routes/runs.ts
  src/services/gitService.ts
  src/services/fileService.ts
  src/services/diffService.ts
  src/services/annotationService.ts
  src/services/worktreeLock.ts
  src/services/agentRuntime/flueRuntime.ts
  src/services/agentRuntime/promptBuilder.ts
  src/services/agentRuntime/sessionStore.ts
  src/flue/agents/coordinator.ts
  src/flue/agents/worker.ts
  src/flue/sandbox/localWorktreeSandbox.ts

packages/shared/
  package.json
  src/types.ts
  src/schemas.ts
  src/events.ts
```

If starting in existing repo, add equivalent `apps/web`, `apps/server`, `packages/shared` structure.

## Reuse

### Flue

Use these SDK concepts discovered in `/tmp/pi-github-repos/withastro/flue`:

- `@flue/sdk/client` types: `FlueContext`, `FlueSession`, `ToolDef`, `PromptOptions`, `TaskOptions` from `packages/sdk/src/types.ts`.
- Built-in tools from `packages/sdk/src/agent.ts`: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `task`.
- Session/event model from `packages/sdk/src/session.ts`:
  - `text_delta`
  - `tool_start`
  - `tool_end`
  - `task_start`
  - `task_end`
  - `idle`
  - `error`
- Node/SSE route behavior from `packages/sdk/src/build-plugin-node.ts`.
- Task delegation via Flue `session.task()` and built-in `task` tool.
- Runtime context discovery from `AGENTS.md`, `.agents/skills`, roles.

### Pierre Diffs

Use from `/tmp/pi-github-repos/pierrecomputer/pierre`:

- `@pierre/diffs/react`:
  - `MultiFileDiff`
  - `PatchDiff`
  - `File`
- Core types:
  - `DiffLineAnnotation`
  - `LineAnnotation`
  - `SelectedLineRange`
- Features from examples:
  - `enableLineSelection`
  - `onLineSelectionEnd`
  - `lineAnnotations`
  - `renderAnnotation`
  - split/unified diff options

### Pierre Trees

Use from `@pierre/trees/react`:

- `useFileTree`
- `FileTree`
- path-first model
- search
- git status rows
- context menu for annotate/open/reveal actions

## Data model

SQLite tables:

```txt
projects(id, name, root_path, created_at, updated_at)
worktrees(id, project_id, path, branch, base_branch, created_at, updated_at)
agent_profiles(id, name, description, provider, model, thinking, system_prompt, tools_json, created_at, updated_at)
tasks(id, project_id, worktree_id, title, body, status, orchestration_mode, created_at, updated_at)
task_agents(id, task_id, agent_profile_id, role, order_index)
agent_runs(id, task_id, worktree_id, coordinator_profile_id, status, session_id, started_at, ended_at)
agent_run_events(id, run_id, seq, type, payload_json, created_at)
annotations(id, project_id, worktree_id, task_id, file_path, kind, side, start_line, end_line, text, resolved, created_at, updated_at)
review_threads(id, task_id, annotation_id, status, created_at, updated_at)
review_comments(id, thread_id, author, body, created_at)
locks(worktree_id, owner_run_id, mode, acquired_at, expires_at)
settings(key, value_json)
```

Optional project metadata:

```txt
.aware/project.json
```

Only write this if user opts in. SQLite remains source of truth.

## API design

Local API endpoints:

```txt
GET/POST   /api/projects
GET        /api/projects/:id
POST       /api/projects/validate-path

GET/POST   /api/worktrees
GET        /api/worktrees/:id/status
POST       /api/worktrees/validate-path

GET/POST   /api/agent-profiles
PATCH/DEL  /api/agent-profiles/:id

GET/POST   /api/tasks
GET        /api/tasks/:id
POST       /api/tasks/:id/start
POST       /api/tasks/:id/message

GET        /api/runs/:id
GET        /api/runs/:id/events
GET        /api/runs/:id/stream        # SSE
POST       /api/runs/:id/approve-command
POST       /api/runs/:id/cancel

GET        /api/files/tree?worktreeId=
GET        /api/files/read?worktreeId=&path=

GET        /api/diffs/git?worktreeId=&mode=unstaged|staged|base
POST       /api/diffs/apply-patch

GET/POST   /api/annotations
PATCH/DEL  /api/annotations/:id
```

## Flue runtime design

Create app-level runtime interface:

```ts
interface AgentRuntime {
  startRun(input: StartRunInput): Promise<AgentRunHandle>;
  sendMessage(runId: string, message: AgentMessageInput): Promise<void>;
  cancelRun(runId: string): Promise<void>;
}
```

Implement `FlueRuntime`:

- Creates or reuses Flue session per run.
- Uses selected worktree as sandbox root.
- Builds prompt from task + annotations + selected files + selected diff ranges.
- Streams Flue events into `agent_run_events` and SSE clients.
- Uses coordinator agent for orchestration.
- Uses Flue child tasks for parallel research/specialized agents.

Coordinator prompt responsibilities:

1. Restate task.
2. Inspect relevant files.
3. Delegate parallel research tasks to chosen agents/roles.
4. Summarize findings.
5. Acquire write lock before edits.
6. Apply changes.
7. Run verification commands if allowed.
8. Report changed files and next review points.

Worker agent responsibilities:

- Focused research or implementation subtask.
- Return concise structured output.
- Avoid writes unless coordinator grants write phase.

## Worktree sandbox design

Need custom sandbox wrapper because Flue `sandbox: 'local'` maps process cwd to `/workspace`, not arbitrary selected path.

Plan:

1. Build `createLocalWorktreeSandbox(worktreePath)` using `just-bash` `ReadWriteFs` + `MountableFs` if available from public APIs.
2. Mount selected worktree path at `/workspace`.
3. Set cwd to `/workspace`.
4. Restrict all backend file/git services to allowlisted worktree path.
5. Add tests that path traversal cannot escape worktree via API.

Fallback if direct custom sandbox API blocks:

- Run Flue handler from child process with cwd set to selected worktree.
- Use `sandbox: 'local'` inside that process.
- Still keep app API as owner of state and logs.

## UI flow

### Projects page

- Add local repo path.
- Validate with `git rev-parse --show-toplevel`.
- Show allowlisted repos.

### Worktrees page

- User adds existing worktree path.
- Validate with `git worktree list --porcelain` and root match.
- Show branch, status, dirty state.

### Agents page

- CRUD agent profiles.
- Fields: name, description, provider, model, thinking, system prompt, tools, default role.
- No direct provider calls outside Flue.

### Tasks page

- Create task bound to worktree.
- Attach files/annotations/diff ranges.
- Select orchestration: coordinator + worker agents.
- Start run.

### Files page

- Pierre Trees left panel.
- File read-only viewer main panel.
- Add file/line/range annotations.
- Chat with selected agent(s) using current context.

### Diffs page

- Pierre Diffs git diff render.
- Select line/range.
- Add comments.
- Send review feedback to same run/session.
- Require approval for commit/push.

### Run detail page

- Live assistant stream.
- Tool/command log.
- Child task timeline.
- Changed files.
- Current diff.
- Feedback composer.

## Steps

- [ ] Create monorepo skeleton with `apps/web`, `apps/server`, `packages/shared`.
- [ ] Add shared schemas/types for projects, worktrees, tasks, agent profiles, annotations, runs, events.
- [ ] Build SQLite schema and migrations.
- [ ] Implement repo/worktree validation and allowlist service.
- [ ] Implement git service for status, branches, diff, staged diff, base diff.
- [ ] Implement file service for tree listing and safe read.
- [ ] Implement annotation CRUD and context serialization.
- [ ] Implement agent profile CRUD.
- [ ] Implement task CRUD and task-agent assignment.
- [ ] Implement worktree write lock service.
- [ ] Implement Flue `AgentRuntime` wrapper and persistent event logging.
- [ ] Implement selected-worktree sandbox wrapper or cwd child-process fallback.
- [ ] Implement coordinator + worker Flue agent prompts.
- [ ] Implement SSE `/api/runs/:id/stream`.
- [ ] Implement web app routing/layout.
- [ ] Implement Projects and Worktrees pages.
- [ ] Implement Agents page.
- [ ] Implement Tasks page and run start flow.
- [ ] Implement Run Detail page with event stream/tool logs.
- [ ] Implement Files page with Pierre Trees and read-only viewer.
- [ ] Implement Diffs page with Pierre Diffs, line selection, annotations.
- [ ] Implement feedback loop: selected annotations/diff comments -> same Flue session.
- [ ] Implement approval gates for commit/push commands.
- [ ] Add tests for safe path handling, worktree validation, locks, prompt context generation.
- [ ] Add manual end-to-end smoke script.

## Verification

Automated:

- Typecheck all packages.
- Unit-test path safety: reject `..`, symlink escapes, non-allowlisted paths.
- Unit-test git service with temp repo/worktree fixture.
- Unit-test annotation-to-prompt serialization.
- Unit-test worktree lock serialization.
- Unit-test Flue runtime event persistence with fake/mock session if possible.

Manual E2E:

1. Start local server and web UI.
2. Add existing git repo.
3. Add existing worktree path.
4. Open Files page; verify tree + file content.
5. Add file annotation and line annotation.
6. Open Diffs page; verify `git diff` renders with Pierre Diffs.
7. Create two agent profiles.
8. Create task, attach annotations, select coordinator + workers.
9. Start run; verify SSE text/tool/task events stream.
10. Confirm worktree lock while run active.
11. Verify agent edits worktree.
12. Review diff in Diffs page.
13. Add feedback annotation on diff line.
14. Send feedback to same session; verify follow-up run continues context.
15. Try commit/push; verify approval gate.
16. Stop/cancel run; verify status/log persistence after refresh.

## Open implementation notes

- Flue public APIs are experimental; keep wrapper boundary small.
- Full multi-agent from day one should still serialize write phase by worktree.
- Direct editing deferred; viewer/annotations first.
- App must never expose unrestricted filesystem browsing; only allowlisted repos/worktrees.
- Commit/push approval should be normal UX, not hidden safety feature.
