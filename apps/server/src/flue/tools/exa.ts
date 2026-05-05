import { Type, type ToolDef } from "@flue/sdk/client";
import Exa from "exa-js";
import { getProviderRuntimeApiKey } from "../../services/providerAuthService";

const exaToolNames = [
	"exa_search",
	"exa_find_similar",
	"exa_get_contents",
	"exa_answer",
] as const;

const retiredExaToolNames = [
	"exa_stream_search",
	"exa_stream_answer",
	"exa_research_create",
	"exa_research_get",
	"exa_research_poll_until_finished",
	"exa_research_list",
] as const;

export type ExaToolName = (typeof exaToolNames)[number];

export const EXA_TOOL_NAMES: readonly ExaToolName[] = exaToolNames;
export const EXA_RETIRED_TOOL_NAMES: readonly string[] = retiredExaToolNames;

const optionsSchema = Type.Optional(
	Type.Record(Type.String(), Type.Unknown(), {
		description: "Exa SDK options object for this method.",
	}),
);

const maxOutputCharsSchema = Type.Optional(
	Type.Number({
		description:
			"Maximum returned JSON characters. Defaults to 60000. Use lower values to reduce context.",
	}),
);

function stringifyResult(result: unknown, maxOutputChars?: unknown) {
	const limit =
		typeof maxOutputChars === "number" && Number.isFinite(maxOutputChars)
			? Math.max(1000, Math.floor(maxOutputChars))
			: 60_000;
	const text = JSON.stringify(result, null, 2);
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

async function exaClient() {
	const key = await getProviderRuntimeApiKey("exa");
	if (!key && !process.env.EXA_API_KEY) {
		throw new Error(
			"EXA_API_KEY missing. Set EXA_API_KEY or save provider api key for 'exa'.",
		);
	}
	return new Exa(key ?? process.env.EXA_API_KEY);
}

export function createExaTools(): ToolDef[] {
	return [
		{
			name: "exa_search",
			description:
				"Search web with Exa. Returns full SearchResponse with results, requestId, cost, status, and optional output. Supports regular/deep/instant search, domain/date/category filters, contents, summaries, highlights, and outputSchema via options.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query." }),
				options: optionsSchema,
				maxOutputChars: maxOutputCharsSchema,
			}),
			execute: async (args) => {
				const exa = await exaClient();
				const result = await exa.search(String(args.query), args.options as never);
				return stringifyResult(result, args.maxOutputChars);
			},
		},
		{
			name: "exa_find_similar",
			description:
				"Find pages similar to a URL with Exa. Supports contents, excludeSourceDomain, domain/date/category filters via options.",
			parameters: Type.Object({
				url: Type.String({ description: "Source URL." }),
				options: optionsSchema,
				maxOutputChars: maxOutputCharsSchema,
			}),
			execute: async (args) => {
				const exa = await exaClient();
				const result = await exa.findSimilar(String(args.url), args.options as never);
				return stringifyResult(result, args.maxOutputChars);
			},
		},
		{
			name: "exa_get_contents",
			description:
				"Fetch contents for one or more URLs with Exa. Supports text, highlights, summary, subpages, extras via options.",
			parameters: Type.Object({
				urls: Type.Union([
					Type.String({ description: "Single URL." }),
					Type.Array(Type.String(), { description: "URLs." }),
				]),
				options: optionsSchema,
				maxOutputChars: maxOutputCharsSchema,
			}),
			execute: async (args) => {
				const exa = await exaClient();
				const result = await exa.getContents(args.urls as never, args.options as never);
				return stringifyResult(result, args.maxOutputChars);
			},
		},
		{
			name: "exa_answer",
			description:
				"Ask Exa answer endpoint. Returns full AnswerResponse with answer, citations, requestId, and cost. Supports text, model, systemPrompt, outputSchema, userLocation via options.",
			parameters: Type.Object({
				query: Type.String({ description: "Question or query to answer." }),
				options: optionsSchema,
				maxOutputChars: maxOutputCharsSchema,
			}),
			execute: async (args) => {
				const exa = await exaClient();
				const result = await exa.answer(String(args.query), args.options as never);
				return stringifyResult(result, args.maxOutputChars);
			},
		},
	];
}
