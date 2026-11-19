// Stack-managed ESC environments (Pulumi CLI `stack init --esc-config`).
//
// A managed stack owns the ESC environment `<project>/<stack>`. The service creates it with the
// placeholder definition the CLI writes to the stack file and deletes it with the stack.

import { NotFoundError } from "@procella/types";
import type { EscService } from "./service.js";
import type { EscWriteOptions } from "./types.js";

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
 * Deletes the environment a removed stack owns, identified by the ID recorded when the stack
 * created it. Pass the stack-deletion transaction so it is deleted together with the stack.
 * Nothing is deleted when the stack has no recorded ID, when the environment is already gone,
 * or when another environment now has the same name (it was re-created after a delete).
 * Other errors propagate.
 */
export async function deleteManagedEnvironment(
	esc: Pick<EscService, "deleteEnvironment">,
	tenantId: string,
	owned: { managedEnvironment: string | null; managedEnvironmentId: string | null },
	options?: Pick<EscWriteOptions, "tx">,
): Promise<void> {
	if (!owned.managedEnvironment || !owned.managedEnvironmentId) return;
	const parsed = parseManagedEnvironmentName(owned.managedEnvironment);
	if (!parsed) return;
	try {
		await esc.deleteEnvironment(tenantId, parsed.projectName, parsed.envName, {
			...options,
			expectedId: owned.managedEnvironmentId,
		});
	} catch (err) {
		if (err instanceof NotFoundError) return;
		throw err;
	}
}
