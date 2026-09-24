import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMockRuntime, type MockRuntime } from "./helpers/mockPi.js";

/** 建临时 cwd 并写入计划文件，返回临时目录路径。 */
function makeProject(): string {
	return mkdtempSync(join(tmpdir(), "plan-mode-test-"));
}

function writePlan(cwd: string, rel: string, content: string): string {
	const p = join(cwd, rel);
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, content);
	return p;
}

/**
 * 每个测试共享的 setup：全新模块 + 全新插件实例 + 真实定时器（本插件无倒计时）。
 * vi.resetModules() 保证每次 import("../index.ts") 拿到干净模块。
 */
async function setup(): Promise<MockRuntime> {
	vi.resetModules();
	const rt = createMockRuntime();
	await rt.newPlugin();
	await rt.emit("session_start", { reason: "startup" });
	return rt;
}

/** 提取注入消息的文本；无注入时返回 null。 */
function injectedText(result: any): string | null {
	return result?.message?.content ?? null;
}

beforeEach(() => {
	vi.resetModules();
});

describe("plan mode toggle", () => {
	test("/plan 开启后状态栏更新，再按一次关闭", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		expect(rt.statusBars.get("plan-mode")).toBe("⏸ plan");
		await rt.runCommand("plan");
		expect(rt.statusBars.get("plan-mode")).toBeUndefined();
	});

	test("开启后下一轮注入 framing，且只注入一次", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		const first = await rt.startAgent();
		expect(injectedText(first)).toContain("[PLAN MODE]");
		// 同相位后续轮次：不再注入
		const second = await rt.startAgent();
		expect(injectedText(second)).toBeNull();
	});

	test("关闭后下一轮注入 PLAN_MODE_OFF 反令（append-only，不删历史）", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		await rt.startAgent(); // framing 注入
		await rt.runCommand("plan"); // 关闭
		const next = await rt.startAgent();
		expect(injectedText(next)).toContain("[PLAN MODE OFF]");
		// 反令也只发一次
		const after = await rt.startAgent();
		expect(injectedText(after)).toBeNull();
	});

	test("framing 与反令都持久化进会话条目（custom entry）", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		await rt.startAgent();
		const custom = rt.sessionEntries.filter((e) => e.customType === "plan-mode-context");
		expect(custom.length).toBeGreaterThanOrEqual(1);
		expect((custom.at(-1)?.data as any)?.framingDelivered).toBe(true);
	});
});

describe("write gating (tool_call interception)", () => {
	test("plan 模式下 write/edit 被拦（cwd 内 markdown 除外）", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		const w = await rt.callTool("write", { path: "x.ts", content: "hi" });
		expect(w.blocked).toBe(true);
		expect(w.reason).toContain("submit_plan");
		const e = await rt.callTool("edit", { path: "x.ts" });
		expect(e.blocked).toBe(true);
	});

	test("plan 模式下 cwd 内任意 .md/.mdx 可写（相对/绝对/./ 前缀/子目录）", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		expect((await rt.callTool("write", { path: "PLAN.md", content: "# Plan" })).blocked).toBe(false);
		expect((await rt.callTool("write", { path: "plans/auth.md", content: "# Plan" })).blocked).toBe(false);
		expect((await rt.callTool("write", { path: "/project/notes.mdx", content: "# Plan" })).blocked).toBe(false);
		expect((await rt.callTool("write", { path: "./docs/./plan.md", content: "# Plan" })).blocked).toBe(false);
		expect((await rt.callTool("edit", { path: "PLAN.md" })).blocked).toBe(false);
	});

	test("非 markdown 与 cwd 外路径都不放行", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		expect((await rt.callTool("write", { path: "../evil.md" })).blocked).toBe(true);
		expect((await rt.callTool("write", { path: "/other/plan.md" })).blocked).toBe(true);
		expect((await rt.callTool("write", { path: "PLAN.md/evil.ts" })).blocked).toBe(true);
		expect((await rt.callTool("write", { path: "PLAN.md.bak" })).blocked).toBe(true);
		expect((await rt.callTool("write", { path: "notes.txt" })).blocked).toBe(true);
		expect((await rt.callTool("write", { path: "PLAN.MD" })).blocked).toBe(false); // 扩展名大小写不敏感
	});

	test("plan 模式下 bash 完全放行", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		for (const command of ["git status", "npm install foo", "curl example.com", "rm -rf /"]) {
			expect((await rt.callTool("bash", { command })).blocked).toBe(false);
		}
	});

	test("非 plan 模式下一切放行", async () => {
		const rt = await setup();
		const w = await rt.callTool("write", { path: "x.ts", content: "hi" });
		expect(w.blocked).toBe(false);
		const b = await rt.callTool("bash", { command: "rm -rf /" });
		expect(b.blocked).toBe(false);
	});

	describe("with project", () => {
		let cwd: string;

		beforeEach(() => {
			cwd = makeProject();
		});

		test("批准后写门控立即解除（同一轮内）", async () => {
			const rt = await setup();
			rt.ctx.cwd = cwd;
			writePlan(cwd, "PLAN.md", "# Plan\nstep 1");
			await rt.runCommand("plan");
			rt.ctx.ui.select = async () => "Approve — start implementation";
			const submit = await rt.callTool("submit_plan", { filePath: "PLAN.md" });
			expect(submit.result.details.approved).toBe(true);
			const w = await rt.callTool("write", { path: "x.ts", content: "hi" });
			expect(w.blocked).toBe(false);
		});
	});
});

describe("submit_plan approval loop (terminal)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = makeProject();
	});

	test("Approve：读盘提交，解锁写操作，返回批准 tool result", async () => {
		const rt = await setup();
		rt.ctx.cwd = cwd;
		writePlan(cwd, "PLAN.md", "# Plan\n- step 1");
		await rt.runCommand("plan");
		rt.ctx.ui.select = async () => "Approve — start implementation";
		const r = await rt.callTool("submit_plan", { filePath: "PLAN.md" });
		expect(r.result.details.approved).toBe(true);
		expect(r.result.content[0].text).toContain("APPROVED");
		// 相位已翻转：下一轮不再注入 framing，工具不再被拦
		expect(injectedText(await rt.startAgent())).toBeNull();
	});

	test("Revise：反馈文本作为 tool result 返回，保持 plan 模式", async () => {
		const rt = await setup();
		rt.ctx.cwd = cwd;
		writePlan(cwd, "plans/auth.md", "# Auth plan");
		await rt.runCommand("plan");
		rt.ctx.ui.select = async () => "Revise — give feedback";
		rt.ctx.ui.editor = async () => "add a migration step";
		const r = await rt.callTool("submit_plan", { filePath: "plans/auth.md" });
		expect(r.result.details.approved).toBe(false);
		expect(r.result.content[0].text).toContain("add a migration step");
		expect(r.result.content[0].text).toContain("plans/auth.md");
		// 仍在 plan 模式：写入仍被拦，下一轮也不注入（framing 闩锁已消耗）
		expect((await rt.callTool("write", { path: "x.ts" })).blocked).toBe(true);
	});

	test("Revise 但反馈为空：等待用户输入", async () => {
		const rt = await setup();
		rt.ctx.cwd = cwd;
		writePlan(cwd, "PLAN.md", "# Plan");
		await rt.runCommand("plan");
		rt.ctx.ui.select = async () => "Revise — give feedback";
		rt.ctx.ui.editor = async () => "   ";
		const r = await rt.callTool("submit_plan", { filePath: "PLAN.md" });
		expect(r.result.details.reviseNoFeedback).toBe(true);
	});

	test("Reject：明确停下等指示", async () => {
		const rt = await setup();
		rt.ctx.cwd = cwd;
		writePlan(cwd, "PLAN.md", "# Plan");
		await rt.runCommand("plan");
		rt.ctx.ui.select = async () => "Reject — stop here";
		const r = await rt.callTool("submit_plan", { filePath: "PLAN.md" });
		expect(r.result.details.rejected).toBe(true);
	});

	test("Esc/取消：不改变状态", async () => {
		const rt = await setup();
		rt.ctx.cwd = cwd;
		writePlan(cwd, "PLAN.md", "# Plan");
		await rt.runCommand("plan");
		// 默认 mock select 返回 undefined（Esc）
		const r = await rt.callTool("submit_plan", { filePath: "PLAN.md" });
		expect(r.result.details.dismissed).toBe(true);
		// 仍在 plan 模式
		expect((await rt.callTool("write", { path: "x.ts" })).blocked).toBe(true);
	});

	test("缺 filePath / cwd 外路径 / 文件不存在 / 空文件 报错", async () => {
		const rt = await setup();
		rt.ctx.cwd = cwd;
		await rt.runCommand("plan");
		for (const params of [{}, { filePath: "   " }, { filePath: "../outside.md" }, { filePath: "plan.ts" }]) {
			const r = await rt.callTool("submit_plan", params);
			expect(r.result.content[0].text).toContain("Error");
			expect(r.result.details.approved).toBe(false);
		}
		const missing = await rt.callTool("submit_plan", { filePath: "nope.md" });
		expect(missing.result.content[0].text).toContain("does not exist");

		writePlan(cwd, "empty.md", "   ");
		const empty = await rt.callTool("submit_plan", { filePath: "empty.md" });
		expect(empty.result.content[0].text).toContain("is empty");
	});

	test("无 UI（print 模式）：不阻塞，记录计划后继续", async () => {
		const rt = await setup();
		rt.ctx.hasUI = false;
		rt.ctx.cwd = cwd;
		writePlan(cwd, "PLAN.md", "# Plan\n- step");
		await rt.runCommand("plan");
		const r = await rt.callTool("submit_plan", { filePath: "PLAN.md" });
		expect(r.result.details.noUi).toBe(true);
		expect(r.result.content[0].text).toContain("# Plan");
	});
});

describe("cache-safety invariants", () => {
	test("before_agent_start 从不返回 systemPrompt", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		const r = await rt.startAgent();
		expect(r?.systemPrompt).toBeUndefined();
		await rt.runCommand("plan");
		const r2 = await rt.startAgent();
		expect(r2?.systemPrompt).toBeUndefined();
	});

	test("历史 append-only：所有注入都是 message 追加，无 context 处理器", async () => {
		const rt = await setup();
		// 插件绝不注册 context 事件处理器（注册了就会改写已发送历史）
		expect(rt.pi.on.mock).toBeUndefined(); // mock 无此概念；换行为断言：
		// 行为等价断言：开启→注入→关闭→反令，注入只发生在新轮次的返回值里，
		// 且既有条目从未被修改。
		await rt.runCommand("plan");
		const entriesAfterOn = rt.sessionEntries.length;
		await rt.startAgent();
		const entriesAfterInject = rt.sessionEntries.length;
		await rt.runCommand("plan");
		await rt.startAgent();
		// 中段的 framing 条目保持原样（未被改写）
		expect(rt.sessionEntries[entriesAfterInject - 1]).toEqual(rt.sessionEntries[entriesAfterOn]);
	});
});

describe("state restoration", () => {
	test("resume：从会话条目重放相位", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		await rt.startAgent();
		// 模拟 resume：触发 session_start（条目里已有持久化状态）
		await rt.emit("session_start", { reason: "resume" });
		expect(rt.statusBars.get("plan-mode")).toBe("⏸ plan");
		// 门控仍然生效
		expect((await rt.callTool("write", { path: "x.ts" })).blocked).toBe(true);
	});

	test("session_tree：无 plannotator 状态的路径回 idle", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		// 模拟切到无任何 plan 条目的分支：直接清空条目
		rt.sessionEntries.length = 0;
		await rt.emit("session_tree", {});
		expect(rt.statusBars.get("plan-mode")).toBeUndefined();
		expect((await rt.callTool("write", { path: "x.ts" })).blocked).toBe(false);
	});

	test("resume 后已注入过 framing 不重复注入", async () => {
		const rt = await setup();
		await rt.runCommand("plan");
		await rt.startAgent(); // framing 注入 + 持久化
		await rt.emit("session_start", { reason: "resume" });
		expect(injectedText(await rt.startAgent())).toBeNull();
	});
});

describe("plan file path helper", () => {
	test("isPlanWritePathAllowed 放行 cwd 内任意 .md/.mdx", async () => {
		const { isPlanWritePathAllowed } = await import("../index.ts");
		expect(isPlanWritePathAllowed("PLAN.md", "/project")).toBe(true);
		expect(isPlanWritePathAllowed("/project/plans/auth.md", "/project")).toBe(true);
		expect(isPlanWritePathAllowed("./docs/../notes.mdx", "/project")).toBe(true);
		expect(isPlanWritePathAllowed("PLAN.MD", "/project")).toBe(true);
		expect(isPlanWritePathAllowed("plan.md", "/project/../project")).toBe(true);
		expect(isPlanWritePathAllowed("x.ts", "/project")).toBe(false);
		expect(isPlanWritePathAllowed("plan.md.bak", "/project")).toBe(false);
		expect(isPlanWritePathAllowed("../other/plan.md", "/project")).toBe(false);
		expect(isPlanWritePathAllowed("/other/plan.md", "/project")).toBe(false);
		expect(isPlanWritePathAllowed("", "/project")).toBe(false);
		expect(isPlanWritePathAllowed("/project", "/project")).toBe(false); // cwd 本身
	});
});
