# New Aware Plan

## Direction

Build Aware as an API-first global cockpit.

Core rule: graph UI never owns graph behavior. UI calls same command APIs future AI agents/tools will call.

## Product Model

- `/` is global Home graph: all projects, tasks, runs, worktrees, statuses.
- Project routes provide ownership context, not isolation.
- Every durable view has URL.
- Every graph action is exposed as API command.
- localStorage stores UI prefs only, not navigation.

## Browser Routes

```txt
/                                                            HomePage: global graph

/projects/:projectId                                        ProjectPage: focused project graph/detail
/projects/:projectId/tasks/:taskId                          TaskPage: task detail/review/checkpoint
/projects/:projectId/tasks/:taskId/runs/:runId               RunPage: single run chat

/projects/:projectId/worktrees/:worktreeId/files             FilesPage: worktree file browser
/projects/:projectId/worktrees/:worktreeId/files/*           FilesPage: specific file path
/projects/:projectId/worktrees/:worktreeId/diffs             DiffsPage: worktree diffs
/projects/:projectId/worktrees/:worktreeId/diffs?file=path   DiffsPage: selected changed file

/settings                                                    SettingsPage
/settings/:section                                           Settings section
```

No shortcut routes. No redirects.

Validation failures render 404/invalid route state:

| Route | Validate |
|---|---|
| task | `task.projectId === projectId` |
| run | `run.taskId === taskId` and `task.projectId === projectId` |
| worktree | `worktree.projectId === projectId` |

## API Contract

Scoped, domain-shaped endpoints:

```txt
GET    /api/graph
GET    /api/projects/:projectId/graph

GET    /api/projects
POST   /api/projects
GET    /api/projects/:projectId

POST   /api/projects/:projectId/tasks
GET    /api/projects/:projectId/tasks/:taskId
PATCH  /api/projects/:projectId/tasks/:taskId
POST   /api/projects/:projectId/tasks/:taskId/done

POST   /api/projects/:projectId/tasks/:taskId/runs
GET    /api/projects/:projectId/tasks/:taskId/runs/:runId
POST   /api/projects/:projectId/tasks/:taskId/runs/:runId/messages
POST   /api/projects/:projectId/tasks/:taskId/runs/:runId/retry
DELETE /api/projects/:projectId/tasks/:taskId/runs/:runId

POST   /api/projects/:projectId/tasks/:taskId/checkpoints

GET    /api/projects/:projectId/worktrees/:worktreeId/files
GET    /api/projects/:projectId/worktrees/:worktreeId/files/content?path=x
GET    /api/projects/:projectId/worktrees/:worktreeId/diffs

GET    /api/tools/graph
```

`/api/tools/graph` returns tool definitions generated from shared schemas.

## Architecture

```txt
packages/shared
  schemas.ts              command/input/output schemas
  types.ts                shared domain types

apps/server/src/services/graph
  commands.ts             graph command handlers
  projection.ts           graph projection builder
  validation.ts           ancestry/resource validation
  events.ts               audit/domain events

apps/server/src/routes
  graph.ts                thin graph projection routes
  scoped-projects.ts      thin scoped HTTP wrappers
  tools.ts                tool manifest endpoint

apps/web/src/app
  router.tsx              browser routes + app shell

apps/web/src/pages
  HomePage.tsx            global graph render
  ProjectPage.tsx         focused graph/detail
  TaskPage.tsx            task detail/checkpoint
  RunPage.tsx             run chat
  FilesPage.tsx           worktree files
  DiffsPage.tsx           worktree diffs
  SettingsPage.tsx        app settings
```

## Graph Projection

Move graph meaning to server projection:

```txt
GET /api/graph
→ nodes[]
→ edges[]
→ actions[]
→ resource refs
→ statuses
```

ReactFlow renders projection only. Buttons/actions call command APIs.

Node/action shape should include:

```ts
type GraphAction = {
  id: string;
  label: string;
  command: string;
  inputSchema: string;
  payload: Record<string, unknown>;
  href?: string;
};
```

## State Ownership

| State | Owner |
|---|---|
| current page/resource/mode | URL |
| graph/project/task/run/worktree data | API/loaders/hooks |
| graph commands | server services |
| expanded tree, panel sizes, last fallback project | localStorage |
| dialogs, dropdowns, drafts | React state |

## One-Shot Implementation Scope

Implement as one coherent change, not staged migration.

- Add scoped server endpoints with ancestry validation.
- Extract graph command handlers and shared Zod schemas.
- Add graph projection endpoint.
- Add `/api/tools/graph` manifest generated from schemas.
- Add React Router routes and `AppShell`.
- Split pages into `HomePage`, `ProjectPage`, `TaskPage`, `RunPage`, `FilesPage`, `DiffsPage`, `SettingsPage`.
- Replace `activeRunId` and `workspaceView` navigation state with route params.
- Convert graph clicks/buttons to `Link`/`navigate` plus command API calls.
- Remove old state-only navigation.
- Keep old flat HTTP endpoints only as compatibility wrappers if still used by non-graph surfaces.
- Browser-test direct URLs, refresh, back/forward, invalid ancestry, and 404 states.

## Long-Term Guarantees

| Need | Design answer |
|---|---|
| Global visibility | `/` shows all projects/tasks/runs/worktrees |
| Human graph use | ReactFlow renders API projection |
| Agent graph use | tools call same server commands |
| No hidden UI behavior | behavior lives in command handlers |
| Stable navigation | URL encodes durable location |
| Run identity safety | route includes project/task/run ancestry |
| Future extensibility | schemas generate HTTP/tool contracts |
