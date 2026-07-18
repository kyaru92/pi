import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settingsManager: SettingsManager;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		sessionManager = SessionManager.inMemory();
		settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("should resume after threshold compaction when only agent-level queued messages exist", async () => {
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const model = session.model!;
		const now = Date.now();
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "assistant response to compact" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now - 500,
		});
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		session.agent.streamFn = (summaryModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("compacted"),
						api: summaryModel.api,
						provider: summaryModel.provider,
						model: summaryModel.id,
						usage: {
							input: 10,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 10,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					},
				});
			});
			return stream;
		};

		session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "Queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		expect(session.pendingMessageCount).toBe(0);
		expect(session.agent.hasQueuedMessages()).toBe(true);

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await expect(runAutoCompaction("threshold", false)).resolves.toBe(true);

		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		const model = session.model!;
		const overflowMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		};

		const runAutoCompactionSpy = vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();

		const events: Array<{ type: string; reason: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason, errorMessage: event.errorMessage });
			}
		});

		const checkCompaction = (
			session as unknown as {
				_checkOverflowCompaction: (assistantMessage: AssistantMessage) => Promise<void>;
			}
		)._checkOverflowCompaction.bind(session);

		await checkCompaction(overflowMessage);
		await checkCompaction({ ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(events).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("should ignore successful responses during overflow recovery", async () => {
		const model = session.model!;
		const successfulMessage: AssistantMessage = {
			...fauxAssistantMessage("done"),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: model.contextWindow + 1,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: model.contextWindow + 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const runAutoCompactionSpy = vi.spyOn(
			session as unknown as {
				_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
			},
			"_runAutoCompaction",
		);
		const checkOverflowCompaction = (
			session as unknown as {
				_checkOverflowCompaction: (assistantMessage: AssistantMessage) => Promise<void>;
			}
		)._checkOverflowCompaction.bind(session);

		await checkOverflowCompaction(successfulMessage);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});
});
