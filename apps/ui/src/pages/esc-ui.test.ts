import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { Window } from "happy-dom";
import { createElement } from "react";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import {
	DESCOPE_SESSION_CLAIMS_STORAGE_KEY,
	DESCOPE_SESSION_TOKEN_STORAGE_KEY,
} from "../auth/sessionToken";

const configPath = resolve(import.meta.dir, "../config.ts");
const trpcPath = resolve(import.meta.dir, "../trpc.ts");
const useAuthConfigPath = resolve(import.meta.dir, "../hooks/useAuthConfig.ts");

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ListEnvironmentResult = Array<{
	name: string;
	currentRevisionNumber: number;
	updatedAt: Date;
	createdBy: string;
}>;

const getAuthHeadersMock = mock<() => Record<string, string>>(() => ({
	Authorization: "token devtoken123",
}));
const listEnvironmentsFetchMock = mock<
	(input: { project: string }) => Promise<ListEnvironmentResult>
>(async () => []);
const getCurrentTenantMock = mock((token: string) => `tenant-for-${token}`);
const utilsState = {
	esc: {
		listEnvironments: {
			fetch: (input: { project: string }) => listEnvironmentsFetchMock(input),
		},
	},
};

let authConfigState: { config: { mode: "dev" } | { mode: "descope"; projectId: string } | null };
let stacksQueryState: {
	data: { stacks: Array<{ orgName: string }> } | undefined;
	isLoading: boolean;
};
let projectsQueryState: {
	data: Array<{ name: string }> | undefined;
	isLoading: boolean;
	error: Error | null;
};
let environmentQueryState: {
	data:
		| {
				id: string;
				name: string;
				yamlBody: string;
				currentRevisionNumber: number;
		  }
		| undefined;
	isLoading: boolean;
	error: Error | null;
	refetch: ReturnType<typeof mock>;
};
let revisionsQueryState: {
	data:
		| Array<{
				id: string;
				revisionNumber: number;
				createdBy: string;
				createdAt: Date;
		  }>
		| undefined;
	refetch: ReturnType<typeof mock>;
};
let revisionQueryState: { data?: { yamlBody: string } };

mock.module(configPath, () => ({ apiBase: "http://localhost:19140" }));

mock.module(useAuthConfigPath, () => ({
	useAuthConfig: () => ({ config: authConfigState.config, isLoading: false }),
}));

mock.module("@descope/react-sdk", () => ({
	getCurrentTenant: getCurrentTenantMock,
}));

mock.module(trpcPath, () => ({
	getAuthHeaders: getAuthHeadersMock,
	trpc: {
		useUtils: () => utilsState,
		stacks: {
			list: {
				useQuery: () => stacksQueryState,
			},
		},
		esc: {
			listProjects: {
				useQuery: () => projectsQueryState,
			},
			getEnvironment: {
				useQuery: () => environmentQueryState,
			},
			listRevisions: {
				useQuery: () => revisionsQueryState,
			},
			getRevision: {
				useQuery: () => revisionQueryState,
			},
		},
	},
}));

const { useOrg } = await import("../hooks/useOrg");
const { EscEnvironmentDetail } = await import("./EscEnvironmentDetail");
const { EscEnvironments } = await import("./EscEnvironments");
const { EscResolvedValues } = await import("../components/EscResolvedValues");
const { EscRevisionDiff } = await import("../components/EscRevisionDiff");
const { EscSessions } = await import("../components/EscSessions");

let dom: Window;

function setMockFetch(fn: FetchFn) {
	globalThis.fetch = Object.assign(fn, {
		preconnect: async () => undefined,
	});
}

function resetQueryState() {
	projectsQueryState = { data: [], isLoading: false, error: null };
	environmentQueryState = {
		data: {
			id: "env-1",
			name: "dev",
			yamlBody: "values:\n  key: original\n",
			currentRevisionNumber: 1,
		},
		isLoading: false,
		error: null,
		refetch: mock(async () => undefined),
	};
	revisionsQueryState = {
		data: [
			{
				id: "rev-1",
				revisionNumber: 1,
				createdBy: "dev-user",
				createdAt: new Date("2026-04-24T00:00:00Z"),
			},
		],
		refetch: mock(async () => undefined),
	};
	revisionQueryState = { data: undefined };
	authConfigState = { config: { mode: "dev" } };
	stacksQueryState = { data: undefined, isLoading: false };
	listEnvironmentsFetchMock.mockReset();
	listEnvironmentsFetchMock.mockImplementation(async () => []);
	getAuthHeadersMock.mockReset();
	getAuthHeadersMock.mockImplementation(() => ({ Authorization: "token devtoken123" }));
	getCurrentTenantMock.mockClear();
	localStorage.removeItem(DESCOPE_SESSION_TOKEN_STORAGE_KEY);
	localStorage.removeItem(DESCOPE_SESSION_CLAIMS_STORAGE_KEY);
}

function renderDetailPage() {
	const router = createMemoryRouter(
		[
			{
				path: "/esc/:project/:envName",
				element: createElement(EscEnvironmentDetail),
			},
		],
		{ initialEntries: ["/esc/acme/dev"] },
	);

	return render(createElement(RouterProvider, { router }));
}

describe("ESC UI coverage", () => {
	beforeEach(() => {
		dom = new Window({ url: "http://localhost/" });
		globalThis.window = dom as unknown as typeof globalThis.window;
		globalThis.document = dom.document as unknown as typeof globalThis.document;
		globalThis.localStorage = dom.localStorage;
		globalThis.navigator = dom.navigator as unknown as Navigator;
		globalThis.HTMLElement = dom.HTMLElement;
		globalThis.Event = dom.Event as unknown as typeof globalThis.Event;
		globalThis.KeyboardEvent = dom.KeyboardEvent as unknown as typeof globalThis.KeyboardEvent;
		globalThis.MouseEvent = dom.MouseEvent as unknown as typeof globalThis.MouseEvent;
		globalThis.confirm = () => true;
		setMockFetch(mock<FetchFn>(async () => new Response("{}", { status: 200 })));
		resetQueryState();
	});

	afterEach(async () => {
		cleanup();
		await dom.happyDOM.close();
	});

	test("useOrg returns dev-org in dev mode without requiring the auth provider", () => {
		const { result } = renderHook(() => useOrg());

		expect(result.current).toEqual({ org: "dev-org", isLoading: false });
	});

	test("useOrg prefers the first stack org in dev mode when one exists", () => {
		stacksQueryState = { data: { stacks: [{ orgName: "acme-org" }] }, isLoading: false };

		const { result } = renderHook(() => useOrg());

		expect(result.current).toEqual({ org: "acme-org", isLoading: false });
	});

	test("useOrg derives the tenant from the Descope session claims in descope mode", () => {
		authConfigState = { config: { mode: "descope", projectId: "proj_123" } };
		// Claims are mirrored to localStorage by the AuthProvider bridge — they stay
		// available even when the session JWT itself lives in an HttpOnly cookie.
		localStorage.setItem(
			DESCOPE_SESSION_CLAIMS_STORAGE_KEY,
			JSON.stringify({ dct: "tenant-from-claims" }),
		);

		const { result } = renderHook(() => useOrg());

		expect(result.current).toEqual({ org: "tenant-from-claims", isLoading: false });
	});

	test("EscEnvironmentDetail renders in dev mode without the auth provider crash", async () => {
		const view = renderDetailPage();

		const textarea = await view.findByRole("textbox");
		expect(view.getByRole("button", { name: "Save" })).toBeDefined();
		expect(view.getByText("rev #1")).toBeDefined();
		expect((textarea as HTMLTextAreaElement).value).toContain("original");
		fireEvent.click(view.getByRole("button", { name: "Resolved Values" }));
		await view.findByRole("button", { name: "Open Session" });
		fireEvent.click(view.getByRole("button", { name: "Sessions" }));
		await view.findByText(/No sessions tracked/);
	});

	test("EscEnvironmentDetail handles loading and query error states", async () => {
		environmentQueryState = {
			data: undefined,
			isLoading: true,
			error: null,
			refetch: mock(async () => undefined),
		};

		let view = renderDetailPage();
		expect(view.container.querySelector(".animate-pulse")).not.toBeNull();
		view.unmount();

		environmentQueryState = {
			data: undefined,
			isLoading: false,
			error: new Error("boom"),
			refetch: mock(async () => undefined),
		};

		view = renderDetailPage();
		await view.findByText("boom");
	});

	test("EscEnvironmentDetail can compare an older revision and return to the latest YAML", async () => {
		environmentQueryState = {
			data: {
				id: "env-1",
				name: "dev",
				yamlBody: "values:\n  key: current\n  extra: new\n",
				currentRevisionNumber: 2,
			},
			isLoading: false,
			error: null,
			refetch: mock(async () => undefined),
		};
		revisionsQueryState = {
			data: [
				{
					id: "rev-2",
					revisionNumber: 2,
					createdBy: "dev-user",
					createdAt: new Date("2026-04-25T00:00:00Z"),
				},
				{
					id: "rev-1",
					revisionNumber: 1,
					createdBy: "dev-user",
					createdAt: new Date("2026-04-24T00:00:00Z"),
				},
			],
			refetch: mock(async () => undefined),
		};
		revisionQueryState = { data: { yamlBody: "values:\n  key: original\n" } };

		const view = renderDetailPage();

		await view.findByText("rev #2");
		fireEvent.click(view.getByRole("button", { name: "Compare" }));
		await view.findByText("Revision #1");
		expect(view.getByText("Current")).toBeDefined();
	});

	test("EscResolvedValues opens a session and reveals a secret after confirmation", async () => {
		const onSessionOpened = mock(() => {});
		const fetchMock = mock<FetchFn>(
			async () =>
				new Response(
					JSON.stringify({
						sessionId: "session-1234",
						values: { greeting: "hello", secret_val: "s3cret" },
						secrets: ["secret_val"],
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		setMockFetch(fetchMock);

		const view = render(
			createElement(
				MemoryRouter,
				undefined,
				createElement(EscResolvedValues, {
					project: "acme",
					environment: "dev",
					onSessionOpened,
				}),
			),
		);

		fireEvent.click(view.getByRole("button", { name: "Open Session" }));

		await view.findByText(/Session/);
		expect(view.getByText("greeting")).toBeDefined();
		expect(view.getByText("••••••••")).toBeDefined();
		expect(onSessionOpened).toHaveBeenCalledWith("session-1234", expect.any(String));

		fireEvent.click(view.getByRole("button", { name: "Reveal" }));
		await view.findByText(/Reveal secret/);
		fireEvent.click(view.getByRole("button", { name: "Confirm" }));

		await view.findByText('"s3cret"');
	});

	test("EscResolvedValues surfaces diagnostics and generic fetch failures", async () => {
		const diagnosticFetch = mock<FetchFn>(
			async () =>
				new Response(
					JSON.stringify({
						diagnostics: [{ severity: "error", summary: "bad yaml", path: ["values"] }],
					}),
					{ status: 422, headers: { "Content-Type": "application/json" } },
				),
		);
		setMockFetch(diagnosticFetch);

		let view = render(
			createElement(
				MemoryRouter,
				undefined,
				createElement(EscResolvedValues, {
					project: "acme",
					environment: "dev",
				}),
			),
		);

		fireEvent.click(view.getByRole("button", { name: "Open Session" }));
		await view.findByText("Evaluation failed");
		view.unmount();

		const failureFetch = mock<FetchFn>(async () => new Response("oops", { status: 500 }));
		setMockFetch(failureFetch);
		view = render(
			createElement(
				MemoryRouter,
				undefined,
				createElement(EscResolvedValues, {
					project: "acme",
					environment: "dev",
				}),
			),
		);

		fireEvent.click(view.getByRole("button", { name: "Open Session" }));
		await view.findByText("Failed to open session (500)");
	});

	test("EscResolvedValues Copy button surfaces failure when clipboard rejects", async () => {
		const fetchMock = mock<FetchFn>(
			async () =>
				new Response(
					JSON.stringify({
						sessionId: "session-clip",
						values: { secret_val: "s3cret" },
						secrets: ["secret_val"],
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		setMockFetch(fetchMock);

		const writeTextMock = mock<(value: string) => Promise<void>>(async () => {
			throw new Error("clipboard blocked: insecure context");
		});
		Object.defineProperty(globalThis.navigator, "clipboard", {
			configurable: true,
			value: { writeText: writeTextMock },
		});

		const view = render(
			createElement(
				MemoryRouter,
				undefined,
				createElement(EscResolvedValues, { project: "acme", environment: "dev" }),
			),
		);

		fireEvent.click(view.getByRole("button", { name: "Open Session" }));
		await view.findByText(/Session/);
		fireEvent.click(view.getByRole("button", { name: "Reveal" }));
		fireEvent.click(view.getByRole("button", { name: "Confirm" }));
		await view.findByText('"s3cret"');

		fireEvent.click(view.getByRole("button", { name: "Copy" }));
		await view.findByText("Copy failed");
		expect(writeTextMock).toHaveBeenCalledWith("s3cret");
	});

	test("EscSessions loads tracked sessions, fetches one, and clears it", async () => {
		localStorage.setItem(
			"esc-sessions-env-1",
			JSON.stringify([
				{ sessionId: "session-1234", expiresAt: new Date(Date.now() + 60_000).toISOString() },
			]),
		);

		const fetchMock = mock<FetchFn>(
			async () =>
				new Response(
					JSON.stringify({
						sessionId: "session-1234",
						values: { greeting: "hello" },
						expiresAt: new Date(Date.now() + 60_000).toISOString(),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		);
		setMockFetch(fetchMock);

		const view = render(
			createElement(
				MemoryRouter,
				undefined,
				createElement(EscSessions, {
					project: "acme",
					environment: "dev",
					envId: "env-1",
				}),
			),
		);

		await view.findByRole("button", { name: "Fetch" });
		fireEvent.click(view.getByRole("button", { name: "Fetch" }));
		await view.findByText(/greeting/);
		expect(fetchMock).toHaveBeenCalled();

		fireEvent.click(view.getByRole("button", { name: "Clear" }));
		await view.findByText(/No sessions tracked/);
	});

	test("EscSessions prunes expired sessions on mount and surfaces fetch errors for active ones", async () => {
		// SessionIDs are truncated to 8 chars in the UI; use prefixes that survive that.
		localStorage.setItem(
			"esc-sessions-env-1",
			JSON.stringify([
				{ sessionId: "expired1-rest", expiresAt: new Date(Date.now() - 60_000).toISOString() },
				{ sessionId: "actives1-rest", expiresAt: new Date(Date.now() + 60_000).toISOString() },
			]),
		);
		const fetchMock = mock<FetchFn>(async () => new Response("nope", { status: 500 }));
		setMockFetch(fetchMock);

		const view = render(
			createElement(
				MemoryRouter,
				undefined,
				createElement(EscSessions, {
					project: "acme",
					environment: "dev",
					envId: "env-1",
				}),
			),
		);

		// Expired session pruned on mount: only the active one renders.
		await view.findByText(/actives1/);
		expect(view.queryByText(/expired1/)).toBeNull();

		// localStorage was rewritten to match: expired entry removed.
		const stored = JSON.parse(localStorage.getItem("esc-sessions-env-1") ?? "[]");
		expect(stored).toHaveLength(1);
		expect(stored[0].sessionId).toBe("actives1-rest");

		// Clear removes the remaining row → empty state.
		fireEvent.click(view.getByRole("button", { name: "Clear" }));
		await view.findByText(/No sessions tracked/);
	});

	test("EscRevisionDiff renders stats and supports no-diff state", async () => {
		const onClose = mock(() => {});
		const view = render(
			createElement(EscRevisionDiff, {
				leftYaml: "values:\n  key: old\n",
				rightYaml: "values:\n  key: new\n  extra: added\n",
				leftLabel: "Revision #1",
				rightLabel: "Current",
				onClose,
			}),
		);

		expect(view.getByText("Revision #1")).toBeDefined();
		expect(view.getByText("Current")).toBeDefined();
		expect(view.getByText(/\+2/)).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: /Close/ }));
		expect(onClose).toHaveBeenCalled();

		view.rerender(
			createElement(EscRevisionDiff, {
				leftYaml: "same\n",
				rightYaml: "same\n",
				leftLabel: "Revision #2",
				rightLabel: "Current",
				onClose,
			}),
		);

		await view.findByText("No differences between these revisions.");
	});

	test("EscEnvironments shows rows after project environments are fetched", async () => {
		projectsQueryState = { data: [{ name: "acme" }], isLoading: false, error: null };
		listEnvironmentsFetchMock.mockImplementation(async () => [
			{
				name: "dev",
				currentRevisionNumber: 2,
				updatedAt: new Date("2026-04-24T00:00:00Z"),
				createdBy: "owner@example.com",
			},
			{
				name: "prod",
				currentRevisionNumber: 3,
				updatedAt: new Date("2026-04-24T00:00:00Z"),
				createdBy: "owner@example.com",
			},
		]);

		const view = render(createElement(MemoryRouter, undefined, createElement(EscEnvironments)));

		await view.findByText("dev");
		expect(view.getByText("prod")).toBeDefined();
		expect(view.getByPlaceholderText("Search environments...")).toBeDefined();
		expect(view.getAllByText("owner@example.com")).toHaveLength(2);
		expect(view.queryByText(/^K[0-9A-Za-z]+$/)).toBeNull();
	});

	test("EscEnvironments renders loading, empty, and error states", async () => {
		projectsQueryState = { data: undefined, isLoading: true, error: null };
		let view = render(createElement(MemoryRouter, undefined, createElement(EscEnvironments)));
		expect(view.container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
		view.unmount();

		projectsQueryState = { data: [], isLoading: false, error: null };
		view = render(createElement(MemoryRouter, undefined, createElement(EscEnvironments)));
		await view.findByText("No environments yet");
		view.unmount();

		projectsQueryState = { data: [], isLoading: false, error: new Error("esc boom") };
		view = render(createElement(MemoryRouter, undefined, createElement(EscEnvironments)));
		await view.findByText("esc boom");
	});
});
