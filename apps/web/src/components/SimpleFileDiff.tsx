import type { FileDiffMetadata, OnDiffLineClickProps, SelectedLineRange } from "@pierre/diffs";
import type { MouseEvent } from "react";

type DiffSide = "additions" | "deletions";
type SimpleFileDiffOptions = {
	enableLineSelection?: boolean;
	onLineClick?: (line: OnDiffLineClickProps) => unknown;
	onLineNumberClick?: (line: OnDiffLineClickProps) => unknown;
	onLineSelectionEnd?: (range: SelectedLineRange | null) => unknown;
};

type SimpleFileDiffProps = {
	fileDiff: FileDiffMetadata;
	selectedLines?: SelectedLineRange | null;
	options?: SimpleFileDiffOptions;
	disableWorkerPool?: boolean;
};

type DiffContentRow = { type: "context" | "addition" | "deletion"; key: string; oldLine?: number; newLine?: number; text: string };
type DiffRow = { type: "hunk"; key: string; text: string } | DiffContentRow;

function diffRows(fileDiff: FileDiffMetadata): DiffRow[] {
	const rows: DiffRow[] = [];
	fileDiff.hunks.forEach((hunk, hunkIndex) => {
		rows.push({ type: "hunk", key: `hunk-${hunkIndex}`, text: hunk.hunkSpecs ?? `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@${hunk.hunkContext ? ` ${hunk.hunkContext}` : ""}` });
		let oldLine = hunk.deletionStart;
		let newLine = hunk.additionStart;
		for (const [contentIndex, content] of hunk.hunkContent.entries()) {
			if (content.type === "context") {
				for (let index = 0; index < content.lines; index++) {
					rows.push({
						type: "context",
						key: `${hunkIndex}-${contentIndex}-context-${index}`,
						oldLine: oldLine++,
						newLine: newLine++,
						text: fileDiff.additionLines[content.additionLineIndex + index] ?? fileDiff.deletionLines[content.deletionLineIndex + index] ?? "",
					});
				}
				continue;
			}
			for (let index = 0; index < content.deletions; index++) {
				rows.push({
					type: "deletion",
					key: `${hunkIndex}-${contentIndex}-deletion-${index}`,
					oldLine: oldLine++,
					text: fileDiff.deletionLines[content.deletionLineIndex + index] ?? "",
				});
			}
			for (let index = 0; index < content.additions; index++) {
				rows.push({
					type: "addition",
					key: `${hunkIndex}-${contentIndex}-addition-${index}`,
					newLine: newLine++,
					text: fileDiff.additionLines[content.additionLineIndex + index] ?? "",
				});
			}
		}
	});
	return rows;
}

function rowSide(row: DiffContentRow): DiffSide {
	return row.type === "deletion" ? "deletions" : "additions";
}

function rowLine(row: DiffContentRow) {
	return row.type === "deletion" ? row.oldLine : row.newLine;
}

function lineType(row: DiffContentRow) {
	return row.type === "context" ? "context" : row.type === "deletion" ? "change-deletion" : "change-addition";
}

function sign(row: DiffContentRow) {
	if (row.type === "addition") return "+";
	if (row.type === "deletion") return "-";
	return " ";
}

function isSelected(row: DiffContentRow, selectedLines?: SelectedLineRange | null) {
	if (!selectedLines) return false;
	const line = rowLine(row);
	if (!line) return false;
	const side = rowSide(row);
	const selectedSide = selectedLines.side ?? side;
	if (selectedSide !== side) return false;
	const start = Math.min(selectedLines.start, selectedLines.end);
	const end = Math.max(selectedLines.start, selectedLines.end);
	return line >= start && line <= end;
}

function eventPayload(row: DiffContentRow, target: HTMLElement): OnDiffLineClickProps | undefined {
	const lineNumber = rowLine(row);
	if (!lineNumber) return undefined;
	return {
		type: "diff-line",
		lineNumber,
		annotationSide: rowSide(row),
		lineType: lineType(row),
		lineElement: target,
		numberElement: target,
		numberColumn: false,
	} as OnDiffLineClickProps;
}

export function SimpleFileDiff({ fileDiff, selectedLines, options }: SimpleFileDiffProps) {
	const rows = diffRows(fileDiff);
	const title = fileDiff.prevName && fileDiff.prevName !== fileDiff.name ? `${fileDiff.prevName} → ${fileDiff.name}` : fileDiff.name;

	function selectRow(row: DiffContentRow, event: MouseEvent<HTMLElement>, numberColumn = false) {
		const payload = eventPayload(row, event.currentTarget);
		if (!payload) return;
		const nextPayload = { ...payload, numberColumn } as OnDiffLineClickProps;
		if (numberColumn) options?.onLineNumberClick?.(nextPayload);
		else options?.onLineClick?.(nextPayload);
		if (options?.enableLineSelection) {
			options.onLineSelectionEnd?.({ start: nextPayload.lineNumber, end: nextPayload.lineNumber, side: nextPayload.annotationSide, endSide: nextPayload.annotationSide });
		}
	}

	return (
		<div className={`simple-file-diff simple-file-diff-${fileDiff.type}`}>
			<header className="simple-file-diff-header">
				<strong>{title || "diff"}</strong>
				<span>{fileDiff.type.replace(/-/g, " ")}</span>
			</header>
			<pre className="simple-file-diff-body">
				{rows.map((row) => row.type === "hunk" ? (
					<div key={row.key} className="simple-diff-hunk">{row.text}</div>
				) : (
					<div
						key={row.key}
						className={`simple-diff-row simple-diff-${row.type}${isSelected(row, selectedLines) ? " selected" : ""}`}
						onClick={(event) => selectRow(row, event)}
					>
						<span className="simple-diff-line-no simple-diff-old" onClick={(event) => { event.stopPropagation(); selectRow(row, event, true); }}>{row.oldLine ?? ""}</span>
						<span className="simple-diff-line-no simple-diff-new" onClick={(event) => { event.stopPropagation(); selectRow(row, event, true); }}>{row.newLine ?? ""}</span>
						<code><span className="simple-diff-sign">{sign(row)}</span>{row.text || " "}</code>
					</div>
				))}
			</pre>
		</div>
	);
}
