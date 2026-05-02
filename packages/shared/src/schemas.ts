import { z } from "zod";

export const idSchema = z.string().min(1);
export const projectSchema = z.object({
	id: idSchema,
	name: z.string(),
	rootPath: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const worktreeSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	path: z.string(),
	branch: z.string(),
	baseBranch: z.string().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const agentProfileSchema = z.object({
	id: idSchema,
	name: z.string(),
	provider: z.string(),
	model: z.string(),
	thinking: z.string().optional(),
	systemPrompt: z.string(),
	tools: z.array(z.string()),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const taskSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	worktreeId: idSchema,
	title: z.string(),
	body: z.string(),
	status: z.enum(["draft", "queued", "running", "done", "failed"]),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export const annotationSchema = z.object({
	id: idSchema,
	projectId: idSchema,
	worktreeId: idSchema,
	taskId: idSchema.optional(),
	kind: z.enum(["file", "line", "range", "diff"]),
	filePath: z.string().optional(),
	side: z.enum(["old", "new", "additions", "deletions"]).optional(),
	startLine: z.number().optional(),
	endLine: z.number().optional(),
	text: z.string(),
	sent: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
