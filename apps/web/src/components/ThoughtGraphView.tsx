import type { ThoughtGraph, ThoughtGraphNode, ThoughtGraphNodeKind } from "@aware/shared";
import {
	Background,
	Controls,
	Handle,
	Position,
	ReactFlow,
	type Edge,
	type Node,
	type NodeProps,
} from "@xyflow/react";
import { useMemo, useState } from "react";

export const thoughtGraphPhases = [
	"User intent",
	"Initial framing",
	"Exploration",
	"Evidence/tool feedback",
	"Decisions",
	"Pivots",
	"Risks",
	"Final approach",
	"Open questions/follow-ups",
];

const kindLabels: Record<ThoughtGraphNodeKind, string> = {
	intent: "Intent",
	assumption: "Assumption",
	hypothesis: "Hypothesis",
	evidence: "Evidence",
	decision: "Decision",
	pivot: "Pivot",
	risk: "Risk",
	action: "Action",
	outcome: "Outcome",
	follow_up: "Follow-up",
};

export type ThoughtGraphFilters = {
	showAssumptions: boolean;
	showToolEvidence: boolean;
	pivotsOnly: boolean;
	showRisks: boolean;
	minConfidence: number;
};

export const defaultThoughtGraphFilters: ThoughtGraphFilters = {
	showAssumptions: true,
	showToolEvidence: true,
	pivotsOnly: false,
	showRisks: true,
	minConfidence: 0,
};

type FocusState = "normal" | "focused" | "connected" | "dimmed";

type ThoughtNodeData = {
	thoughtNode: ThoughtGraphNode;
	selected: boolean;
	focusState: FocusState;
} & Record<string, unknown>;
type ThoughtFlowNode = Node<ThoughtNodeData, "thought">;
type ThoughtFlowEdge = Edge<{ kind: string; focusState: FocusState }>;

export function thoughtGraphIsEmpty(graph: ThoughtGraph | undefined) {
	return !graph || graph.nodes.length === 0;
}

function visibleNode(node: ThoughtGraphNode, filters: ThoughtGraphFilters) {
	if (filters.pivotsOnly && node.kind !== "pivot") return false;
	if (!filters.showAssumptions && node.kind === "assumption") return false;
	if (!filters.showToolEvidence && node.kind === "evidence" && node.toolName) return false;
	if (!filters.showRisks && node.kind === "risk") return false;
	return (node.confidence ?? 1) >= filters.minConfidence;
}

function phaseIndex(node: ThoughtGraphNode) {
	const index = thoughtGraphPhases.indexOf(node.phase);
	return index >= 0 ? index : 2;
}

export function connectedThoughtGraphElementIds(graph: ThoughtGraph, focusId = "") {
	const nodeIds = new Set<string>();
	const edgeIds = new Set<string>();
	if (!focusId) return { nodeIds, edgeIds };
	const focusedEdge = graph.edges.find((edge) => edge.id === focusId);
	if (focusedEdge) {
		edgeIds.add(focusedEdge.id);
		nodeIds.add(focusedEdge.source);
		nodeIds.add(focusedEdge.target);
		return { nodeIds, edgeIds };
	}
	if (!graph.nodes.some((node) => node.id === focusId)) return { nodeIds, edgeIds };
	nodeIds.add(focusId);
	for (const edge of graph.edges) {
		if (edge.source !== focusId && edge.target !== focusId) continue;
		edgeIds.add(edge.id);
		nodeIds.add(edge.source);
		nodeIds.add(edge.target);
	}
	return { nodeIds, edgeIds };
}

function focusState(id: string, focusId: string, ids: Set<string>): FocusState {
	if (!focusId) return "normal";
	if (id === focusId) return "focused";
	return ids.has(id) ? "connected" : "dimmed";
}

export function layoutThoughtGraph(graph: ThoughtGraph, filters: ThoughtGraphFilters, selectedNodeId = "", focusElementId = "") {
	const visible = graph.nodes.filter((node) => visibleNode(node, filters));
	const visibleIds = new Set(visible.map((node) => node.id));
	const focus = connectedThoughtGraphElementIds(graph, focusElementId);
	const yByPhase = new Map<number, number>();
	const nodes: ThoughtFlowNode[] = visible
		.sort((a, b) => (phaseIndex(a) - phaseIndex(b)) || ((a.seq ?? 0) - (b.seq ?? 0)) || a.id.localeCompare(b.id))
		.map((node) => {
			const phase = phaseIndex(node);
			const y = yByPhase.get(phase) ?? 0;
			yByPhase.set(phase, y + 1);
			return {
				id: node.id,
				type: "thought",
				position: { x: phase * 320, y: y * 190 },
				data: { thoughtNode: node, selected: node.id === selectedNodeId, focusState: focusState(node.id, focusElementId, focus.nodeIds) },
				sourcePosition: Position.Right,
				targetPosition: Position.Left,
			};
		});
	const edges: ThoughtFlowEdge[] = graph.edges
		.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
		.map((edge) => {
			const edgeFocusState = focusState(edge.id, focusElementId, focus.edgeIds);
			return {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				type: "smoothstep",
				label: edge.label ?? edge.kind.replace(/_/g, " "),
				animated: edge.kind === "changed_mind" || edge.kind === "left_open" || edgeFocusState === "focused",
				className: `thought-edge thought-edge-${edge.kind} thought-edge-${edgeFocusState}`,
				data: { kind: edge.kind, focusState: edgeFocusState },
			};
		});
	return { nodes, edges };
}

function ThoughtNodeCard({ data, isConnectable }: NodeProps<ThoughtFlowNode>) {
	const node = data.thoughtNode;
	return (
		<article className={`thought-flow-node thought-flow-node-${node.kind} thought-flow-node-${data.focusState} ${data.selected ? "selected" : ""}`}>
			<Handle type="target" position={Position.Left} isConnectable={isConnectable} />
			<div className="thought-node-topline">
				<span>{kindLabels[node.kind]}</span>
				{node.toolName ? <em>{node.toolName}</em> : null}
			</div>
			<strong>{node.label}</strong>
			<p>{node.detail}</p>
			<small>{node.phase}{node.seq !== undefined ? ` · seq ${node.seq}` : ""}</small>
			<Handle type="source" position={Position.Right} isConnectable={isConnectable} />
		</article>
	);
}

const nodeTypes = { thought: ThoughtNodeCard };

export function thoughtGraphMarkdownSummary(graph: ThoughtGraph) {
	const decisions = graph.nodes.filter((node) => node.kind === "decision");
	const pivots = graph.nodes.filter((node) => node.kind === "pivot");
	const risks = graph.nodes.filter((node) => node.kind === "risk");
	return [
		`# Thought Graph — ${graph.runId}`,
		"",
		graph.summary,
		"",
		"## Decisions",
		...(decisions.length ? decisions.map((node) => `- ${node.label}: ${node.detail}`) : ["- None captured."]),
		"",
		"## Pivots",
		...(pivots.length ? pivots.map((node) => `- ${node.label}: ${node.detail}`) : ["- None captured."]),
		"",
		"## Risks",
		...(risks.length ? risks.map((node) => `- ${node.label}: ${node.detail}`) : ["- None captured."]),
		"",
		"## Open questions",
		...(graph.openQuestions.length ? graph.openQuestions.map((item) => `- ${item}`) : ["- None captured."]),
	].join("\n");
}

export function ThoughtGraphView({
	graph,
	filters,
	selectedNodeId,
	onSelectNode,
}: {
	graph: ThoughtGraph;
	filters: ThoughtGraphFilters;
	selectedNodeId: string;
	onSelectNode: (nodeId: string) => void;
}) {
	const [focusElementId, setFocusElementId] = useState("");
	const { nodes, edges } = useMemo(() => layoutThoughtGraph(graph, filters, selectedNodeId, focusElementId), [filters, focusElementId, graph, selectedNodeId]);
	return (
		<section className="thought-page-graph" aria-label="Thought graph canvas" onMouseLeave={() => setFocusElementId("")}>
			<div className="thought-phase-ruler" aria-hidden="true">
				{thoughtGraphPhases.map((phase) => <span key={phase}>{phase}</span>)}
			</div>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				fitView
				onNodeClick={(_, node) => onSelectNode(node.id)}
				onNodeMouseEnter={(_, node) => setFocusElementId(node.id)}
				onNodeMouseLeave={() => setFocusElementId("")}
				onEdgeMouseEnter={(_, edge) => setFocusElementId(edge.id)}
				onEdgeMouseLeave={() => setFocusElementId("")}
				minZoom={0.25}
				maxZoom={1.4}
			>
				<Background />
				<Controls />
			</ReactFlow>
		</section>
	);
}
