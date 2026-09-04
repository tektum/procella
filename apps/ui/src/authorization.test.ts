import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
let githubStatusQuery: {
	data?: {
		configured: boolean;
		installations: Array<{
			id: string;
			tenantId: string;
			installationId: number;
			accountLogin: string;
			accountType: "Organization" | "User";
			repositorySelection: "all" | "selected";
			createdAt: Date;
			updatedAt: Date;
		}>;
	};
	isLoading: boolean;
	error: Error | null;
};
const createInstallationUrl = mock(async () => ({ url: "http://localhost/github-install" }));
const removeInstallation = mock(async () => ({ success: true }));

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
		github: {
			status: { useQuery: () => ({ ...githubStatusQuery, refetch: mock(async () => {}) }) },
			createInstallationUrl: {
				useMutation: () => ({ mutateAsync: createInstallationUrl, isPending: false }),
			},
			removeInstallation: {
				useMutation: () => ({ mutateAsync: removeInstallation, isPending: false }),
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
	githubStatusQuery = {
		data: { configured: false, installations: [] },
		isLoading: false,
		error: null,
	};
	createInstallationUrl.mockClear();
	removeInstallation.mockClear();
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

	test("distinguishes server configuration from an uninstalled tenant", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		dom.location.hash = "github";

		let page = render(createElement(Settings));
		expect(page.getByText("GitHub App is not configured")).toBeTruthy();
		page.unmount();

		githubStatusQuery = {
			data: { configured: true, installations: [] },
			isLoading: false,
			error: null,
		};
		page = render(createElement(Settings));
		expect(page.getByText("GitHub App is not installed")).toBeTruthy();
		expect(page.getByRole("button", { name: "Connect GitHub App" })).toBeTruthy();
	});

	test("shows callback success and configured installation actions", async () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: {
				configured: true,
				installations: [
					{
						id: "row-1",
						tenantId: "tenant-from-server",
						installationId: 101,
						accountLogin: "acme",
						accountType: "Organization",
						repositorySelection: "selected",
						createdAt: new Date("2026-09-04T00:00:00Z"),
						updatedAt: new Date("2026-09-04T00:00:00Z"),
					},
				],
			},
			isLoading: false,
			error: null,
		};
		dom.location.href = "http://localhost/settings?github=connected#github";

		const page = render(createElement(Settings));
		expect(page.getByText("GitHub App installation connected successfully.")).toBeTruthy();
		expect(page.getByText("Selected repositories")).toBeTruthy();
		fireEvent.click(page.getByRole("button", { name: "Connect or Configure" }));
		await waitFor(() => expect(createInstallationUrl).toHaveBeenCalledTimes(1));
	});

	test("shows an expired callback state error", () => {
		currentCallerQuery = {
			data: { tenantId: "tenant-from-server", roles: ["admin"] },
			isLoading: false,
			error: null,
		};
		githubStatusQuery = {
			data: { configured: true, installations: [] },
			isLoading: false,
			error: null,
		};
		dom.location.href = "http://localhost/settings?github=error&reason=expired_state#github";

		const page = render(createElement(Settings));
		expect(
			page.getByText("The GitHub setup link expired. Start the connection again."),
		).toBeTruthy();
	});
});
