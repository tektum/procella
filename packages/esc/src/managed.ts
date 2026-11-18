// Stack-managed ESC environments (Pulumi CLI `stack init --esc-config`).
//
// A managed stack owns the ESC environment `<project>/<stack>`. The service creates it with the
// placeholder definition the CLI writes to the stack file and deletes it with the stack.

import { NotFoundError } from "@procella/types";
import type { EscService } from "./service.js";

/**
 * Initial definition of a stack-managed environment. It matches the placeholder the Pulumi CLI
 * writes to the stack file, so the first evaluation opens the published revision.
 */
export const MANAGED_ENVIRONMENT_PLACEHOLDER = "values:\n  pulumiConfig: {}\n";

/** Splits a managed environment name "<project>/<env>"; returns null when malformed. */
export function parseManagedEnvironmentName(
	name: string,
): { projectName: string; envName: string } | null {
	const slash = name.indexOf("/");
	if (slash <= 0 || slash === name.length - 1 || name.indexOf("/", slash + 1) !== -1) {
		return null;
	}
	return { projectName: name.slice(0, slash), envName: name.slice(slash + 1) };
}

/**
 * Deletes a removed stack's managed environment. A missing or malformed environment is already
 * gone as far as the stack is concerned; other errors propagate to the caller.
 */
export async function deleteManagedEnvironment(
	esc: Pick<EscService, "deleteEnvironment">,
	tenantId: string,
	managedEnvironment: string,
): Promise<void> {
	const parsed = parseManagedEnvironmentName(managedEnvironment);
	if (!parsed) return;
	try {
		await esc.deleteEnvironment(tenantId, parsed.projectName, parsed.envName);
	} catch (err) {
		if (err instanceof NotFoundError) return;
		throw err;
	}
}
