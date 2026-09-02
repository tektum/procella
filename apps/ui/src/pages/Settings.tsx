import { AuditManagement, RoleManagement, TenantProfile, UserManagement } from "@descope/react-sdk";
import { useEffect, useState } from "react";
import { useAuthConfig } from "../hooks/useAuthConfig";
import { trpc } from "../trpc";

type SettingsTab = "users" | "roles" | "audit" | "tenant" | "github" | "oidc";

function getTab(): SettingsTab {
	const hash = window.location.hash.slice(1);
	if (
		hash === "roles" ||
		hash === "audit" ||
		hash === "tenant" ||
		hash === "github" ||
		hash === "oidc"
	)
		return hash;
	return "users";
}

export function Settings() {
	const { config } = useAuthConfig();
	const {
		data: caller,
		isLoading: isCallerLoading,
		error: callerError,
	} = trpc.auth.current.useQuery(undefined, { enabled: config?.mode === "descope" });
	const [tab, setTab] = useState<SettingsTab>(getTab);

	useEffect(() => {
		const onHashChange = () => setTab(getTab());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	if (config?.mode !== "descope") return null;

	const tenantId = caller?.tenantId ?? "";
	const isAdmin = caller?.roles.includes("admin") ?? false;

	const selectTab = (t: SettingsTab) => {
		window.location.hash = t;
		setTab(t);
	};

	if (isCallerLoading) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-cloud">Loading session…</p>
				</div>
			</div>
		);
	}

	if (callerError || !caller) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-mist/80 font-medium">Unable to verify access</p>
					<p className="text-cloud text-sm mt-1">Refresh the page and sign in again.</p>
				</div>
			</div>
		);
	}

	if (!isAdmin) {
		return (
			<div className="space-y-6">
				<h1 className="text-2xl font-bold text-mist">Settings</h1>
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-12 text-center">
					<p className="text-mist/80 font-medium">Admin access required</p>
					<p className="text-cloud text-sm mt-1">
						Your account does not have the admin role for this organization.
					</p>
				</div>
			</div>
		);
	}

	const tabs: { id: SettingsTab; label: string }[] = [
		{ id: "users", label: "Users" },
		{ id: "roles", label: "Roles" },
		{ id: "audit", label: "Audit Log" },
		{ id: "tenant", label: "Tenant" },
		{ id: "github", label: "GitHub" },
		{ id: "oidc", label: "OIDC" },
	];

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold text-mist">Settings</h1>

			<div className="border-b border-slate-brand">
				<nav className="flex gap-1" aria-label="Settings tabs">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							onClick={() => selectTab(t.id)}
							className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
								tab === t.id
									? "border-lightning text-mist"
									: "border-transparent text-cloud hover:text-mist hover:border-cloud/30"
							}`}
						>
							{t.label}
						</button>
					))}
				</nav>
			</div>

			<div>
				{tab === "users" && (
					<UserManagement widgetId="user-management-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "roles" && (
					<RoleManagement widgetId="role-management-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "audit" && (
					<AuditManagement widgetId="audit-management-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "tenant" && (
					<TenantProfile widgetId="tenant-profile-widget" tenant={tenantId} theme="dark" />
				)}
				{tab === "github" && <GitHubSettingsTab />}
				{tab === "oidc" && <OidcSettingsTab />}
			</div>
		</div>
	);
}

function GitHubSettingsTab() {
	const {
		data: installation,
		isLoading,
		error: queryError,
		refetch,
	} = trpc.github.installation.useQuery();
	const error = queryError?.message ?? null;

	const removeMutation = trpc.github.removeInstallation.useMutation();
	const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

	if (isLoading) {
		return (
			<div className="animate-pulse space-y-3">
				<div className="h-32 bg-slate-brand/30 rounded-xl border border-slate-brand/60" />
			</div>
		);
	}

	if (!error && installation === null) {
		return <GitHubNotConfigured onCheckConnection={refetch} />;
	}

	if (error) {
		// If the error indicates GitHub is not configured on the server
		return <GitHubNotConfigured onCheckConnection={refetch} />;
	}

	if (!installation) {
		return <GitHubNotConnected onCheckConnection={refetch} />;
	}

	const handleDisconnect = async () => {
		try {
			await removeMutation.mutateAsync();
			setShowDisconnectConfirm(false);
			refetch();
		} catch {
			// Error handled by tRPC
		}
	};

	return (
		<>
			<div className="bg-slate-brand/50 border border-cloud/15 rounded-xl p-6">
				<div className="flex items-start justify-between">
					<div className="flex items-start gap-4">
						<div className="w-10 h-10 rounded-lg bg-slate-brand border border-cloud/20 flex items-center justify-center shrink-0">
							<svg
								viewBox="0 0 24 24"
								fill="currentColor"
								className="w-6 h-6 text-mist/80"
								aria-hidden="true"
							>
								<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
							</svg>
						</div>
						<div>
							<h3 className="text-sm font-semibold text-mist mb-1">GitHub App Connected</h3>
							<div className="space-y-1">
								<p className="text-sm text-cloud">
									<span className="text-cloud/60">Account:</span>{" "}
									<span className="text-mist/90 font-medium">{installation.accountLogin}</span>
								</p>
								<p className="text-sm text-cloud">
									<span className="text-cloud/60">Type:</span> {installation.accountType}
								</p>
								<p className="text-sm text-cloud">
									<span className="text-cloud/60">Installation ID:</span>{" "}
									<span className="tabular-nums">{installation.installationId}</span>
								</p>
								<p className="text-sm text-cloud">
									<span className="text-cloud/60">Repositories:</span>{" "}
									{installation.repositorySelection === "all"
										? "All repositories"
										: "Selected repositories"}
								</p>
								<p className="text-sm text-cloud">
									<span className="text-cloud/60">Connected:</span>{" "}
									{new Date(installation.createdAt).toLocaleDateString()}
								</p>
							</div>
						</div>
					</div>
					<button
						type="button"
						onClick={() => setShowDisconnectConfirm(true)}
						className="bg-danger/15 hover:bg-danger/25 text-danger/80 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border border-danger/30"
					>
						Disconnect
					</button>
				</div>
			</div>

			{showDisconnectConfirm && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
					<div className="bg-surface-popup border border-cloud/20 rounded-xl p-6 w-full max-w-sm mx-4">
						<h3 className="text-lg font-semibold text-mist mb-2">Disconnect GitHub App</h3>
						<p className="text-sm text-cloud mb-4">
							Are you sure you want to disconnect the GitHub App? PR comments and commit statuses
							will stop working.
						</p>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setShowDisconnectConfirm(false)}
								className="btn-ghost"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleDisconnect}
								disabled={removeMutation.isPending}
								className="btn-danger"
							>
								{removeMutation.isPending ? "Disconnecting..." : "Disconnect"}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
}

function GitHubNotConfigured({ onCheckConnection }: { onCheckConnection: () => void }) {
	return (
		<div className="bg-slate-brand/30 border border-slate-brand/60 rounded-xl p-8">
			<div className="flex items-start gap-4">
				<div className="w-10 h-10 rounded-lg bg-slate-brand border border-cloud/20 flex items-center justify-center shrink-0 opacity-50">
					<svg
						viewBox="0 0 24 24"
						fill="currentColor"
						className="w-6 h-6 text-cloud/60"
						aria-hidden="true"
					>
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
				</div>
				<div>
					<h3 className="text-sm font-semibold text-cloud mb-1.5">
						GitHub App Not Configured or Not Installed
					</h3>
					<p className="text-sm text-cloud/60 leading-relaxed mb-4">
						Procella cannot yet distinguish between missing server configuration and a missing
						organization installation. Verify environment variables and app installation:
					</p>
					<div className="bg-deep-sky border border-cloud/15 rounded-lg px-3 py-2.5 font-mono text-xs text-cloud overflow-x-auto whitespace-pre leading-relaxed mb-4">
						{`PROCELLA_GITHUB_APP_ID=<your-app-id>
PROCELLA_GITHUB_APP_PRIVATE_KEY=<your-private-key>
PROCELLA_GITHUB_APP_WEBHOOK_SECRET=<your-webhook-secret>`}
					</div>
					<button type="button" onClick={onCheckConnection} className="btn-secondary">
						Check Connection
					</button>
				</div>
			</div>
		</div>
	);
}

function GitHubNotConnected({ onCheckConnection }: { onCheckConnection: () => void }) {
	return (
		<div className="bg-slate-brand/30 border border-slate-brand/60 rounded-xl p-8">
			<div className="flex items-start gap-4">
				<div className="w-10 h-10 rounded-lg bg-lightning/10 border border-lightning/20 flex items-center justify-center shrink-0">
					<svg
						viewBox="0 0 24 24"
						fill="currentColor"
						className="w-6 h-6 text-lightning"
						aria-hidden="true"
					>
						<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
					</svg>
				</div>
				<div>
					<h3 className="text-sm font-semibold text-mist mb-1.5">Connect GitHub App</h3>
					<p className="text-sm text-cloud leading-relaxed mb-5">
						Connect a GitHub App to enable PR comments and commit status checks for Pulumi previews.
					</p>

					<div className="space-y-3 mb-5">
						<div className="flex items-start gap-3">
							<span className="w-5 h-5 rounded-full bg-slate-brand border border-cloud/20 flex items-center justify-center text-[10px] font-semibold text-cloud shrink-0 mt-0.5">
								1
							</span>
							<div>
								<p className="text-xs text-cloud/60 mb-0.5">Create a GitHub App</p>
								<a
									href="https://github.com/settings/apps/new"
									target="_blank"
									rel="noopener noreferrer"
									className="text-xs text-lightning hover:text-lightning/80 transition-colors"
								>
									GitHub Settings → Developer settings → GitHub Apps →
								</a>
							</div>
						</div>
						<div className="flex items-start gap-3">
							<span className="w-5 h-5 rounded-full bg-slate-brand border border-cloud/20 flex items-center justify-center text-[10px] font-semibold text-cloud shrink-0 mt-0.5">
								2
							</span>
							<p className="text-xs text-cloud/60">
								Set PROCELLA_GITHUB_APP_ID, PROCELLA_GITHUB_APP_PRIVATE_KEY, and
								PROCELLA_GITHUB_APP_WEBHOOK_SECRET environment variables
							</p>
						</div>
						<div className="flex items-start gap-3">
							<span className="w-5 h-5 rounded-full bg-slate-brand border border-cloud/20 flex items-center justify-center text-[10px] font-semibold text-cloud shrink-0 mt-0.5">
								3
							</span>
							<p className="text-xs text-cloud/60">Install the GitHub App on your organization</p>
						</div>
					</div>

					<button type="button" onClick={onCheckConnection} className="btn-primary">
						Check Connection
					</button>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// OIDC Settings Tab
// ============================================================================

function OidcSettingsTab() {
	const [showCreate, setShowCreate] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [displayName, setDisplayName] = useState("");
	const [issuer, setIssuer] = useState("https://token.actions.githubusercontent.com");
	const [maxExpiration, setMaxExpiration] = useState("7200");
	const [grantedRole, setGrantedRole] = useState<"viewer" | "member" | "admin">("member");
	const [conditionKey, setConditionKey] = useState("");
	const [conditionValue, setConditionValue] = useState("");
	const [conditions, setConditions] = useState<Record<string, string>>({});

	const {
		data: policies,
		isLoading,
		error: queryError,
		refetch,
	} = trpc.oidc.listPolicies.useQuery();

	const createMutation = trpc.oidc.createPolicy.useMutation();
	const deleteMutation = trpc.oidc.deletePolicy.useMutation();
	const toggleMutation = trpc.oidc.updatePolicy.useMutation();

	const resetForm = () => {
		setDisplayName("");
		setIssuer("https://token.actions.githubusercontent.com");
		setMaxExpiration("7200");
		setGrantedRole("member");
		setConditions({});
		setConditionKey("");
		setConditionValue("");
		setFormError(null);
	};

	const handleCreate = async () => {
		if (!displayName.trim()) {
			setFormError("Display name is required");
			return;
		}
		if (!issuer.trim()) {
			setFormError("Issuer URL is required");
			return;
		}
		const exp = Number(maxExpiration);
		if (!Number.isInteger(exp) || exp < 60 || exp > 86400) {
			setFormError("Expiration must be between 60 and 86400 seconds");
			return;
		}
		if (Object.keys(conditions).length === 0) {
			setFormError("At least one claim condition is required");
			return;
		}
		try {
			await createMutation.mutateAsync({
				provider: "github-actions",
				displayName: displayName.trim(),
				issuer: issuer.trim(),
				maxExpiration: exp,
				claimConditions: conditions,
				grantedRole,
			});
			resetForm();
			setShowCreate(false);
			refetch();
		} catch (err: unknown) {
			setFormError(err instanceof Error ? err.message : "Failed to create policy");
		}
	};

	const addCondition = () => {
		if (!conditionKey.trim() || !conditionValue.trim()) return;
		setConditions((prev) => ({ ...prev, [conditionKey.trim()]: conditionValue.trim() }));
		setConditionKey("");
		setConditionValue("");
	};

	const removeCondition = (key: string) => {
		setConditions((prev) => {
			const n = { ...prev };
			delete n[key];
			return n;
		});
	};

	if (isLoading) {
		return (
			<div className="animate-pulse h-32 bg-slate-brand/30 rounded-xl border border-slate-brand/60 mt-4" />
		);
	}

	if (queryError) {
		if (queryError.message.includes("OIDC is not enabled")) {
			return (
				<div className="mt-6 bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
					<p className="text-mist font-medium">OIDC CI Authentication</p>
					<p className="text-cloud text-sm mt-2">
						Set <code className="font-mono text-lightning">PROCELLA_OIDC_ENABLED=true</code> to
						enable OIDC trust policy management.
					</p>
				</div>
			);
		}
		return (
			<div className="mt-4 bg-danger/10 border border-danger/30 text-danger/80 p-4 rounded-xl text-sm">
				{queryError.message}
			</div>
		);
	}

	return (
		<div className="mt-6 space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="text-base font-semibold text-mist">OIDC Trust Policies</h2>
					<p className="text-sm text-cloud mt-0.5">
						Allow CI pipelines to authenticate using OpenID Connect tokens.
					</p>
				</div>
				<button
					type="button"
					onClick={() => {
						resetForm();
						setShowCreate(true);
					}}
					className="btn-primary"
				>
					Add Policy
				</button>
			</div>

			{showCreate && (
				<div className="bg-surface-popup border border-cloud/15 rounded-xl p-5 space-y-4">
					<h3 className="text-sm font-semibold text-mist">New Trust Policy</h3>
					{formError && (
						<div className="bg-danger/10 border border-danger/30 text-danger/80 p-3 rounded-lg text-sm">
							{formError}
						</div>
					)}
					<div className="grid grid-cols-2 gap-4">
						<div>
							<label htmlFor="oidc-display-name" className="block text-xs text-cloud mb-1">
								Display Name
							</label>
							<input
								id="oidc-display-name"
								type="text"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="CI Deploy Policy"
								className="w-full input-field"
							/>
						</div>
						<div>
							<label htmlFor="oidc-role" className="block text-xs text-cloud mb-1">
								Granted Role
							</label>
							<select
								id="oidc-role"
								value={grantedRole}
								onChange={(e) => setGrantedRole(e.target.value as "viewer" | "member" | "admin")}
								className="w-full input-field"
							>
								<option value="viewer">viewer</option>
								<option value="member">member</option>
								<option value="admin">admin</option>
							</select>
						</div>
					</div>
					<div>
						<label htmlFor="oidc-issuer" className="block text-xs text-cloud mb-1">
							OIDC Issuer URL
						</label>
						<input
							id="oidc-issuer"
							type="url"
							value={issuer}
							onChange={(e) => setIssuer(e.target.value)}
							className="w-full input-field"
						/>
					</div>
					<div>
						<label htmlFor="oidc-expiry" className="block text-xs text-cloud mb-1">
							Max Token Expiration (seconds)
						</label>
						<input
							id="oidc-expiry"
							type="number"
							value={maxExpiration}
							onChange={(e) => setMaxExpiration(e.target.value)}
							min={60}
							max={86400}
							className="w-full input-field"
						/>
					</div>
					<div>
						<p className="block text-xs text-cloud mb-1">
							Claim Conditions (AND semantics, exact match)
						</p>
						<div className="flex gap-2 mb-2">
							<input
								type="text"
								value={conditionKey}
								onChange={(e) => setConditionKey(e.target.value)}
								placeholder="repository_owner_id"
								onKeyDown={(e) => e.key === "Enter" && addCondition()}
								className="flex-1 input-field"
							/>
							<input
								type="text"
								value={conditionValue}
								onChange={(e) => setConditionValue(e.target.value)}
								placeholder="12345"
								onKeyDown={(e) => e.key === "Enter" && addCondition()}
								className="flex-1 input-field"
							/>
							<button type="button" onClick={addCondition} className="btn-secondary">
								Add
							</button>
						</div>
						{Object.entries(conditions).map(([k, v]) => (
							<div
								key={k}
								className="flex items-center gap-2 text-xs font-mono text-mist/80 bg-slate-brand/50 rounded px-2 py-1 mb-1"
							>
								<span className="flex-1">
									{k} = {v}
								</span>
								<button
									type="button"
									onClick={() => removeCondition(k)}
									className="text-cloud/60 hover:text-danger/80 transition-colors"
								>
									×
								</button>
							</div>
						))}
					</div>
					<div className="flex justify-end gap-3">
						<button
							type="button"
							onClick={() => {
								resetForm();
								setShowCreate(false);
							}}
							className="btn-ghost"
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleCreate}
							disabled={createMutation.isPending}
							className="btn-primary"
						>
							{createMutation.isPending ? "Creating…" : "Create Policy"}
						</button>
					</div>
				</div>
			)}

			{policies && policies.length === 0 && !showCreate && (
				<div className="bg-slate-brand/50 border border-cloud/20 rounded-lg p-8 text-center">
					<p className="text-cloud text-sm">
						No trust policies configured. Add one to enable OIDC CI authentication.
					</p>
				</div>
			)}

			{policies && policies.length > 0 && (
				<div className="space-y-2">
					{policies.map((policy) => (
						<div key={policy.id} className="bg-surface-popup border border-cloud/15 rounded-xl p-4">
							<div className="flex items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-mist">{policy.displayName}</span>
										<span
											className={`text-xs px-1.5 py-0.5 rounded font-mono ${policy.active ? "bg-success/10 text-success/80" : "bg-slate-brand text-cloud/60"}`}
										>
											{policy.active ? "active" : "inactive"}
										</span>
										<span className="text-xs px-1.5 py-0.5 rounded bg-slate-brand text-cloud font-mono">
											{policy.grantedRole}
										</span>
									</div>
									<p className="text-xs text-cloud font-mono mt-1 truncate">{policy.issuer}</p>
									{Object.keys(policy.claimConditions).length > 0 && (
										<div className="flex flex-wrap gap-1 mt-2">
											{Object.entries(policy.claimConditions).map(([k, v]) => (
												<span
													key={k}
													className="text-xs font-mono bg-slate-brand/70 text-cloud px-2 py-0.5 rounded"
												>
													{k}={v}
												</span>
											))}
										</div>
									)}
								</div>
								<div className="flex items-center gap-2 shrink-0">
									<button
										type="button"
										onClick={() => {
											toggleMutation
												.mutateAsync({ id: policy.id, active: !policy.active })
												.then(() => refetch())
												.catch((e: unknown) =>
													setFormError(e instanceof Error ? e.message : "Update failed"),
												);
										}}
										className="text-xs text-cloud hover:text-mist px-2 py-1 rounded border border-cloud/20 hover:border-cloud/40 transition-colors"
									>
										{policy.active ? "Disable" : "Enable"}
									</button>
									<button
										type="button"
										onClick={() => {
											deleteMutation
												.mutateAsync({ id: policy.id })
												.then(() => refetch())
												.catch((e: unknown) =>
													setFormError(e instanceof Error ? e.message : "Delete failed"),
												);
										}}
										className="text-xs text-danger/70 hover:text-danger px-2 py-1 rounded border border-danger/20 hover:border-danger/40 transition-colors"
									>
										Delete
									</button>
								</div>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
