/**
 * 共享的 pi 运行时 mock：模拟 extension 注册、工具/命令、tool_call 拦截、
 * 消息注入、会话条目重放。每个测试创建独立实例，互不污染。
 */
export type Handler = (event: any, ctx: any) => Promise<any>;

export interface SessionEntry {
	type: string;
	id?: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; content: any };
}

export function createMockRuntime() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sessionEntries: SessionEntry[] = [];
	const notifications: { msg: string; kind: string }[] = [];
	const statusBars = new Map<string, string | undefined>();
	const sentUserMessages: Array<{ content: string; options?: unknown }> = [];
	let isIdleValue = true;

	const ctx: any = {
		hasUI: true,
		cwd: "/project",
		isIdle: () => isIdleValue,
		sessionManager: {
			// 与真实 pi 一致：扩展从 ctx.sessionManager.getBranch() 重放会话条目
			getBranch: () => sessionEntries,
		},
		ui: {
			notify: (msg: string, kind = "info") => notifications.push({ msg, kind }),
			setStatus: (key: string, val: string | undefined) => statusBars.set(key, val),
			select: async () => undefined,
			editor: async () => undefined,
		},
	};

	const pi: any = {
		on: (name: string, handler: Handler) => {
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name)!.push(handler);
		},
		registerCommand: (name: string, def: any) => commands.set(name, def),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		sendUserMessage: (content: any, options?: any) => {
			sentUserMessages.push({ content, options });
		},
		appendEntry: (customType: string, data: unknown) => {
			const entry: SessionEntry = { type: "custom", id: `e${sessionEntries.length}`, customType, data };
			sessionEntries.push(entry);
		},
	};

	/** 触发一个事件（按注册顺序调用所有 handler），返回最后一个 handler 的返回值。 */
	const emit = async (name: string, event: any = {}) => {
		let last: any;
		for (const h of handlers.get(name) ?? []) last = await h(event, ctx);
		return last;
	};

	/** 执行已注册命令（模拟 pi 命令入口）。 */
	const runCommand = async (name: string, args = "") => {
		const cmd = commands.get(name);
		if (!cmd) throw new Error(`unknown command: ${name}`);
		await cmd.handler(args, ctx);
	};

	/** 模拟一次 agent run 的启动消息注入：返回 before_agent_start 的返回值。 */
	const startAgent = async (prompt = "do the thing") => {
		return emit("before_agent_start", { prompt });
	};

	/** 模拟一次工具调用（含拦截器 preflight，与真实 pi 语义一致：block 则不执行）。 */
	const callTool = async (toolName: string, input: any = {}) => {
		for (const h of handlers.get("tool_call") ?? []) {
			const result = await h({ toolName, input }, ctx);
			if (result?.block) return { blocked: true as const, reason: result.reason as string };
		}
		const tool = tools.get(toolName);
		if (!tool) return { blocked: false as const, missing: true as const };
		const result = await tool.execute("call-1", input, undefined, undefined, ctx);
		return { blocked: false as const, result };
	};

	/** 创建一个全新插件实例（default(pi) 每次调用都创建全新 state）。 */
	const newPlugin = async () => {
		const mod = await import("../../index.ts");
		mod.default(pi);
	};

	/** 从当前会话条目重建（模拟 pi 在 session_start/session_tree 时宿主侧行为之外，
	 * 扩展内部用 appendEntry 的数据做重放——测试直接触发事件即可）。 */
	return {
		pi,
		ctx,
		emit,
		runCommand,
		startAgent,
		callTool,
		newPlugin,
		notifications,
		statusBars,
		sessionEntries,
		tools,
		commands,
		sentUserMessages,
		setIdle: (v: boolean) => {
			isIdleValue = v;
		},
	};
}

export type MockRuntime = ReturnType<typeof createMockRuntime>;
