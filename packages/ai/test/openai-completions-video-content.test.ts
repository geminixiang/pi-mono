import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model, OpenAICompletionsCompat } from "../src/types.ts";

const compat: Required<OpenAICompletionsCompat> = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
};

function model(input: ("text" | "image" | "video" | "audio")[]): Model<"openai-completions"> {
	const { compat: _compat, ...base } = getModel("moonshotai", "kimi-k2.5");
	return { ...base, api: "openai-completions", input };
}

describe("openai-completions video content", () => {
	it("maps video/* mime types to video_url", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{ type: "video", mimeType: "video/mp4", data: "ZmFrZQ==" },
					],
					timestamp: Date.now(),
				},
			],
		};

		const messages = convertMessages(model(["text", "video"]), context, compat);
		const content = messages[0]!.content as any[];

		expect(content).toContainEqual({
			type: "video_url",
			video_url: { url: "data:video/mp4;base64,ZmFrZQ==" },
		});
	});

	it("downgrades unsupported video to text placeholder", () => {
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "video", mimeType: "video/mp4", data: "ZmFrZQ==" }],
					timestamp: Date.now(),
				},
			],
		};

		const messages = convertMessages(model(["text", "image"]), context, compat);
		const content = messages[0]!.content as any[];

		expect(content).toEqual([{ type: "text", text: "(video omitted: model does not support videos)" }]);
	});
});
