import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { lazy, Suspense, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import "./index.css";

import { ProcellaAuthProvider } from "./components/AuthProvider";
import { FullPageSpinner } from "./components/FullPageSpinner";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { HomePage } from "./pages/HomePage";
import { StackList } from "./pages/StackList";
import { createTRPCClient, trpc } from "./trpc";

// Route-level code splitting: keep StackList + HomePage eager (most-trafficked
// initial routes), lazy-load everything else so the main bundle stays under
// Vite's 500 kB warning threshold.
const LoginPage = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const CliLogin = lazy(() => import("./pages/CliLogin").then((m) => ({ default: m.CliLogin })));
const WelcomeCli = lazy(() =>
	import("./pages/WelcomeCli").then((m) => ({ default: m.WelcomeCli })),
);
const Design = lazy(() => import("./pages/Design").then((m) => ({ default: m.Design })));
const StackDetail = lazy(() =>
	import("./pages/StackDetail").then((m) => ({ default: m.StackDetail })),
);
const ResourceDetail = lazy(() =>
	import("./pages/ResourceDetail").then((m) => ({ default: m.ResourceDetail })),
);
const UpdateDetail = lazy(() =>
	import("./pages/UpdateDetail").then((m) => ({ default: m.UpdateDetail })),
);
const Settings = lazy(() => import("./pages/Settings").then((m) => ({ default: m.Settings })));
const Tokens = lazy(() => import("./pages/Tokens").then((m) => ({ default: m.Tokens })));
const Webhooks = lazy(() => import("./pages/Webhooks").then((m) => ({ default: m.Webhooks })));
const EscEnvironments = lazy(() =>
	import("./pages/EscEnvironments").then((m) => ({ default: m.EscEnvironments })),
);
const EscEnvironmentDetail = lazy(() =>
	import("./pages/EscEnvironmentDetail").then((m) => ({ default: m.EscEnvironmentDetail })),
);

const SpinnerFallback = <FullPageSpinner />;

function handleGlobalError(error: unknown) {
	if (
		error instanceof TRPCClientError &&
		error.data?.httpStatus === 401 &&
		window.location.pathname !== "/login"
	) {
		window.location.href = "/login";
	}
}

function TRPCProvider({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						staleTime: 30_000,
						gcTime: 5 * 60_000,
						retry: false,
						refetchOnWindowFocus: false,
					},
					mutations: {
						onError: handleGlobalError,
					},
				},
				queryCache: new QueryCache({
					onError: handleGlobalError,
				}),
			}),
	);

	const trpcClient = useMemo(createTRPCClient, []);

	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</trpc.Provider>
	);
}

function App() {
	const router = useMemo(
		() =>
			createBrowserRouter([
				{
					path: "/login",
					element: (
						<Suspense fallback={SpinnerFallback}>
							<LoginPage />
						</Suspense>
					),
				},
				{
					path: "/cli-login",
					element: (
						<Suspense fallback={SpinnerFallback}>
							<CliLogin />
						</Suspense>
					),
				},
				{ path: "/account/tokens", element: <Navigate to="/tokens" replace /> },
				{
					path: "/welcome/cli",
					element: (
						<Suspense fallback={SpinnerFallback}>
							<WelcomeCli />
						</Suspense>
					),
				},
				{
					path: "/design",
					element: (
						<Suspense fallback={SpinnerFallback}>
							<Design />
						</Suspense>
					),
				},
				{ path: "/", element: <HomePage /> },
				{
					element: <ProtectedRoute />,
					children: [
						{
							element: <Layout />,
							children: [
								{ path: "home", element: <StackList /> },
								{ path: "tokens", element: <Tokens /> },
								{ path: "settings", element: <Settings /> },
								{ path: "webhooks", element: <Webhooks /> },
								{ path: "esc", element: <EscEnvironments /> },
								{ path: "esc/:project/:envName", element: <EscEnvironmentDetail /> },
								{ path: "stacks/:org/:project/:stack", element: <StackDetail /> },
								{
									path: "stacks/:org/:project/:stack/resources",
									element: <ResourceDetail />,
								},
								{
									path: "stacks/:org/:project/:stack/updates/:updateID",
									element: <UpdateDetail />,
								},
								{
									path: "stacks/:org/:project/:stack/previews/:updateID",
									element: <UpdateDetail />,
								},
								{ path: ":org/:project/:stack", element: <StackDetail /> },
								{ path: ":org/:project/:stack/resources", element: <ResourceDetail /> },
								{ path: ":org/:project/:stack/updates/:updateID", element: <UpdateDetail /> },
								{ path: ":org/:project/:stack/previews/:updateID", element: <UpdateDetail /> },
								{ path: ":org/:project/:stack/settings/options", element: <StackDetail /> },
							],
						},
					],
				},
			]),
		[],
	);

	return (
		<TRPCProvider>
			<ProcellaAuthProvider>
				<RouterProvider router={router} />
			</ProcellaAuthProvider>
		</TRPCProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<App />);
}
