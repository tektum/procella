#!/usr/bin/env bun

const AUDIT_COMMAND = ["bun", "audit", "--prod", "--audit-level=high"];
const DEDUPE_COMMAND = ["bun", "dedupe", "--check"];

export interface CommandResult {
	exitCode: number;
	timedOut: boolean;
}

export type CommandRunner = (command: string[], timeoutMs?: number) => Promise<CommandResult>;

interface CheckDependenciesOptions {
	run?: CommandRunner;
	sleep?: (milliseconds: number) => Promise<void>;
	maxAttempts?: number;
	commandTimeoutMs?: number;
	retryDelayMs?: number;
}

export async function runCommand(command: string[], timeoutMs?: number): Promise<CommandResult> {
	const process = Bun.spawn(command, {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	let timedOut = false;
	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					if (process.exitCode === null && process.signalCode === null) {
						timedOut = true;
						process.kill("SIGKILL");
					}
				}, timeoutMs);

	try {
		const exitCode = (await process.exited) as number | null;
		return { exitCode: exitCode ?? 1, timedOut };
	} finally {
		clearTimeout(timer);
	}
}

export async function checkDependencies({
	run = runCommand,
	sleep = Bun.sleep,
	maxAttempts = 3,
	commandTimeoutMs = 90_000,
	retryDelayMs = 5_000,
}: CheckDependenciesOptions = {}): Promise<number> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await run(AUDIT_COMMAND, commandTimeoutMs);
		if (result.exitCode === 0) {
			const dedupe = await run(DEDUPE_COMMAND, commandTimeoutMs);
			if (dedupe.timedOut) {
				console.error("::error::bun dedupe timed out");
				return 124;
			}
			return dedupe.exitCode;
		}
		if (!result.timedOut) return result.exitCode;
		if (attempt === maxAttempts) {
			console.error(`::error::bun audit timed out after ${attempt} attempts`);
			return 124;
		}

		console.warn(`::warning::bun audit timed out on attempt ${attempt}; retrying`);
		await sleep(attempt * retryDelayMs);
	}

	return 124;
}

if (import.meta.main) {
	const exitCode = await checkDependencies();
	if (exitCode !== 0) process.exit(exitCode);
}
