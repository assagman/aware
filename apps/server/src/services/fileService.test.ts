import { describe, expect, it } from "vitest";

function unsafe(path: string) {
	return path.includes("..") || path.startsWith("/");
}

describe("path safety", () => {
	it("rejects traversal", () => {
		expect(unsafe("../x")).toBe(true);
		expect(unsafe("/tmp/x")).toBe(true);
		expect(unsafe("src/index.ts")).toBe(false);
	});
});
