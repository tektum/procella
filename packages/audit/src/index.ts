import type DescopeSdk from "@descope/node-sdk";

type DescopeClient = ReturnType<typeof DescopeSdk>;

type DescopeAuditRecord = {
	id?: string;
	action?: string;
	type?: string;
	actorId?: string;
	tenantId?: string;
	userId?: string;
	createdTime?: string | number;
	createdAt?: string | number;
	data?: Record<string, unknown>;
};

type DescopeAuditSearchResponse = {
	data?: DescopeAuditRecord[];
};

export const AuditAction = {
	STACK_CREATE: "stack.create",
	STACK_DELETE: "stack.delete",
	STACK_UPDATE: "stack.update",
	STACK_RENAME: "stack.rename",
	STACK_EXPORT: "stack.export",
	STACK_IMPORT: "stack.import",
	STACK_TAGS_UPDATE: "stack.tags.update",
	UPDATE_CREATE: "update.create",
	UPDATE_CANCEL: "update.cancel",
	UPDATE_COMPLETE: "update.complete",
	TOKEN_CREATE: "token.create",
	TOKEN_REVOKE: "token.revoke",
	WEBHOOK_CREATE: "webhook.create",
	WEBHOOK_DELETE: "webhook.delete",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

const NAME_SEGMENT = "[a-zA-Z0-9._-]+";

export interface AuditLogEntry {
	id: string;
	actorId: string;
	actorType: "user" | "token" | "workload";
	action: AuditActionValue;
	resourceType: string;
	resourceId: string;
	ipAddress?: string;
	userAgent?: string;
	metadata?: Record<string, unknown>;
	createdAt: Date;
}

export interface AuditLogParams {
	startTime?: Date;
	endTime?: Date;
	action?: string;
	page?: number;
	pageSize?: number;
}

export interface AuditService {
	log(tenantId: string, entry: Omit<AuditLogEntry, "id" | "createdAt">): void;
	query(
		tenantId: string,
		params: AuditLogParams,
	): Promise<{ entries: AuditLogEntry[]; total: number }>;
	export(
		tenantId: string,
		params: Omit<AuditLogParams, "page" | "pageSize">,
	): Promise<AuditLogEntry[]>;
}

export function mapRouteToAction(method: string, path: string): AuditActionValue | null {
	if (
		method === "POST" &&
		new RegExp(`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}$`).test(path)
	) {
		return AuditAction.STACK_CREATE;
	}
	if (
		method === "DELETE" &&
		new RegExp(`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}$`).test(path)
	) {
		return AuditAction.STACK_DELETE;
	}
	if (
		method === "POST" &&
		new RegExp(`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}/rename$`).test(path)
	) {
		return AuditAction.STACK_RENAME;
	}
	if (
		method === "PATCH" &&
		new RegExp(`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}/tags$`).test(path)
	) {
		return AuditAction.STACK_TAGS_UPDATE;
	}
	if (
		method === "POST" &&
		new RegExp(
			`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}/(?:update|preview|refresh|destroy)$`,
		).test(path)
	) {
		return AuditAction.UPDATE_CREATE;
	}
	if (
		method === "POST" &&
		new RegExp(
			`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}/update/${NAME_SEGMENT}/complete$`,
		).test(path)
	) {
		return AuditAction.UPDATE_COMPLETE;
	}
	if (
		method === "POST" &&
		new RegExp(
			`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}/update/${NAME_SEGMENT}/cancel$`,
		).test(path)
	) {
		return AuditAction.UPDATE_CANCEL;
	}
	if (
		method === "POST" &&
		new RegExp(`^/api/stacks/${NAME_SEGMENT}/${NAME_SEGMENT}/${NAME_SEGMENT}/import$`).test(path)
	) {
		return AuditAction.STACK_IMPORT;
	}
	if (method === "POST" && /^\/api\/orgs\/[^/]+\/tokens$/.test(path)) {
		return AuditAction.TOKEN_CREATE;
	}
	if (method === "DELETE" && /^\/api\/orgs\/[^/]+\/tokens\/[^/]+$/.test(path)) {
		return AuditAction.TOKEN_REVOKE;
	}
	if (method === "POST" && /^\/api\/orgs\/[^/]+\/hooks$/.test(path)) {
		return AuditAction.WEBHOOK_CREATE;
	}
	if (method === "DELETE" && /^\/api\/orgs\/[^/]+\/hooks\/[^/]+$/.test(path)) {
		return AuditAction.WEBHOOK_DELETE;
	}

	return null;
}

export function extractResourceType(path: string): string {
	if (path.startsWith("/api/stacks/")) {
		if (path.includes("/update/")) {
			return "update";
		}
		return "stack";
	}
	if (path.includes("/tokens")) {
		return "token";
	}
	if (path.includes("/hooks")) {
		return "webhook";
	}
	return "unknown";
}

export function extractResourceId(path: string): string {
	const stackMatch = path.match(/^\/api\/stacks\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
	if (stackMatch) {
		const org = stackMatch[1];
		const project = stackMatch[2];
		const stack = stackMatch[3];
		return stack ? `${org}/${project}/${stack}` : `${org}/${project}`;
	}

	const tokenMatch = path.match(/^\/api\/orgs\/([^/]+)\/tokens(?:\/([^/]+))?/);
	if (tokenMatch) {
		const org = tokenMatch[1];
		const tokenId = tokenMatch[2];
		return tokenId ? `${org}/${tokenId}` : org;
	}

	return path;
}

export function mapActionToType(action: string): "info" | "warn" | "error" {
	if (action.includes("delete") || action.includes("revoke") || action.includes("cancel")) {
		return "warn";
	}
	return "info";
}

function toEpochSeconds(date: Date | undefined): number | undefined {
	if (!date) {
		return undefined;
	}
	return Math.floor(date.getTime() / 1000);
}

function inferActorType(
	actorId: string,
	metadata: Record<string, unknown>,
): AuditLogEntry["actorType"] {
	if (metadata.workload && typeof metadata.workload === "object") {
		return "workload";
	}
	return actorId.startsWith("token:") ? "token" : "user";
}

function mapDescopeRecordToEntry(record: DescopeAuditRecord): AuditLogEntry {
	const data = record.data ?? {};
	const { resourceType, resourceId, ipAddress, userAgent, ...metadata } = data as Record<
		string,
		unknown
	>;

	const ts = record.createdTime ?? record.createdAt ?? Date.now();
	const createdAt =
		typeof ts === "number" ? new Date(ts > 1_000_000_000_000 ? ts : ts * 1000) : new Date(ts);

	const actorId = record.actorId ?? record.userId ?? "unknown";

	return {
		id: record.id ?? `${record.action ?? "audit"}-${createdAt.getTime()}`,
		actorId,
		actorType: inferActorType(actorId, metadata),
		action: (record.action ?? AuditAction.STACK_UPDATE) as AuditActionValue,
		resourceType: typeof resourceType === "string" ? resourceType : "unknown",
		resourceId: typeof resourceId === "string" ? resourceId : "unknown",
		ipAddress: typeof ipAddress === "string" ? ipAddress : undefined,
		userAgent: typeof userAgent === "string" ? userAgent : undefined,
		metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		createdAt,
	};
}

export class DescopeAuditService implements AuditService {
	constructor(private readonly sdk: DescopeClient) {}

	log(tenantId: string, entry: Omit<AuditLogEntry, "id" | "createdAt">): void {
		void this.createEvent(tenantId, entry).catch((error: unknown) => {
			console.error("[audit] Failed to push event to Descope:", error);
		});
	}

	private async createEvent(
		tenantId: string,
		entry: Omit<AuditLogEntry, "id" | "createdAt">,
	): Promise<void> {
		await this.sdk.management.audit.createEvent({
			action: entry.action,
			type: mapActionToType(entry.action),
			actorId: entry.actorId,
			tenantId,
			userId: entry.actorType === "user" ? entry.actorId : undefined,
			data: {
				resourceType: entry.resourceType,
				resourceId: entry.resourceId,
				ipAddress: entry.ipAddress,
				userAgent: entry.userAgent,
				...entry.metadata,
			},
		});
	}

	async query(
		tenantId: string,
		params: AuditLogParams,
	): Promise<{ entries: AuditLogEntry[]; total: number }> {
		const page = Math.max((params.page ?? 1) - 1, 0);
		const size = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
		const response = (await this.sdk.management.audit.search({
			tenants: [tenantId],
			actions: params.action ? [params.action] : undefined,
			from: toEpochSeconds(params.startTime),
			to: toEpochSeconds(params.endTime),
		})) as DescopeAuditSearchResponse;

		const allEntries = (response.data ?? []).map(mapDescopeRecordToEntry);
		const start = page * size;
		const entries = allEntries.slice(start, start + size);
		return { entries, total: allEntries.length };
	}

	async export(
		tenantId: string,
		params: Omit<AuditLogParams, "page" | "pageSize">,
	): Promise<AuditLogEntry[]> {
		const response = (await this.sdk.management.audit.search({
			tenants: [tenantId],
			actions: params.action ? [params.action] : undefined,
			from: toEpochSeconds(params.startTime),
			to: toEpochSeconds(params.endTime),
		})) as DescopeAuditSearchResponse;

		return (response.data ?? []).map(mapDescopeRecordToEntry);
	}
}

/**
 * In-memory audit sink for auth.mode=dev / local e2e.
 * Keeps a bounded ring buffer so security regressions (e.g. X-Forwarded-For)
 * can query real entries without Descope.
 */
export class NoopAuditService implements AuditService {
	private static readonly MAX_ENTRIES = 1_000;
	private readonly entriesByTenant = new Map<string, AuditLogEntry[]>();

	log(tenantId: string, entry: Omit<AuditLogEntry, "id" | "createdAt">): void {
		const full: AuditLogEntry = {
			...entry,
			id: crypto.randomUUID(),
			createdAt: new Date(),
		};
		const existing = this.entriesByTenant.get(tenantId) ?? [];
		existing.push(full);
		if (existing.length > NoopAuditService.MAX_ENTRIES) {
			existing.splice(0, existing.length - NoopAuditService.MAX_ENTRIES);
		}
		this.entriesByTenant.set(tenantId, existing);
	}

	async query(
		tenantId: string,
		params: AuditLogParams,
	): Promise<{ entries: AuditLogEntry[]; total: number }> {
		const filtered = this.filter(tenantId, params);
		const page = Math.max((params.page ?? 1) - 1, 0);
		const size = Math.min(Math.max(params.pageSize ?? 50, 1), 200);
		const start = page * size;
		return { entries: filtered.slice(start, start + size), total: filtered.length };
	}

	async export(
		tenantId: string,
		params: Omit<AuditLogParams, "page" | "pageSize">,
	): Promise<AuditLogEntry[]> {
		return this.filter(tenantId, params);
	}

	private filter(
		tenantId: string,
		params: Omit<AuditLogParams, "page" | "pageSize">,
	): AuditLogEntry[] {
		const entries = this.entriesByTenant.get(tenantId) ?? [];
		return entries.filter((entry) => {
			if (params.action && entry.action !== params.action) return false;
			if (params.startTime && entry.createdAt < params.startTime) return false;
			if (params.endTime && entry.createdAt > params.endTime) return false;
			return true;
		});
	}
}
