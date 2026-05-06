import type {
	ChangeContent,
	ContextContent,
	FileContents,
	FileDiffMetadata,
	Hunk,
	ParsedPatch,
} from "@pierre/diffs";

const COMMIT_METADATA_SPLIT = /(?=^From [a-f0-9]+ .+$)/m;
const GIT_DIFF_FILE_BREAK_REGEX = /(?=^diff --git)/gm;
const UNIFIED_DIFF_FILE_BREAK_REGEX = /(?=^---\s+\S)/gm;
const FILE_CONTEXT_BLOB = /(?=^@@ )/gm;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?/m;
const SPLIT_WITH_NEWLINES = /(?<=\n)/;
const FILENAME_HEADER_REGEX = /^(---|\+\+\+)\s+([^\t\r\n]+)/;
const FILENAME_HEADER_REGEX_GIT = /^(---|\+\+\+)\s+[ab]\/([^\t\r\n]+)/;
const ALTERNATE_FILE_NAMES_GIT = /^diff --git (?:("a\/(.+?)")|a\/(.+?)) (?:("b\/(.+?)")|b\/(.+?))$/;
const INDEX_LINE_METADATA = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/i;

function cleanLastNewline(contents: string) {
	return contents.replace(/\n$|\r\n$/, "");
}

function parseLineType(line: string) {
	const firstChar = line[0];
	if (firstChar !== "+" && firstChar !== "-" && firstChar !== " " && firstChar !== "\\") {
		console.error(`parseLineType: Invalid firstChar: "${firstChar}", full line: "${line}"`);
		return undefined;
	}
	const processedLine = line.substring(1);
	return {
		line: processedLine === "" ? "\n" : processedLine,
		type: firstChar === " " ? "context" : firstChar === "\\" ? "metadata" : firstChar === "+" ? "addition" : "deletion",
	} as const;
}

export function processPatch(data: string, cacheKeyPrefix?: string, throwOnError = false): ParsedPatch {
	const isGitDiff = GIT_DIFF_FILE_BREAK_REGEX.test(data);
	const rawFiles = data.split(isGitDiff ? GIT_DIFF_FILE_BREAK_REGEX : UNIFIED_DIFF_FILE_BREAK_REGEX);
	let patchMetadata: string | undefined;
	const files: FileDiffMetadata[] = [];
	for (const fileOrPatchMetadata of rawFiles) {
		if (isGitDiff && !GIT_DIFF_FILE_BREAK_REGEX.test(fileOrPatchMetadata)) {
			if (patchMetadata == null) patchMetadata = fileOrPatchMetadata;
			else if (throwOnError) throw Error("parsePatchContent: unknown file blob");
			else console.error("parsePatchContent: unknown file blob:", fileOrPatchMetadata);
			continue;
		} else if (!isGitDiff && !UNIFIED_DIFF_FILE_BREAK_REGEX.test(fileOrPatchMetadata)) {
			if (patchMetadata == null) patchMetadata = fileOrPatchMetadata;
			else if (throwOnError) throw Error("parsePatchContent: unknown file blob");
			else console.error("parsePatchContent: unknown file blob:", fileOrPatchMetadata);
			continue;
		}
		const currentFile = processFile(fileOrPatchMetadata, {
			cacheKey: cacheKeyPrefix != null ? `${cacheKeyPrefix}-${files.length}` : undefined,
			isGitDiff,
			throwOnError,
		});
		if (currentFile != null) files.push(currentFile);
	}
	return patchMetadata === undefined ? { files } : { patchMetadata, files };
}

type ProcessFileOptions = {
	cacheKey?: string | undefined;
	isGitDiff?: boolean | undefined;
	oldFile?: FileContents | undefined;
	newFile?: FileContents | undefined;
	throwOnError?: boolean | undefined;
};

export function processFile(
	fileDiffString: string,
	{ cacheKey, isGitDiff = GIT_DIFF_FILE_BREAK_REGEX.test(fileDiffString), oldFile, newFile, throwOnError = false }: ProcessFileOptions = {},
): FileDiffMetadata | undefined {
	let lastHunkEnd = 0;
	const hunks = fileDiffString.split(FILE_CONTEXT_BLOB);
	let currentFile: FileDiffMetadata | undefined;
	const isPartial = oldFile == null || newFile == null;
	let deletionLineIndex = 0;
	let additionLineIndex = 0;
	for (const hunk of hunks) {
		const lines = hunk.split(SPLIT_WITH_NEWLINES);
		const firstLine = lines.shift();
		if (firstLine == null) {
			if (throwOnError) throw Error("parsePatchContent: invalid hunk");
			else console.error("parsePatchContent: invalid hunk", hunk);
			continue;
		}
		const fileHeaderMatch = firstLine.match(HUNK_HEADER);
		let additionLines = 0;
		let deletionLines = 0;
		if (fileHeaderMatch == null || currentFile == null) {
			if (currentFile != null) {
				if (throwOnError) throw Error("parsePatchContent: Invalid hunk");
				else console.error("parsePatchContent: Invalid hunk", hunk);
				continue;
			}
			currentFile = {
				name: "",
				type: "change",
				hunks: [],
				splitLineCount: 0,
				unifiedLineCount: 0,
				isPartial,
				additionLines: !isPartial && oldFile != null && newFile != null ? newFile.contents.split(SPLIT_WITH_NEWLINES) : [],
				deletionLines: !isPartial && oldFile != null && newFile != null ? oldFile.contents.split(SPLIT_WITH_NEWLINES) : [],
			};
			if (cacheKey !== undefined) currentFile.cacheKey = cacheKey;
			const file = currentFile;
			if (file.additionLines.length === 1 && newFile?.contents === "") file.additionLines.length = 0;
			if (file.deletionLines.length === 1 && oldFile?.contents === "") file.deletionLines.length = 0;
			lines.unshift(firstLine);
			for (const line of lines) {
				const filenameMatch = line.match(isGitDiff ? FILENAME_HEADER_REGEX_GIT : FILENAME_HEADER_REGEX);
				if (line.startsWith("diff --git")) {
					const [, , quotedPrevName, prevName, , quotedName, name] = line.trim().match(ALTERNATE_FILE_NAMES_GIT) ?? [];
					file.name = (quotedName ?? name ?? "").trim();
					const previous = (quotedPrevName ?? prevName ?? "").trim();
					if (previous && previous !== file.name) file.prevName = previous;
				} else if (filenameMatch != null) {
					const [, type = "", fileName = ""] = filenameMatch;
					if (type === "---" && fileName !== "/dev/null") {
						file.prevName = fileName.trim();
						file.name = fileName.trim();
					} else if (type === "+++" && fileName !== "/dev/null") file.name = fileName.trim();
				} else if (isGitDiff) {
					if (line.startsWith("new mode ")) file.mode = line.replace("new mode", "").trim();
					if (line.startsWith("old mode ")) file.prevMode = line.replace("old mode", "").trim();
					if (line.startsWith("new file mode")) {
						file.type = "new";
						file.mode = line.replace("new file mode", "").trim();
					}
					if (line.startsWith("deleted file mode")) {
						file.type = "deleted";
						file.mode = line.replace("deleted file mode", "").trim();
					}
					if (line.startsWith("similarity index")) file.type = line.startsWith("similarity index 100%") ? "rename-pure" : "rename-changed";
					if (line.startsWith("index ")) {
						const [, prevObjectId, newObjectId, mode] = line.trim().match(INDEX_LINE_METADATA) ?? [];
						if (prevObjectId != null) file.prevObjectId = prevObjectId;
						if (newObjectId != null) file.newObjectId = newObjectId;
						if (mode != null) file.mode = mode;
					}
					if (line.startsWith("rename from ")) file.prevName = line.replace("rename from ", "").trim();
					if (line.startsWith("rename to ")) file.name = line.replace("rename to ", "").trim();
				}
			}
			continue;
		}
		const file = currentFile;
		let currentContent: ContextContent | ChangeContent | undefined;
		let lastLineType: "context" | "addition" | "deletion" | undefined;
		while (lines.length > 0 && (lines[lines.length - 1] === "\n" || lines[lines.length - 1] === "\r" || lines[lines.length - 1] === "\r\n" || lines[lines.length - 1] === "")) lines.pop();
		const additionStart = parseInt(fileHeaderMatch[3] ?? "0");
		const deletionStart = parseInt(fileHeaderMatch[1] ?? "0");
		deletionLineIndex = isPartial ? deletionLineIndex : deletionStart - 1;
		additionLineIndex = isPartial ? additionLineIndex : additionStart - 1;
		const hunkData: Hunk = {
			collapsedBefore: 0,
			splitLineCount: 0,
			splitLineStart: 0,
			unifiedLineCount: 0,
			unifiedLineStart: 0,
			additionCount: parseInt(fileHeaderMatch[4] ?? "1"),
			additionStart,
			additionLines,
			deletionCount: parseInt(fileHeaderMatch[2] ?? "1"),
			deletionStart,
			deletionLines,
			deletionLineIndex,
			additionLineIndex,
			hunkContent: [],
			...(fileHeaderMatch[5] !== undefined ? { hunkContext: fileHeaderMatch[5] } : {}),
			hunkSpecs: firstLine,
			noEOFCRAdditions: false,
			noEOFCRDeletions: false,
		};
		if (isNaN(hunkData.additionCount) || isNaN(hunkData.deletionCount) || isNaN(hunkData.additionStart) || isNaN(hunkData.deletionStart)) {
			if (throwOnError) throw Error("parsePatchContent: invalid hunk metadata");
			else console.error("parsePatchContent: invalid hunk metadata", hunkData);
			continue;
		}
		for (const rawLine of lines) {
			const parsedLine = parseLineType(rawLine);
			if (parsedLine == null) {
				console.error("processFile: invalid rawLine:", rawLine);
				continue;
			}
			const { type, line } = parsedLine;
			if (type === "addition") {
				if (currentContent == null || currentContent.type !== "change") {
					currentContent = createContentGroup("change", deletionLineIndex, additionLineIndex);
					hunkData.hunkContent.push(currentContent);
				}
				additionLineIndex++;
				if (isPartial) file.additionLines.push(line);
				currentContent.additions++;
				additionLines++;
				lastLineType = "addition";
			} else if (type === "deletion") {
				if (currentContent == null || currentContent.type !== "change") {
					currentContent = createContentGroup("change", deletionLineIndex, additionLineIndex);
					hunkData.hunkContent.push(currentContent);
				}
				deletionLineIndex++;
				if (isPartial) file.deletionLines.push(line);
				currentContent.deletions++;
				deletionLines++;
				lastLineType = "deletion";
			} else if (type === "context") {
				if (currentContent == null || currentContent.type !== "context") {
					currentContent = createContentGroup("context", deletionLineIndex, additionLineIndex);
					hunkData.hunkContent.push(currentContent);
				}
				additionLineIndex++;
				deletionLineIndex++;
				if (isPartial) {
					file.deletionLines.push(line);
					file.additionLines.push(line);
				}
				currentContent.lines++;
				lastLineType = "context";
			} else if (type === "metadata" && currentContent != null) {
				if (currentContent.type === "context") {
					hunkData.noEOFCRAdditions = true;
					hunkData.noEOFCRDeletions = true;
				} else if (lastLineType === "deletion") hunkData.noEOFCRDeletions = true;
				else if (lastLineType === "addition") hunkData.noEOFCRAdditions = true;
				if (isPartial && (lastLineType === "addition" || lastLineType === "context")) {
					const lastIndex = file.additionLines.length - 1;
					if (lastIndex >= 0) file.additionLines[lastIndex] = cleanLastNewline(file.additionLines[lastIndex] ?? "");
				}
				if (isPartial && (lastLineType === "deletion" || lastLineType === "context")) {
					const lastIndex = file.deletionLines.length - 1;
					if (lastIndex >= 0) file.deletionLines[lastIndex] = cleanLastNewline(file.deletionLines[lastIndex] ?? "");
				}
			}
		}
		hunkData.additionLines = additionLines;
		hunkData.deletionLines = deletionLines;
		hunkData.collapsedBefore = Math.max(hunkData.additionStart - 1 - lastHunkEnd, 0);
		file.hunks.push(hunkData);
		lastHunkEnd = hunkData.additionStart + hunkData.additionCount - 1;
		for (const content of hunkData.hunkContent) {
			if (content.type === "context") {
				hunkData.splitLineCount += content.lines;
				hunkData.unifiedLineCount += content.lines;
			} else {
				hunkData.splitLineCount += Math.max(content.additions, content.deletions);
				hunkData.unifiedLineCount += content.deletions + content.additions;
			}
		}
		hunkData.splitLineStart = file.splitLineCount + hunkData.collapsedBefore;
		hunkData.unifiedLineStart = file.unifiedLineCount + hunkData.collapsedBefore;
		file.splitLineCount += hunkData.collapsedBefore + hunkData.splitLineCount;
		file.unifiedLineCount += hunkData.collapsedBefore + hunkData.unifiedLineCount;
	}
	if (currentFile == null) return undefined;
	if (currentFile.hunks.length > 0 && !isPartial && currentFile.additionLines.length > 0 && currentFile.deletionLines.length > 0) {
		const lastHunk = currentFile.hunks[currentFile.hunks.length - 1]!;
		const totalFileLines = currentFile.additionLines.length;
		const collapsedAfter = Math.max(totalFileLines - (lastHunk.additionStart + lastHunk.additionCount - 1), 0);
		currentFile.splitLineCount += collapsedAfter;
		currentFile.unifiedLineCount += collapsedAfter;
	}
	if (!isGitDiff) {
		if (currentFile.prevName != null && currentFile.name !== currentFile.prevName) currentFile.type = currentFile.hunks.length > 0 ? "rename-changed" : "rename-pure";
		else if ((oldFile == null || oldFile.contents === "") && newFile != null && newFile.contents !== "") currentFile.type = "new";
		else if (oldFile != null && oldFile.contents !== "" && (newFile == null || newFile.contents === "")) currentFile.type = "deleted";
	}
	if (currentFile.type !== "rename-pure" && currentFile.type !== "rename-changed") delete currentFile.prevName;
	return currentFile;
}

export function parsePatchFiles(data: string, cacheKeyPrefix?: string, throwOnError = false): ParsedPatch[] {
	const patches: ParsedPatch[] = [];
	for (const patch of data.split(COMMIT_METADATA_SPLIT)) {
		try {
			patches.push(processPatch(patch, cacheKeyPrefix != null ? `${cacheKeyPrefix}-${patches.length}` : undefined, throwOnError));
		} catch (error) {
			if (throwOnError) throw error;
			else console.error(error);
		}
	}
	return patches;
}

function createContentGroup(type: "change", deletionLineIndex: number, additionLineIndex: number): ChangeContent;
function createContentGroup(type: "context", deletionLineIndex: number, additionLineIndex: number): ContextContent;
function createContentGroup(type: "change" | "context", deletionLineIndex: number, additionLineIndex: number): ChangeContent | ContextContent {
	if (type === "change") {
		return {
			type: "change",
			additions: 0,
			deletions: 0,
			additionLineIndex,
			deletionLineIndex,
		};
	}
	return {
		type: "context",
		lines: 0,
		additionLineIndex,
		deletionLineIndex,
	};
}
