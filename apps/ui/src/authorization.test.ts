import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { createElement } from "react";
import { MemoryRouter } from "react-router";

const commandBarPath = resolve(import.meta.dir, "./components/CommandBar.tsx");
const trpcPath = resolve(import.meta.dir, "./trpc.ts");
const useAuthConfigPath = resolve(import.meta.dir, "./hooks/useAuthConfig.ts");

let currentCallerQuery: {
	data?: { tenantId: string; roles: string[] };
	isLoading: boolean;
	error: Error | null;
};
let sessionState: {
	sessionToken: string;
	claims: Record<string, unknown> | null;
	isAuthenticated: boolean;
};

mock.module(useAuthConfigPath, () => ({
	useAuthConfig: () => ({
		config: { mode: "descope", projectId: "project-1" },
		isLoading: false,
	}),
}));

mock.module(trpcPath, () => ({
	trpc: {
		auth: {
			current: {
				useQuery: () => currentCallerQuery,
			},
		},
	},
}));

mock.module(commandBarPath, () => ({
	CommandBar: () => null,
	openCommandBar: () => {},
}));

mock.module("@descope/react-sdk", () => ({
	AuditManagement: () => null,
	AuthProvider: ({ children }: { children: ReactNode }) => children,
	RoleManagement: () => null,
	TenantProfile: () => null,
	UserManagement: ({ tenant }: { tenant: string }) =>
		createElement("div", { "data-testid": "user-management" }, tenant),
	useDescope: () => ({ logout: async () => {} }),
	useSession: () => sessionState,
	useUser: () => ({ user: { name: "Admin User", email: "admin@example.com" } }),
}));

// Mock registration must precede application module evaluation in Bun tests.
const { Layout } = await import("./components/Layout");
const { Settings } = await import("./pages/Settings");
const { ProcellaAuthProvider } = await import("./components/AuthProvider");
let dom: Window;

beforeEach(() => {
	dom = new Window({ url: "http://localhost/" });
	globalThis.window = dom as unknown as typeof globalThis.window;
	globalThis.document = dom.document as unknown as typeof globalThis.document;
	globalThis.localStorage = dom.localStorage;
	globalThis.HTMLElement = dom.HTMLElement;
	globalThis.Event = dom.Event as unknown as typeof globalThis.Event;
	globalThis.MouseEvent = dom.MouseEvent as unknown as typeof globalThis.MouseEvent;
	currentCallerQuery = { data: undefined, isLoading: false, error: null };
	sessionState = {
		sessionToken: "",
		claims: { sub: "user-1", dct: "tenant-1" },
		isAuthenticated: true,
	};
});

afterEach(async () => {
	cleanup();
	await dom.happyDOM.close();
});

describe("session authorization cache", () => {
	test("resets cached server data when Descope session claims change", async () => {
		const queryClient = new QueryClient();
		const resetQueries = mock(async () => undefined);
		queryClient.resetQueries = resetQueries as typeof queryClient.resetQueries;
		const page = render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(ProcellaAuthProvider, null, createElement("div")),
			),
		);
		expect(resetQueries).toHaveBeenCalledTimes(0);

		sessionState = {
			...sessionState,
			claims: { sub: "user-2", dct: "tenant-1" },
		};
		page.rerender(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(ProcellaAuthProvider, null, createElement("div")),
			),
		);

		await waitFor(() => expect(resetQueries).toHaveBeenCalledTimes(1));
	});
});

describe("Layout authorization", () => {
	test("shows Settings for an admin returned by the server", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(MemoryRouter, null, createElement(Layout)));

		expect(page.getAllByText("Settings")).not.toHaveLength(0);
	});

	test("hides Settings for a non-admin returned by the server", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["member"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(MemoryRouter, null, createElement(Layout)));

		expect(page.queryByText("Settings")).toBeNull();
	});
});

describe("Settings authorization", () => {
	test("renders admin settings from the server-authenticated caller", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin", "member"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(Settings));

		expect(page.getByText("OIDC")).toBeTruthy();
		expect(page.getByTestId("user-management").textContent).toBe("tenant-from-server");
	});

	test("keeps non-admin callers out of settings", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["member"] },
			isLoading: false,
			error: null,
		};

		const page = render(createElement(Settings));

		expect(page.getByText("Admin access required")).toBeTruthy();
	});
});
