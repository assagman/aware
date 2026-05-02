import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { agents } from "./routes/agents";
import { annotations } from "./routes/annotations";
import { approvals } from "./routes/approvals";
import { chat } from "./routes/chat";
import { diffs } from "./routes/diffs";
import { feedback } from "./routes/feedback";
import { files } from "./routes/files";
import { projects, worktrees } from "./routes/projects";
import { runs } from "./routes/runs";
import { settings } from "./routes/settings";
import { tasks } from "./routes/tasks";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/projects", projects);
app.route("/api/worktrees", worktrees);
app.route("/api/agents", agents);
app.route("/api/tasks", tasks);
app.route("/api/runs", runs);
app.route("/api/files", files);
app.route("/api/diffs", diffs);
app.route("/api/annotations", annotations);
app.route("/api/feedback", feedback);
app.route("/api/approvals", approvals);
app.route("/api/settings", settings);
app.route("/api/chat", chat);

const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
	console.log(`agent-ide server listening on http://127.0.0.1:${port}`);
});
