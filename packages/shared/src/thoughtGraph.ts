import { z } from "zod";

export const thoughtGraphNodeKindSchema = z.enum([
	"intent",
	"assumption",
	"hypothesis",
	"evidence",
	"decision",
	"pivot",
	"risk",
	"action",
	"outcome",
	"follow_up",
]);

export const thoughtGraphEdgeKindSchema = z.enum([
	"led_to",
	"supported_by",
	"contradicted_by",
	"changed_mind",
	"caused_action",
	"resolved_by",
	"left_open",
]);

export const thoughtGraphNodeSchema = z.object({
	id: z.string().min(1),
	kind: thoughtGraphNodeKindSchema,
	label: z.string().min(1),
	detail: z.string().default(""),
	phase: z.string().min(1),
	seq: z.number().int().nonnegative().optional(),
	turn: z.number().int().positive().optional(),
	confidence: z.number().min(0).max(1).optional(),
	toolName: z.string().optional(),
	sourceEventIds: z.array(z.string()).default([]),
});

export const thoughtGraphEdgeSchema = z.object({
	id: z.string().min(1),
	source: z.string().min(1),
	target: z.string().min(1),
	kind: thoughtGraphEdgeKindSchema,
	label: z.string().optional(),
});

export const thoughtGraphTimelineItemSchema = z.object({
	seq: z.number().int().nonnegative(),
	type: z.string().min(1),
	title: z.string().min(1),
	detail: z.string().default(""),
	eventId: z.string().optional(),
	createdAt: z.string().optional(),
});

export const thoughtGraphInsightSchema = z.object({
	kind: z.string().min(1),
	text: z.string().min(1),
	nodeIds: z.array(z.string()).default([]),
});

export const thoughtGraphSchema = z.object({
	version: z.literal(1),
	runId: z.string().min(1),
	sourceEventSeqRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
	sourceEventHash: z.string().min(1),
	summary: z.string().min(1),
	nodes: z.array(thoughtGraphNodeSchema),
	edges: z.array(thoughtGraphEdgeSchema),
	timeline: z.array(thoughtGraphTimelineItemSchema),
	insights: z.array(thoughtGraphInsightSchema),
	risks: z.array(z.string()),
	openQuestions: z.array(z.string()),
	generatedAt: z.string(),
});

export type ThoughtGraphNodeKind = z.infer<typeof thoughtGraphNodeKindSchema>;
export type ThoughtGraphEdgeKind = z.infer<typeof thoughtGraphEdgeKindSchema>;
export type ThoughtGraphNode = z.infer<typeof thoughtGraphNodeSchema>;
export type ThoughtGraphEdge = z.infer<typeof thoughtGraphEdgeSchema>;
export type ThoughtGraphTimelineItem = z.infer<typeof thoughtGraphTimelineItemSchema>;
export type ThoughtGraphInsight = z.infer<typeof thoughtGraphInsightSchema>;
export type ThoughtGraph = z.infer<typeof thoughtGraphSchema>;
