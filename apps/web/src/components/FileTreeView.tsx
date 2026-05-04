import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getPageState, setPageState } from "../app/pageState";

function directoryPaths(paths: string[]) {
	const dirs = new Set<string>();
	for (const path of paths) {
		const parts = path.split("/").filter(Boolean);
		const limit = path.endsWith("/") ? parts.length : parts.length - 1;
		for (let i = 1; i <= limit; i += 1) {
			dirs.add(`${parts.slice(0, i).join("/")}/`);
		}
	}
	return [...dirs];
}

function oneDepthDirectoryPaths(paths: string[]) {
	return directoryPaths(paths).filter(
		(path) => path.slice(0, -1).includes("/") === false,
	);
}

function treeVisibleIndex(paths: string[], selectedPath: string) {
	if (!selectedPath) return -1;
	const rows = [...directoryPaths(paths), ...paths].sort((a, b) => {
		const aParts = a.split("/").filter(Boolean);
		const bParts = b.split("/").filter(Boolean);
		const len = Math.min(aParts.length, bParts.length);
		for (let i = 0; i < len; i += 1) {
			const cmp = (aParts[i] ?? "").localeCompare(bParts[i] ?? "");
			if (cmp) return cmp;
		}
		if (aParts.length !== bParts.length) return aParts.length - bParts.length;
		return Number(b.endsWith("/")) - Number(a.endsWith("/"));
	});
	return rows.indexOf(selectedPath);
}

function fzfMatch(text: string, query: string) {
	const haystack = text.toLowerCase();
	const needle = query.toLowerCase().replace(/\s+/g, "");
	if (!needle) return { indexes: new Set<number>(), score: 0 };
	const indexes = new Set<number>();
	let score = 0;
	let lastIndex = -1;
	for (const char of needle) {
		const index = haystack.indexOf(char, lastIndex + 1);
		if (index === -1) return null;
		indexes.add(index);
		score += index === lastIndex + 1 ? 3 : 1;
		if (index === 0 || "/-_ .".includes(haystack[index - 1] ?? "")) score += 2;
		lastIndex = index;
	}
	return { indexes, score: score - haystack.length / 1000 };
}

function fzfScore(path: string, query: string) {
	return fzfMatch(path, query)?.score ?? null;
}

function fzfFilterPaths(paths: string[], query: string) {
	const trimmed = query.trim();
	if (!trimmed) return paths;
	return paths
		.map((path) => ({ path, score: fzfScore(path, trimmed) }))
		.filter(
			(entry): entry is { path: string; score: number } => entry.score !== null,
		)
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
		.map((entry) => entry.path);
}

function clearTreeSearchHighlights(root: ParentNode) {
	for (const match of Array.from(root.querySelectorAll(".aware-fzf-match"))) {
		const parent = match.parentNode;
		if (!parent) continue;
		parent.replaceChild(document.createTextNode(match.textContent ?? ""), match);
		parent.normalize();
	}
}

function highlightTextNode(node: Text, query: string) {
	const text = node.nodeValue ?? "";
	const indexes = fzfMatch(text, query)?.indexes;
	if (!indexes?.size) return;
	const fragment = document.createDocumentFragment();
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] ?? "";
		if (indexes.has(index)) {
			const span = document.createElement("span");
			span.className = "aware-fzf-match";
			span.textContent = char;
			fragment.appendChild(span);
		} else {
			fragment.appendChild(document.createTextNode(char));
		}
	}
	node.parentNode?.replaceChild(fragment, node);
}

const FILE_TREE_ITEM_HEIGHT = 30;

function getTreeScroller(hostId: string) {
	const root = document.getElementById(hostId)?.shadowRoot;
	return root?.querySelector("[data-file-tree-virtualized-scroll]") ?? null;
}

function centerTreeIndex(hostId: string, index: number) {
	const scroller = getTreeScroller(hostId);
	if (!(scroller instanceof HTMLElement) || index < 0) return false;
	scroller.scrollTop = Math.max(
		0,
		index * FILE_TREE_ITEM_HEIGHT -
			scroller.clientHeight / 2 +
			FILE_TREE_ITEM_HEIGHT / 2,
	);
	return true;
}

function scrollTreeSelectionIntoView(hostId: string, focusedIndex: number) {
	if (centerTreeIndex(hostId, focusedIndex)) return true;
	const root = document.getElementById(hostId)?.shadowRoot;
	const selected = root?.querySelector(
		"[data-item-focused], [data-item-selected]",
	);
	if (!(selected instanceof HTMLElement)) return false;
	selected.scrollIntoView({ block: "center", inline: "nearest" });
	return true;
}

function scrollTreeSelectionIntoViewSoon(hostId: string, focusedIndex: number) {
	for (const delay of [0, 16, 80, 180, 360])
		window.setTimeout(
			() => scrollTreeSelectionIntoView(hostId, focusedIndex),
			delay,
		);
}

function applyTreeSearchHighlights(root: ParentNode, query: string) {
	clearTreeSearchHighlights(root);
	const trimmed = query.trim();
	if (!trimmed) return;
	const containers = root.querySelectorAll(
		"[data-item-section='content'] [data-truncate-content], [data-item-flattened-subitem] [data-truncate-content], [data-item-section='content']",
	);
	for (const container of Array.from(containers)) {
		if (!(container instanceof HTMLElement)) continue;
		if (
			container.matches("[data-item-section='content']") &&
			container.querySelector("[data-truncate-content]")
		) {
			continue;
		}
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
		const textNodes: Text[] = [];
		while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
		for (const textNode of textNodes) highlightTextNode(textNode, trimmed);
	}
}

export function FileTreeView({
	paths,
	onOpen,
	selectedPath = "",
}: {
	paths: string[];
	onOpen: (path: string) => void;
	selectedPath?: string;
}) {
	const initialTree = getPageState("file-tree", {
		searchQuery: "",
		expansion: "all" as "one" | "none" | "all",
	});
	const [searchQuery, setSearchQuery] = useState(initialTree.searchQuery);
	const [expansion, setExpansion] = useState<"one" | "none" | "all">(
		initialTree.expansion,
	);
	const onOpenRef = useRef(onOpen);
	const searchInputRef = useRef<HTMLInputElement>(null);
	onOpenRef.current = onOpen;
	const visiblePaths = useMemo(
		() => fzfFilterPaths(paths, searchQuery),
		[paths, searchQuery],
	);
	const expandedPaths = useMemo(() => {
		if (expansion === "none") return [];
		if (expansion === "all" || searchQuery.trim() || selectedPath)
			return directoryPaths(visiblePaths);
		return oneDepthDirectoryPaths(visiblePaths);
	}, [expansion, searchQuery, selectedPath, visiblePaths]);
	const { model } = useFileTree({
		paths: visiblePaths,
		search: false,
		initialExpansion: 1,
		initialExpandedPaths: expandedPaths,
		itemHeight: FILE_TREE_ITEM_HEIGHT,
		unsafeCSS: `
			.aware-fzf-match {
				color: #f59e0b;
				font-weight: 700;
			}
		`,
		onSelectionChange: (selectedPaths) => {
			const selected = selectedPaths.find((path) => !path.endsWith("/"));
			if (selected) onOpenRef.current(selected);
		},
	});
	useEffect(() => {
		const input = searchInputRef.current;
		const hadSearchFocus = document.activeElement === input;
		const selectionStart = input?.selectionStart ?? null;
		const selectionEnd = input?.selectionEnd ?? null;
		const restoreSearchFocus = () => {
			const currentInput = searchInputRef.current;
			currentInput?.focus({ preventScroll: true });
			if (selectionStart !== null && selectionEnd !== null) {
				currentInput?.setSelectionRange(selectionStart, selectionEnd);
			}
		};
		model.resetPaths(visiblePaths, { initialExpandedPaths: expandedPaths });
		if (!hadSearchFocus && selectedPath && visiblePaths.includes(selectedPath)) {
			model.focusPath(selectedPath);
			const item = model.getItem(selectedPath);
			item?.select();
			item?.focus();
			scrollTreeSelectionIntoViewSoon(
				"file-tree-host",
				treeVisibleIndex(visiblePaths, selectedPath),
			);
		}
		if (hadSearchFocus) {
			restoreSearchFocus();
			window.requestAnimationFrame(restoreSearchFocus);
		}
	}, [expandedPaths, model, selectedPath, visiblePaths]);
	useEffect(() => {
		if (document.activeElement === searchInputRef.current) return;
		if (!selectedPath || !visiblePaths.includes(selectedPath)) return;
		model.focusPath(selectedPath);
		const item = model.getItem(selectedPath);
		item?.select();
		item?.focus();
		scrollTreeSelectionIntoViewSoon(
			"file-tree-host",
			treeVisibleIndex(visiblePaths, selectedPath),
		);
	}, [model, selectedPath, visiblePaths]);
	useEffect(() => {
		const host = document.getElementById("file-tree-host");
		const shadowRoot = host?.shadowRoot;
		if (!shadowRoot) return;
		let frame = 0;
		const observer = new MutationObserver(() => refresh());
		const observe = () =>
			observer.observe(shadowRoot, {
				childList: true,
				subtree: true,
			});
		const refresh = () => {
			window.cancelAnimationFrame(frame);
			frame = window.requestAnimationFrame(() => {
				observer.disconnect();
				applyTreeSearchHighlights(shadowRoot, searchQuery);
				observe();
			});
		};
		refresh();
		observe();
		return () => {
			window.cancelAnimationFrame(frame);
			observer.disconnect();
			clearTreeSearchHighlights(shadowRoot);
		};
	}, [searchQuery, visiblePaths]);
	return (
		<FileTree
			id="file-tree-host"
			model={model}
			header={
				<div className="file-tree-header">
					<div className="file-tree-actions">
						<button
							type="button"
							onClick={() => {
								setExpansion("none");
								setPageState("file-tree", { expansion: "none" });
							}}
						>
							Collapse all
						</button>
						<button
							type="button"
							onClick={() => {
								setExpansion("all");
								setPageState("file-tree", { expansion: "all" });
							}}
						>
							Expand all
						</button>
					</div>
					<input
						ref={searchInputRef}
						type="search"
						value={searchQuery}
						onChange={(event) => {
							setSearchQuery(event.target.value);
							setPageState("file-tree", { searchQuery: event.target.value });
						}}
						placeholder="fzf search files"
						aria-label="fzf search files"
					/>
				</div>
			}
			style={{ height: "100%" }}
		/>
	);
}

