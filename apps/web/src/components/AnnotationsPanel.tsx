import type { Annotation } from "@agent-ide/shared";

export function AnnotationsPanel({
	annotations,
	onRefresh,
}: {
	annotations: Annotation[];
	onRefresh: () => void;
}) {
	return (
		<aside className="annotations-panel">
			<div className="panel-head">
				<h3>Saved annotations</h3>
				<button type="button" onClick={onRefresh}>
					refresh
				</button>
			</div>
			{annotations.length === 0 ? (
				<p>None yet. Select lines or use file annotate.</p>
			) : null}
			<ul>
				{annotations.map((a) => (
					<li key={a.id}>
						<strong>{a.kind}</strong> {a.filePath}
						{a.startLine
							? `:${a.startLine}${a.endLine ? `-${a.endLine}` : ""}`
							: ""}
						<p>{a.text}</p>
					</li>
				))}
			</ul>
		</aside>
	);
}
