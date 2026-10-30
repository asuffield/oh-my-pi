import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { DEFAULT_BASH_INTERCEPTOR_RULES } from "../../src/exec/settings";
import { ExtensionRuntime } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { Extension, ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type { Tool, ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

describe("BashTool pre-approval validateCall", () => {
	let temp: TempDir;
	let cwd: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;

	beforeEach(async () => {
		temp = TempDir.createSync("@omp-bash-validate-");
		cwd = temp.path();
		originalAgentDir = getAgentDir();
		setAgentDir(path.join(cwd, "agent"));
		authStorage = await AuthStorage.create(path.join(cwd, "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
		setAgentDir(originalAgentDir);
		temp.removeSync();
	});

	function createSession(settingsOverrides: Record<string, unknown> = {}): ToolSession {
		return {
			cwd,
			hasUI: true,
			skills: [],
			getSessionFile: () => null,
			settings: Settings.isolated({
				"async.enabled": true,
				"launch.enabled": true,
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
				...settingsOverrides,
			}),
		} as unknown as ToolSession;
	}

	function runnerWith(
		sessionManager: SessionManager,
		select?: ExtensionUIContext["select"],
		hooks?: { onToolCall?: (event: unknown) => unknown },
	): ExtensionRunner {
		const handlers = new Map<string, ((event: unknown) => Promise<unknown>)[]>();
		if (hooks?.onToolCall) {
			handlers.set("tool_call", [async (event: unknown) => hooks.onToolCall!(event)]);
		}
		const extension: Extension = {
			path: "test-ext",
			resolvedPath: "/test/test-ext.ts",
			handlers,
			tools: new Map(),
			assistantThinkingRenderers: [],
			assistantTextRenderers: [],
			linkSchemes: [],
			fileWriteFallbackHandlers: [],
			fileDeleteFallbackHandlers: [],
			messageRenderers: new Map(),
			composerShapes: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const runner = new ExtensionRunner(
			[extension],
			new ExtensionRuntime(),
			getAgentDir(),
			sessionManager,
			modelRegistry,
		);
		const ui = select ? ({ select } as unknown as ExtensionUIContext) : undefined;
		runner.initialize({} as never, {} as never, undefined, ui);
		return runner;
	}

	it("rejects intercepted bash command in always-ask mode without prompting user", async () => {
		const select = vi.fn(async () => "Approve");
		const session = createSession();
		const tool: Tool = new BashTool(session);
		const sessionManager = SessionManager.inMemory(cwd);
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(sessionManager, select));
		const context = {
			sessionManager,
			settings: Settings.isolated({
				"tools.approvalMode": "always-ask",
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
			}),
			toolNames: ["read", "bash"],
		} as unknown as AgentToolContext;

		await expect(
			wrapper.execute("call-1", { command: "cat package.json" }, undefined, undefined, context),
		).rejects.toThrow("Use the `read` tool instead of cat/head/tail");

		expect(select).not.toHaveBeenCalled();
	});

	it("fails with interceptor redirect error in headless mode without UI rather than missing UI error", async () => {
		const session = createSession();
		const tool: Tool = new BashTool(session);
		const sessionManager = SessionManager.inMemory(cwd);
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(sessionManager, undefined));
		const context = {
			sessionManager,
			settings: Settings.isolated({
				"tools.approvalMode": "write",
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
			}),
			toolNames: ["grep", "bash"],
		} as unknown as AgentToolContext;

		await expect(
			wrapper.execute("call-2", { command: "grep foo src/file.ts" }, undefined, undefined, context),
		).rejects.toThrow("Use the `grep` tool instead of grep/rg");
	});

	it("rejects disabled service launch before prompting user", async () => {
		const select = vi.fn(async () => "Approve");
		const session = createSession({ "launch.enabled": false });
		const tool: Tool = new BashTool(session);
		const sessionManager = SessionManager.inMemory(cwd);
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(sessionManager, select));
		const context = {
			sessionManager,
			settings: Settings.isolated({
				"tools.approvalMode": "always-ask",
				"launch.enabled": false,
			}),
			toolNames: ["bash"],
		} as unknown as AgentToolContext;

		await expect(
			wrapper.execute("call-3", { command: "npm start", name: "dev" }, undefined, undefined, context),
		).rejects.toThrow("Service launch is disabled in this session");

		expect(select).not.toHaveBeenCalled();
	});

	it("rejects disabled async execution before prompting user", async () => {
		const select = vi.fn(async () => "Approve");
		const session = createSession({ "async.enabled": false });
		const tool: Tool = new BashTool(session);
		const sessionManager = SessionManager.inMemory(cwd);
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(sessionManager, select));
		const context = {
			sessionManager,
			settings: Settings.isolated({
				"tools.approvalMode": "always-ask",
				"async.enabled": false,
			}),
			toolNames: ["bash"],
		} as unknown as AgentToolContext;

		await expect(
			wrapper.execute("call-4", { command: "sleep 10", async: true }, undefined, undefined, context),
		).rejects.toThrow("Async bash execution is disabled. Enable async.enabled to use async mode");

		expect(select).not.toHaveBeenCalled();
	});

	it("rejects virtual working directory with pty before prompting user", async () => {
		const select = vi.fn(async () => "Approve");
		const session = createSession();
		const tool: Tool = new BashTool(session);
		const sessionManager = SessionManager.inMemory(cwd);
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(sessionManager, select));
		const context = {
			sessionManager,
			settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
			ui: {} as never,
			hasUI: true,
			toolNames: ["bash"],
		} as unknown as AgentToolContext;

		await expect(
			wrapper.execute(
				"call-5",
				{ command: "echo ok", cwd: "local://work", pty: true },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow(
			"exists only in the embedded shell; pty commands run external processes and need a host directory",
		);

		expect(select).not.toHaveBeenCalled();
	});

	it("evaluates validateCall on revised input from extension tool_call hooks", async () => {
		const select = vi.fn(async () => "Approve");
		const session = createSession();
		const tool: Tool = new BashTool(session);
		const sessionManager = SessionManager.inMemory(cwd);
		// Extension hook rewrites an otherwise benign command to an intercepted one
		const runner = runnerWith(sessionManager, select, {
			onToolCall: () => ({ input: { command: "cat file.txt" } }),
		});
		const wrapper = new ExtensionToolWrapper(tool, runner);
		const context = {
			sessionManager,
			settings: Settings.isolated({
				"tools.approvalMode": "always-ask",
				"bashInterceptor.enabled": true,
				"bashInterceptor.patterns": DEFAULT_BASH_INTERCEPTOR_RULES,
			}),
			toolNames: ["read", "bash"],
		} as unknown as AgentToolContext;

		await expect(wrapper.execute("call-6", { command: "echo ok" }, undefined, undefined, context)).rejects.toThrow(
			"Use the `read` tool instead of cat/head/tail",
		);

		expect(select).not.toHaveBeenCalled();
	});
});
