import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_NAME = "submit_plan";
const CMD_NAME = "plan";
const STATUS_KEY = "plan-mode";
const CUSTOM_TYPE = "plan-mode-context";

/** 规划期允许的 markdown 扩展名。计划写成 cwd 内任意 .md/.mdx 文件
 * （多 agent/多计划各写各的文件，名字有意义），经 submit_plan 提交时读盘。 */
const ALLOWED_PLAN_EXTENSIONS = new Set([".md", ".mdx"]);

/** 提交计划的默认建议文件名（仅用于提示文案，不做硬性限制）。 */
export const SUGGESTED_PLAN_FILE = "PLAN.md";

/** 进入 plan 模式时注入一次的框架说明。必须写明写操作会被拦截——
 * 因为系统提示词的 Available tools 一节始终列出全部工具，AI 不知道有门控。 */
export const PLANNING_FRAMING = `[PLAN MODE]
You are in plan mode.

Rules until the plan is approved:
- write/edit are hard-blocked EXCEPT for markdown plan files (.md/.mdx) inside the working directory. Write your plan there (e.g. PLAN.md, or a meaningful name like plans/auth.md); do NOT write or modify anything else.
- bash is available, but keep exploration read-only in practice: avoid installing, building, or otherwise mutating project state.
- Explore the codebase to build context, write the complete plan to a markdown file, then call ${TOOL_NAME} with that file's path.
- A blocked tool call is not an error to retry: it means plan mode forbids it.

Presenting the plan:
- The plan file must cover: context, approach, files to modify, implementation steps, and verification.
- The user reviews it in the terminal and can approve, revise (with feedback), or reject.
- If revised: update the SAME file in place and call ${TOOL_NAME} again with the same path. If approved: write access is fully restored — proceed with implementation in the same conversation.`;

/** 关闭 plan 模式时注入一次的反令。历史 append-only：旧框架说明留在原地，
 * 由这条显式声明使其失效（模型遵循最近指令），绝不回删历史中段。 */
export const PLAN_MODE_OFF_NOTICE = `[PLAN MODE OFF]
Plan mode has ended. The planning restrictions no longer apply: write/edit are fully available again (the markdown-plan-files-only limit is gone), and ${TOOL_NAME} is no longer needed. Respond and use tools normally. If the user wants plan mode again, they will re-enable it.`;

// ── 计划文件写判定 ─────────────────────────────────────────────────

/**
 * plan 模式下的 write/edit 判定。路径必须 resolve 到 cwd 内（无穿越、
 * 无绝对路径逃逸）且以 .md/.mdx 结尾——计划期可写任意 cwd 内 markdown，
 * 其余一律拦截。与 Plannotator 的 tool-scope.isPlanWritePathAllowed 同构。
 */
export function isPlanWritePathAllowed(rawPath: string, cwd: string): boolean {
	if (!rawPath) return false;
	const targetAbs = resolve(cwd, rawPath);
	const rel = relative(resolve(cwd), targetAbs);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	const ext = extname(targetAbs).toLowerCase();
	return ALLOWED_PLAN_EXTENSIONS.has(ext);
}

// ── 状态持久化 ─────────────────────────────────────────────────────

/** appendEntry 的 payload。planMode 记相位；framingDelivered 是注入闩锁
 * （框架说明每次进入只注入一次）；offNoticePending 是退出反令的待注入标记。 */
interface PersistedState {
	planMode: boolean;
	framingDelivered?: boolean;
	offNoticePending?: boolean;
}

function readPersistedState(ctx: ExtensionContext): PersistedState | undefined {
	return readPersistedBranch(ctx.sessionManager?.getBranch() ?? []);
}

/** 从会话条目序列（root → leaf）里找最后一条 plan-mode 持久化条目。sessionManager
 * 不可读时当作无状态（resume 后重注入一条 framing 的代价，可接受）。 */
export function readPersistedBranch(
	branch: Array<{ type?: string; customType?: string; data?: unknown }>,
): PersistedState | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "custom" && entry.customType === CUSTOM_TYPE) {
			return entry.data as PersistedState | undefined;
		}
	}
	return undefined;
}

// ── 插件主体 ───────────────────────────────────────────────────────

export default function planModeExtension(pi: ExtensionAPI): void {
	let planMode = false;
	let framingDelivered = false;
	let offNoticePending = false;
	let activeCtx: ExtensionContext | null = null;

	function persistState(): void {
		const data: PersistedState = { planMode, framingDelivered, offNoticePending };
		try {
			pi.appendEntry(CUSTOM_TYPE, data);
		} catch {
			// 持久化失败不致命：本进程内状态仍正确，仅 resume 后可能重注入一条 framing
		}
	}

	function updateStatus(ctx?: ExtensionContext | null): void {
		const c = ctx ?? activeCtx;
		if (!c) return;
		try {
			c.ui.setStatus(STATUS_KEY, planMode ? "⏸ plan" : undefined);
		} catch {
			// status 栏不可用（print 模式等）——忽略
		}
	}

	/** 进入/退出 plan 模式的共享入口（命令与快捷键共用）。 */
	async function togglePlanMode(ctx: ExtensionCommandContext): Promise<void> {
		if (planMode) {
			// 退出：状态翻转 + 反令随下一轮注入（append-only countermand）
			planMode = false;
			framingDelivered = false;
			offNoticePending = true;
			persistState();
			ctx.ui.notify("Plan mode off. Full access restored.", "info");
		} else {
			planMode = true;
			framingDelivered = false;
			offNoticePending = false; // 重新进入即取代未投递的反令
			persistState();
			ctx.ui.notify(
				`Plan mode on. write/edit are blocked except for markdown files (.md/.mdx) inside the working directory until the plan is approved via submit_plan.`,
				"info",
			);
		}
		updateStatus(ctx);
	}

	// ── 命令 / 快捷键 / 启动 flag ────────────────────────────────

	pi.registerCommand(CMD_NAME, {
		description: "Toggle Codex-style plan mode (writes blocked until plan approval)",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// ── 消息注入：每相位一次，append-only ─────────────────────────
	// 从不返回 systemPrompt：那是每轮重建缓存前缀的第一杀手。

	pi.on("before_agent_start", async () => {
		if (offNoticePending) {
			offNoticePending = false;
			persistState();
			return {
				message: {
					customType: CUSTOM_TYPE,
					content: PLAN_MODE_OFF_NOTICE,
					display: false,
				},
			};
		}
		if (planMode && !framingDelivered) {
			framingDelivered = true;
			persistState();
			return {
				message: {
					customType: CUSTOM_TYPE,
					content: PLANNING_FRAMING,
					display: false,
				},
			};
		}
		return;
	});

	// ── 写门控：tool_call 拦截（零缓存成本，append-only）──────────
	// 不用 setActiveTools：移除工具属于非增量变更，会重发完整 tools 数组
	// 并重建系统提示词，每次相位转换打爆一次缓存前缀。

	pi.on("tool_call", async (event, ctx) => {
		if (!planMode) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const inputPath = String((event.input as { path?: unknown })?.path ?? "");
			const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			if (isPlanWritePathAllowed(inputPath, cwd)) return;
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is blocked outside markdown plan files (.md/.mdx) inside the working directory. Write your plan to a file like ${SUGGESTED_PLAN_FILE} and present it via ${TOOL_NAME}; full write access returns after approval.`,
			};
		}
	});

	// ── submit_plan 工具：终端内批准回路（Codex 风格）────────────
	// 注册一次、永不移出 active（见文件头缓存安全设计第 2 条）。

	pi.registerTool({
		name: TOOL_NAME,
		label: "Submit plan",
		description: "Submits a written markdown plan file to the user for interactive review and approval before execution.",
		promptSnippet: "submit a markdown plan file for user review",
		promptGuidelines: [
			"Call present_plan only while in plan mode.",
			"Before calling present_plan, write the entire proposal to a markdown file (.md/.mdx) within the workspace (e.g., PLAN.md or plans/task.md).",
			"If the user provides feedback or requests revisions, edit the plan file in place and invoke present_plan again with the same path.",
			"Do NOT attempt implementation until the user explicitly approves the plan via present_plan."
		],
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory (e.g., 'PLAN.md' or 'plans/feature.md'). Must end in .md or .mdx. Pass the path only, do NOT pass the plan text.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const inputPath = String((params as { filePath?: unknown })?.filePath ?? "").trim();
			if (!inputPath) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${TOOL_NAME} requires a filePath pointing to your markdown plan file (e.g. "${SUGGESTED_PLAN_FILE}" or "plans/auth.md"). Write the plan to a .md/.mdx file first, then call again.`,
						},
					],
					details: { approved: false },
				};
			}

			const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
			if (!isPlanWritePathAllowed(inputPath, cwd)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
						},
					],
					details: { approved: false },
				};
			}

			const fullPath = resolve(cwd, inputPath);
			try {
				if (!statSync(fullPath).isFile()) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${inputPath} is not a regular file. Write your plan to a markdown file first, then call ${TOOL_NAME} with its path.`,
							},
						],
						details: { approved: false },
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} does not exist. Write your plan using the write tool first, then call ${TOOL_NAME} again.`,
						},
					],
					details: { approved: false },
				};
			}

			let planText: string;
			try {
				planText = readFileSync(fullPath, "utf-8").trim();
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { approved: false },
				};
			}
			if (!planText) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} is empty. Write your plan first, then call ${TOOL_NAME} again.`,
						},
					],
					details: { approved: false },
				};
			}

			// 无终端 UI（print/json 模式）：不能把 undefined 当批准。
			// 策略：直接把计划打出来并继续（不阻塞无人值守运行）。
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: `[plan mode, no interactive UI] Plan presented for the record:\n\n${planText}\n\nNo reviewer is attached; continuing without approval gate.`,
						},
					],
					details: { approved: true, noUi: true },
				};
			}

			// 终端确认（阻塞直到用户选择；Esc 取消 = undefined）
			const choice = await ctx.ui.select("Plan — review and decide:", [
				"Approve — start implementation",
				"Revise — give feedback",
				"Reject — stop here",
			]);

			if (choice === undefined) {
				// 取消/Esc：不改变状态，AI 原地等指示
				return {
					content: [{ type: "text", text: "Plan review dismissed. Stay in plan mode and wait for user input." }],
					details: { approved: false, dismissed: true },
				};
			}

			if (choice.startsWith("Approve")) {
				planMode = false;
				framingDelivered = false;
				offNoticePending = false;
				persistState();
				updateStatus(ctx);
				ctx.ui.notify("Plan approved — writes unlocked.", "info");
				return {
					content: [
						{
							type: "text",
							text: "Plan APPROVED. Write access is fully restored (write/edit unblocked). Proceed with implementation now, following the approved plan exactly.",
						},
					],
					details: { approved: true },
				};
			}

			if (choice.startsWith("Revise")) {
				const feedback = await ctx.ui.editor("What should change in the plan?", "");
				const feedbackText = feedback?.trim();
				if (!feedbackText) {
					return {
						content: [
							{ type: "text", text: "Revision requested but no feedback given. Wait for the user's next message." },
						],
						details: { approved: false, reviseNoFeedback: true },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Plan needs revision. User feedback:\n\n${feedbackText}\n\nUpdate the SAME file (${inputPath}) in place — other writes are still blocked — and call ${TOOL_NAME} again with the same path.`,
						},
					],
					details: { approved: false, feedback: feedbackText },
				};
			}

			// Reject
			return {
				content: [
					{ type: "text", text: "Plan REJECTED. Stop working on this plan and wait for the user's next instruction." },
				],
				details: { approved: false, rejected: true },
			};
		},
	});

	// ── 会话生命周期：恢复 / 分支切换 ─────────────────────────────

	/** 从活动会话路径重放相位。session_start（含 resume/fork）与 session_tree
	 *（树上切换）共用：新路径可能带完全不同的相位状态（比如另一分支里 plan
	 * 从未开启），必须按新路径重放，不能沿用内存值。 */
	async function resyncFromSession(ctx: ExtensionContext): Promise<void> {
		activeCtx = ctx;
		const restored = readPersistedState(ctx);
		if (restored) {
			planMode = restored.planMode;
			framingDelivered = restored.framingDelivered ?? false;
			offNoticePending = restored.offNoticePending ?? false;
		} else {
			// 无持久化条目的路径从未开启过 plan 模式，一律回 idle
			planMode = false;
			framingDelivered = false;
			offNoticePending = false;
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		await resyncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await resyncFromSession(ctx);
	});

	pi.on("session_shutdown", async () => {
		activeCtx = null;
	});
}
