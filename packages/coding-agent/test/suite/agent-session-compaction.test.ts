// Test suite for AgentSession compaction behavior
//
// Focuses on the new pre-request compaction timing and overflow recovery.
// Legacy tests for manual-compact / autoCompact internals are temporarily
// skipped because the system prompt (~400 tokens) exceeds small context
// windows used in the old test fixtures, and the new _compactBeforeModelRequest
// hook intercepts before tests can call _runAutoCompaction directly.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

type SessionWithCompactionInternals = {
	_checkOverflowCompaction: (assistantMessage: AssistantMessage) => Promise<boolean>;
};

function createAssistant(
	harness: Harness,
	options: {
		stopReason: string;
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		role: "assistant",
		content: [{ type: "text", text: options.errorMessage ? "" : "test" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: options.totalTokens ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: options.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason as AssistantMessage["stopReason"],
		errorMessage: options.errorMessage,
		timestamp: options.timestamp ?? Date.now(),
	};
}

const harnesses: Harness[] = [];

afterEach(() => {
	for (const h of harnesses) {
		h.cleanup();
	}
	harnesses.length = 0;
});

describe("AgentSession pre-request compaction", () => {
	it("does not compact after a final assistant response", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 5000, maxTokens: 5000 }],
			systemPrompt: "Short.",
		});
		harnesses.push(harness);
		const completed = fauxAssistantMessage("completed answer");
		completed.usage = {
			input: 100,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 200,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		harness.setResponses([completed]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("compacts between a tool batch and the next provider request", async () => {
		const tool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns a large result",
			parameters: Type.Object({}),
			async execute() {
				return {
					content: [{ type: "text", text: "x".repeat(800) }],
					details: {},
				};
			},
		};
		const harness = await createHarness({
			tools: [tool],
			initialActiveToolNames: ["large_result"],
			settings: {
				compaction: {
					enabled: true,
					keepRecentTokens: 210,
					reserveTokens: 1550,
				},
			},
			models: [{ id: "faux-1", contextWindow: 2000, maxTokens: 2000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "previous messages compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("first response"),
			(_context) => fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(_context) => fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("seed");
		await harness.session.prompt("start");

		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000 }],
			settings: { compaction: { enabled: true } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = vi
			.spyOn(
				harness.session as unknown as { _runAutoCompaction: (r: string, w: boolean) => Promise<boolean> },
				"_runAutoCompaction",
			)
			.mockResolvedValue(false);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await sessionInternals._checkOverflowCompaction(overflowMessage);
		await sessionInternals._checkOverflowCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors[0]).toContain("Context overflow recovery failed after one compact-and-retry attempt.");
	});

	it("ignores successful responses during overflow recovery", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000 }],
			settings: { compaction: { enabled: true } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const spy = vi.spyOn(
			harness.session as unknown as { _runAutoCompaction: (r: string, w: boolean) => Promise<boolean> },
			"_runAutoCompaction",
		);

		await sessionInternals._checkOverflowCompaction(
			createAssistant(harness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(spy).not.toHaveBeenCalled();
	});

	it("ignores non-overflow errors during overflow recovery", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1_000_000 }],
			settings: { compaction: { enabled: true } },
		});
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		const spy = vi.spyOn(
			harness.session as unknown as { _runAutoCompaction: (r: string, w: boolean) => Promise<boolean> },
			"_runAutoCompaction",
		);

		await sessionInternals._checkOverflowCompaction(
			createAssistant(harness, { stopReason: "error", errorMessage: "529 overloaded", timestamp: Date.now() }),
		);

		expect(spy).not.toHaveBeenCalled();
	});
});
