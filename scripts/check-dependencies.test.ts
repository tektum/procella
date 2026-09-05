import { describe, expect, test } from "bun:test";
import {
	type CommandResult,
	type CommandRunner,
	checkDependencies,
	runCommand,
} from "./check-dependencies.ts";

function queuedRunner(results: CommandResult[]): {
	run: CommandRunner;
	commands: string[][];
	timeouts: Array<number | undefined>;
} {
	const commands: string[][] = [];
	const timeouts: Array<number | undefined> = [];
	return {
		commands,
		timeouts,
		run: async (command, timeoutMs) => {
			commands.push(command);
			timeouts.push(timeoutMs);
			const result = results.shift();
			if (result === undefined) throw new Error("unexpected command");
			return result;
		},
	};
}

describe("dependency checks", () => {
	test("retries deadline-triggered termination before deduplication", async () => {
		const { run, commands, timeouts } = queuedRunner([
			{ exitCode: 137, timedOut: true },
			{ exitCode: 0, timedOut: false },
			{ exitCode: 0, timedOut: false },
		]);
		const delays: number[] = [];

		const exitCode = await checkDependencies({
			run,
			sleep: async (milliseconds) => {
				delays.push(milliseconds);
			},
		});

		expect(exitCode).toBe(0);
		expect(delays).toEqual([5_000]);
		expect(commands).toEqual([
			["bun", "audit", "--prod", "--audit-level=high"],
			["bun", "audit", "--prod", "--audit-level=high"],
			["bun", "dedupe", "--check"],
		]);
		expect(timeouts).toEqual([90_000, 90_000, 90_000]);
	});

	test("bounds the deduplication command", async () => {
		const { run, commands, timeouts } = queuedRunner([
			{ exitCode: 0, timedOut: false },
			{ exitCode: 137, timedOut: true },
		]);

		expect(await checkDependencies({ run })).toBe(124);
		expect(commands.at(-1)).toEqual(["bun", "dedupe", "--check"]);
		expect(timeouts).toEqual([90_000, 90_000]);
	});

	test("propagates an unrelated SIGKILL without retrying", async () => {
		const { run, commands } = queuedRunner([{ exitCode: 137, timedOut: false }]);

		expect(await checkDependencies({ run })).toBe(137);
		expect(commands).toHaveLength(1);
	});

	test("propagates audit findings without retrying", async () => {
		const { run, commands } = queuedRunner([{ exitCode: 1, timedOut: false }]);

		expect(await checkDependencies({ run })).toBe(1);
		expect(commands).toHaveLength(1);
	});

	test("fails after the configured timeout attempts", async () => {
		const { run, commands } = queuedRunner([
			{ exitCode: 137, timedOut: true },
			{ exitCode: 137, timedOut: true },
			{ exitCode: 137, timedOut: true },
		]);

		expect(await checkDependencies({ run, sleep: async () => {} })).toBe(124);
		expect(commands).toHaveLength(3);
	});

	test("distinguishes its deadline from an independent signal", async () => {
		// Fake timers cannot exercise Bun's real subprocess signal delivery.
		const timedOut = await runCommand(
			[process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
			25,
		);
		const independent = await runCommand(
			[process.execPath, "-e", 'process.kill(process.pid, "SIGKILL")'],
			1_000,
		);

		expect(timedOut.timedOut).toBe(true);
		expect(independent.timedOut).toBe(false);
		expect(independent.exitCode).not.toBe(0);
	});
});
