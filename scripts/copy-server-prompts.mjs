import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "apps", "server", "src", "prompts");
const target = join(
	repoRoot,
	"apps",
	"server",
	"dist",
	"apps",
	"server",
	"src",
	"prompts",
);

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
