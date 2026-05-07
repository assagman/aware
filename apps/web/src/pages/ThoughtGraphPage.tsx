import type { AgentRun, Task, ThoughtGraph, ThoughtGraphNode } from "@aware/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { apiGet, apiPost } from "../app/api";
import {
	defaultThoughtGraphFilters,
	ThoughtGraphView,
	thoughtGraphIsEmpty,
	thoughtGraphMarkdownSummary,
	type ThoughtGraphFilters,
} from "../components/ThoughtGraphView";

function downloadText(filename: string, text: string, type: string) {
	const url = URL.createObjectURL(new Blob([text], { type }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function nodeTitle(node: ThoughtGraphNode | undefined) {
	return node ? `${node.label} · ${node.kind.replace(/_/g, " ")}` : "Select a node";
}

export type ThoughtGraphPageState =
	| { status: "loading"; graph?: undefined; error?: undefined }
	| { status: "ready"; graph: ThoughtGraph; error?: undefined }
	| { status: "error"; graph?: ThoughtGraph | undefined; error: string };

export function ThoughtGraphPageContent({
	state,
	run,
	task,
	filters,
	selectedNodeId,
	onFiltersChange,
	onSelectNode,
	onRegenerate,
	onExportJson,
	onExportMarkdown,
	backPath,
}: {
	state: ThoughtGraphPageState;
	run?: AgentRun | undefined;
	task?: Task | undefined;
	filters: ThoughtGraphFilters;
	selectedNodeId: string;
	onFiltersChange: (filters: ThoughtGraphFilters) => void;
	onSelectNode: (nodeId: string) => void;
	onRegenerate: () => void;
	onExportJson: () => void;
	onExportMarkdown: () => void;
	backPath?: string | undefined;
}) {
	const graph = state.graph;
	const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId) ?? graph?.nodes[0];
	return (
		<section className="thought-page isolated-thought-page">
			<header className="thought-page-header">
				<div>
					<small>Isolated run reasoning map</small>
					<h2>Thought Graph</h2>
					<p>{task?.title ?? "Run-local graph"} · {run?.status ?? "loading"}</p>
				</div>
				<div className="thought-page-actions">
					{run ? <Link to={backPath ?? `/projects/${encodeURIComponent(run.projectId ?? task?.projectId ?? "")}/tasks/${encodeURIComponent(run.taskId)}/runs/${encodeURIComponent(run.id)}`}>Back to run</Link> : null}
					<button type="button" disabled={state.status === "loading"} onClick={onRegenerate}>Regenerate</button>
					<button type="button" disabled={!graph} onClick={onExportMarkdown}>Export MD</button>
					<button type="button" disabled={!graph} onClick={onExportJson}>Export JSON</button>
				</div>
			</header>

			{state.status === "loading" ? (
				<div className="thought-page-state">Analyzing thought direction…</div>
			) : null}

			{state.status === "error" ? (
				<div className="thought-page-state thought-page-error">
					<h3>Could not open thought graph</h3>
					<p>{state.error}</p>
				</div>
			) : null}

			{graph ? (
				<>
					<section className="thought-page-summary">
						<div>
							<small>Where agent thinking went</small>
							<p>{graph.summary}</p>
						</div>
						<div className="thought-page-metrics">
							<span>{graph.nodes.length} nodes</span>
							<span>{graph.edges.length} edges</span>
							<span>seq {graph.sourceEventSeqRange.join("–")}</span>
						</div>
					</section>
					<section className="thought-page-controls" aria-label="Thought graph filters">
						<label><input type="checkbox" checked={filters.showAssumptions} onChange={(event) => onFiltersChange({ ...filters, showAssumptions: event.currentTarget.checked })} /> assumptions</label>
						<label><input type="checkbox" checked={filters.showToolEvidence} onChange={(event) => onFiltersChange({ ...filters, showToolEvidence: event.currentTarget.checked })} /> raw tool evidence</label>
						<label><input type="checkbox" checked={filters.pivotsOnly} onChange={(event) => onFiltersChange({ ...filters, pivotsOnly: event.currentTarget.checked })} /> pivots only</label>
						<label><input type="checkbox" checked={filters.showRisks} onChange={(event) => onFiltersChange({ ...filters, showRisks: event.currentTarget.checked })} /> risks</label>
						<label>confidence <input type="range" min="0" max="1" step="0.05" value={filters.minConfidence} onChange={(event) => onFiltersChange({ ...filters, minConfidence: Number(event.currentTarget.value) })} /> {filters.minConfidence.toFixed(2)}</label>
					</section>
					{thoughtGraphIsEmpty(graph) ? (
						<div className="thought-page-state">No thought graph nodes yet. Generate after run activity exists.</div>
					) : (
						<section className="thought-page-body">
							<ThoughtGraphView graph={graph} filters={filters} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
							<aside className="thought-page-inspector">
								<h3>{nodeTitle(selectedNode)}</h3>
								{selectedNode ? (
									<>
										<p>{selectedNode.detail}</p>
										<dl>
											<dt>Phase</dt><dd>{selectedNode.phase}</dd>
											<dt>Seq</dt><dd>{selectedNode.seq ?? "n/a"}</dd>
											<dt>Confidence</dt><dd>{selectedNode.confidence ?? "n/a"}</dd>
											<dt>Tool</dt><dd>{selectedNode.toolName ?? "n/a"}</dd>
										</dl>
									</>
								) : <p>Select a graph node.</p>}
								<h4>Timeline</h4>
								<ol className="thought-page-timeline">
									{graph.timeline.slice(0, 60).map((item) => <li key={`${item.seq}:${item.type}`}><strong>{item.title}</strong><span>{item.detail}</span></li>)}
								</ol>
							</aside>
						</section>
					)}
				</>
			) : null}
		</section>
	);
}

export function ThoughtGraphPage() {
	const { projectId = "", taskId = "", runId = "" } = useParams();
	const [run, setRun] = useState<AgentRun | undefined>();
	const [task, setTask] = useState<Task | undefined>();
	const [state, setState] = useState<ThoughtGraphPageState>({ status: "loading" });
	const [filters, setFilters] = useState<ThoughtGraphFilters>(defaultThoughtGraphFilters);
	const [selectedNodeId, setSelectedNodeId] = useState("");

	const runPath = useMemo(() => `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`, [projectId, runId, taskId]);

	const load = useCallback(async (force = false) => {
		if (!runId) return;
		setState({ status: "loading" });
		try {
			const [nextRun, nextTask] = await Promise.all([
				apiGet<AgentRun>(runPath).catch(() => apiGet<AgentRun>(`/runs/${encodeURIComponent(runId)}`)),
				apiGet<Task>(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`).catch(() => apiGet<Task>(`/runs/${encodeURIComponent(runId)}/task`)),
			]);
			setRun(nextRun);
			setTask(nextTask);
			let graph: ThoughtGraph;
			if (force) graph = await apiPost<ThoughtGraph>(`/runs/${encodeURIComponent(runId)}/thought-graph`, {});
			else {
				try {
					graph = await apiGet<ThoughtGraph>(`/runs/${encodeURIComponent(runId)}/thought-graph`);
				} catch {
					graph = await apiPost<ThoughtGraph>(`/runs/${encodeURIComponent(runId)}/thought-graph`, {});
				}
			}
			setSelectedNodeId((current) => current || graph.nodes[0]?.id || "");
			setState({ status: "ready", graph });
		} catch (error) {
			setState({ status: "error", error: errorMessage(error) });
		}
	}, [projectId, runId, runPath, taskId]);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<ThoughtGraphPageContent
			state={state}
			run={run}
			task={task}
			filters={filters}
			selectedNodeId={selectedNodeId}
			onFiltersChange={setFilters}
			onSelectNode={setSelectedNodeId}
			onRegenerate={() => { void load(true); }}
			onExportJson={() => state.graph ? downloadText(`thought-graph-${state.graph.runId}.json`, JSON.stringify(state.graph, null, 2), "application/json") : undefined}
			onExportMarkdown={() => state.graph ? downloadText(`thought-graph-${state.graph.runId}.md`, thoughtGraphMarkdownSummary(state.graph), "text/markdown") : undefined}
			backPath={runPath}
		/>
	);
}
