import type { ThoughtGraph, ThoughtGraphNodeKind } from "@aware/shared";

const phaseOrder = [
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

export type ThoughtGraphPanelState =
	| { status: "idle" | "loading"; graph?: undefined; error?: string | undefined }
	| { status: "ready"; graph: ThoughtGraph; error?: string | undefined }
	| { status: "error"; graph?: ThoughtGraph | undefined; error: string };

function nodesByPhase(graph: ThoughtGraph) {
	const grouped = new Map<string, ThoughtGraph["nodes"]>();
	for (const node of graph.nodes) {
		const phase = node.phase || "Exploration";
		grouped.set(phase, [...(grouped.get(phase) ?? []), node]);
	}
	return grouped;
}

export function thoughtGraphIsEmpty(graph: ThoughtGraph | undefined) {
	return !graph || graph.nodes.length === 0;
}

function edgeLabel(graph: ThoughtGraph, source: string, target: string) {
	return graph.edges
		.filter((edge) => edge.source === source || edge.target === target)
		.slice(0, 3)
		.map((edge) => edge.kind.replace(/_/g, " "))
		.join(" · ");
}

export function ThoughtGraphPanel({
	state,
	onClose,
}: {
	state: ThoughtGraphPanelState;
	onClose?: () => void;
}) {
	const graph = state.graph;
	const grouped = graph ? nodesByPhase(graph) : new Map<string, ThoughtGraph["nodes"]>();
	return (
		<aside className="thought-graph-panel" aria-label="Thought graph">
			<header className="thought-graph-header">
				<div>
					<small>Run reasoning map</small>
					<h3>Thought Graph</h3>
				</div>
				{onClose ? <button type="button" onClick={onClose}>Close</button> : null}
			</header>
			{state.status === "loading" ? (
				<p className="thought-graph-state">Analyzing thought direction…</p>
			) : null}
			{state.status === "error" ? (
				<section className="thought-graph-state thought-graph-error">
					<strong>Could not open thought graph</strong>
					<p>{state.error}</p>
				</section>
			) : null}
			{graph ? (
				<>
					<section className="thought-graph-summary">
						<p>{graph.summary}</p>
						<div className="thought-graph-metrics">
							<span>{graph.nodes.length} nodes</span>
							<span>{graph.edges.length} edges</span>
							<span>seq {graph.sourceEventSeqRange.join("–")}</span>
						</div>
					</section>
					{thoughtGraphIsEmpty(graph) ? (
						<p className="thought-graph-state">No thought graph nodes yet. Generate after run activity exists.</p>
					) : (
						<div className="thought-graph-lanes">
							{phaseOrder.map((phase) => {
								const nodes = grouped.get(phase) ?? [];
								return (
									<section key={phase} className="thought-graph-lane">
										<h4>{phase}</h4>
										{nodes.length ? nodes.map((node) => (
											<article key={node.id} className={`thought-node thought-node-${node.kind}`}>
												<div className="thought-node-topline">
													<span>{kindLabels[node.kind]}</span>
													{node.toolName ? <em>{node.toolName}</em> : null}
												</div>
												<strong>{node.label}</strong>
												<p>{node.detail}</p>
												<small>{edgeLabel(graph, node.id, node.id)}</small>
											</article>
										)) : <p className="thought-lane-empty">No node.</p>}
									</section>
								);
							})}
						</div>
					)}
					<section className="thought-graph-footnotes">
						<div>
							<h4>Risks</h4>
							{graph.risks.length ? <ul>{graph.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>No explicit risks.</p>}
						</div>
						<div>
							<h4>Open questions</h4>
							{graph.openQuestions.length ? <ul>{graph.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul> : <p>No open questions.</p>}
						</div>
					</section>
				</>
			) : null}
			{state.status === "idle" ? <p className="thought-graph-state">Click Thought Graph to generate run-local reasoning map.</p> : null}
		</aside>
	);
}
