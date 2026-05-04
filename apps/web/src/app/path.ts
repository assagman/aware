export function collapseHomePath(path: string) {
	return path
		.replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
		.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}
