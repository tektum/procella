import stormPetrelSvg from "../assets/storm-petrel.svg";
import { ProcellaLogo } from "../components/ProcellaLogo";
import { appUrl, cliApiUrl, DOMAIN } from "../config";

const features = [
	{
		title: "Full CLI Compatibility",
		description:
			"pulumi login, stack init, up, preview, refresh, destroy — every command works against your own backend.",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-6 h-6"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z"
				/>
			</svg>
		),
	},
	{
		title: "Web Dashboard",
		description:
			"View stacks, updates, and events in real time. Manage API tokens and team settings from the browser.",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-6 h-6"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zm0 9.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zm0 9.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z"
				/>
			</svg>
		),
	},
	{
		title: "Encrypted Secrets",
		description:
			"AES-256-GCM with HKDF per-stack key derivation. Your secrets stay encrypted at rest.",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-6 h-6"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"
				/>
			</svg>
		),
	},
	{
		title: "Horizontally Scalable",
		description:
			"All state in PostgreSQL. No in-memory caches. Run multiple replicas behind a load balancer with S3 blob storage.",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-6 h-6"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z"
				/>
			</svg>
		),
	},
	{
		title: "Multi-Tenant Auth",
		description:
			"Static tokens for dev, Descope SSO for production. Browser-based CLI login with automatic token exchange.",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-6 h-6"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
				/>
			</svg>
		),
	},
	{
		title: "Role-Based Access",
		description:
			"Viewer, member, and admin roles enforced per-organization. Manage team permissions from the dashboard.",
		icon: (
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-6 h-6"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
				/>
			</svg>
		),
	},
];

export function HomePage() {
	return (
		<div className="min-h-screen bg-deep-sky text-mist overflow-hidden">
			{/* Background grid */}
			<div
				className="fixed inset-0 opacity-[0.03]"
				style={{
					backgroundImage:
						"linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)",
					backgroundSize: "64px 64px",
				}}
			/>

			{/* Radial glow */}
			<div
				className="fixed top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] opacity-20 pointer-events-none"
				style={{
					background:
						"radial-gradient(ellipse at center, rgba(0,212,255,0.15) 0%, transparent 70%)",
				}}
			/>

			{/* Nav */}
			<nav className="relative z-10 border-b border-slate-brand/50">
				<div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
					<div className="flex items-center gap-3">
						<ProcellaLogo size="sm" />
						<span className="hidden sm:inline-flex px-2 py-0.5 rounded bg-slate-brand/80 text-[11px] font-medium text-cloud border border-cloud/20 uppercase tracking-widest">
							Open Source
						</span>
					</div>
					<div className="flex items-center gap-4">
						<a
							href={`https://docs.${DOMAIN}`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm text-cloud hover:text-mist/80 transition-colors"
						>
							Docs
						</a>
						<a
							href="https://github.com/tektum/procella"
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm text-cloud hover:text-mist/80 transition-colors"
						>
							GitHub
						</a>
						<a
							href={`${appUrl}/login`}
							className="text-sm font-medium text-mist bg-slate-brand hover:bg-cloud/50 border border-cloud/30 px-4 py-2 rounded-lg transition-colors"
						>
							Sign in
						</a>
					</div>
				</div>
			</nav>

			{/* Hero */}
			<section className="relative z-10 pt-24 sm:pt-32 pb-20 px-6">
				<div className="max-w-3xl mx-auto text-center home-fade-in">
					{/* Storm Petrel Mascot — hero focal point */}
					<div className="flex justify-center mb-10">
						<div
							className="relative w-36 h-36 sm:w-44 sm:h-44 md:w-52 md:h-52 rounded-2xl overflow-hidden"
							style={{
								boxShadow:
									"0 0 60px rgba(0,212,255,0.25), 0 0 120px rgba(0,212,255,0.1), 0 8px 32px rgba(0,0,0,0.4)",
							}}
						>
							<img
								src={stormPetrelSvg}
								alt="Procella — Storm Petrel mascot"
								className="w-full h-full object-cover"
							/>
							{/* Glow ring */}
							<div
								className="absolute inset-0 rounded-2xl pointer-events-none"
								style={{
									boxShadow: "inset 0 0 0 1px rgba(0,212,255,0.2)",
								}}
							/>
						</div>
					</div>

					<div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-lightning/10 border border-lightning/20 text-lightning text-xs font-medium mb-8 tracking-wide">
						<span className="w-1.5 h-1.5 rounded-full bg-lightning animate-pulse" />
						Pulumi-compatible backend
					</div>
					<h1 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.1] mb-6">
						<span className="text-mist">Self-hosted Pulumi.</span>
						<br />
						<span className="text-cloud">Your infrastructure, your rules.</span>
					</h1>
					<p className="text-lg sm:text-xl text-cloud leading-relaxed max-w-2xl mx-auto mb-10">
						Run{" "}
						<code className="text-mist/80 bg-slate-brand/80 px-1.5 py-0.5 rounded text-[0.9em]">
							pulumi up
						</code>{" "}
						against your own backend. Full CLI compatibility, encrypted secrets, web dashboard — no
						Pulumi Cloud account required.
					</p>
					<div className="flex flex-col sm:flex-row items-center justify-center gap-3">
						<a
							href={`${appUrl}/login`}
							className="inline-flex items-center gap-2 px-6 py-3 bg-lightning hover:bg-lightning/80 text-deep-sky font-medium rounded-lg transition-colors text-sm"
						>
							Open Dashboard
							<svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
								<path
									fillRule="evenodd"
									d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
									clipRule="evenodd"
								/>
							</svg>
						</a>
						<a
							href="https://github.com/tektum/procella"
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-2 px-6 py-3 text-cloud hover:text-mist font-medium rounded-lg transition-colors text-sm border border-slate-brand hover:border-cloud/30"
						>
							<svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5" aria-hidden="true">
								<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
							</svg>
							View Source
						</a>
					</div>
				</div>
			</section>

			{/* Terminal preview */}
			<section className="relative z-10 pb-24 px-6">
				<div className="max-w-2xl mx-auto home-fade-in home-fade-in-delay-1">
					<div className="bg-slate-brand border border-slate-brand rounded-xl overflow-hidden shadow-2xl shadow-black/50">
						<div className="flex items-center gap-2 px-4 py-3 border-b border-slate-brand bg-slate-brand/50">
							<div className="w-3 h-3 rounded-full bg-cloud/50" />
							<div className="w-3 h-3 rounded-full bg-cloud/50" />
							<div className="w-3 h-3 rounded-full bg-cloud/50" />
							<span className="ml-2 text-xs text-cloud/60 font-mono">terminal</span>
						</div>
						<div className="p-5 font-mono text-sm leading-relaxed">
							<div className="text-cloud">
								<span className="text-success">$</span> pulumi login {cliApiUrl}
							</div>
							<div className="text-cloud mt-1">
								Logged in to {new URL(cliApiUrl).host} as dev-user
							</div>
							<div className="mt-4 text-cloud">
								<span className="text-success">$</span> pulumi stack init myorg/myproject/production
							</div>
							<div className="text-cloud mt-1">Created stack &apos;production&apos;</div>
							<div className="mt-4 text-cloud">
								<span className="text-success">$</span> pulumi up
							</div>
							<div className="text-cloud mt-1">Previewing update (myorg/myproject/production)</div>
							<div className="mt-2 text-cloud">
								&nbsp;&nbsp;&nbsp;&nbsp;
								<span className="text-success">+</span> aws:s3:Bucket   my-bucket{" "}
								<span className="text-success">created</span>
							</div>
							<div className="text-cloud">
								&nbsp;&nbsp;&nbsp;&nbsp;
								<span className="text-success">+</span> aws:lambda:Function   handler{" "}
								<span className="text-success">created</span>
							</div>
							<div className="mt-2 text-cloud">
								Resources:
								<br />
								&nbsp;&nbsp;&nbsp;&nbsp;
								<span className="text-success">+ 2 created</span>
							</div>
							<div className="mt-1 text-cloud">Duration: 12s</div>
						</div>
					</div>
				</div>
			</section>

			{/* Features */}
			<section className="relative z-10 pb-24 px-6">
				<div className="max-w-5xl mx-auto">
					<div className="text-center mb-16 home-fade-in home-fade-in-delay-1">
						<h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4">
							Everything you need to run Pulumi
						</h2>
						<p className="text-cloud max-w-xl mx-auto">
							A complete, production-ready backend that replaces Pulumi Cloud — deployable on your
							own infrastructure in minutes.
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px bg-slate-brand/50 rounded-xl border border-slate-brand overflow-hidden">
						{features.map((feature, i) => (
							<div
								key={feature.title}
								className="bg-deep-sky p-8 home-fade-in"
								style={{ animationDelay: `${150 + i * 80}ms` }}
							>
								<div className="w-10 h-10 rounded-lg bg-slate-brand/80 border border-cloud/20 flex items-center justify-center text-lightning mb-4">
									{feature.icon}
								</div>
								<h3 className="text-sm font-semibold text-mist mb-2">{feature.title}</h3>
								<p className="text-sm text-cloud leading-relaxed">{feature.description}</p>
							</div>
						))}
					</div>
				</div>
			</section>

			{/* Quick Start */}
			<section className="relative z-10 pb-24 px-6">
				<div className="max-w-3xl mx-auto home-fade-in home-fade-in-delay-2">
					<div className="text-center mb-12">
						<h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4">
							Get started in seconds
						</h2>
						<p className="text-cloud">
							Point the Pulumi CLI at your Procella instance and start deploying.
						</p>
					</div>

					<div className="space-y-4">
						<Step number="1" title="Login to your backend" code={`pulumi login ${cliApiUrl}`} />
						<Step
							number="2"
							title="Initialize a stack"
							code="pulumi stack init myorg/myproject/dev"
						/>
						<Step number="3" title="Deploy" code="pulumi up" />
					</div>
				</div>
			</section>

			{/* CTA */}
			<section className="relative z-10 pb-32 px-6">
				<div className="max-w-2xl mx-auto text-center home-fade-in home-fade-in-delay-2">
					<div className="bg-slate-brand/50 border border-slate-brand rounded-2xl p-12">
						<h2 className="text-2xl font-bold tracking-tight mb-3">Ready to take control?</h2>
						<p className="text-cloud mb-8">Deploy Procella and own your infrastructure state.</p>
						<a
							href={`${appUrl}/login`}
							className="inline-flex items-center gap-2 px-6 py-3 bg-lightning hover:bg-lightning/80 text-deep-sky font-medium rounded-lg transition-colors text-sm"
						>
							Open Dashboard
							<svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
								<path
									fillRule="evenodd"
									d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z"
									clipRule="evenodd"
								/>
							</svg>
						</a>
					</div>
				</div>
			</section>

			{/* Footer */}
			<footer className="relative z-10 border-t border-slate-brand/50 py-8 px-6">
				<div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
					<div className="flex items-center gap-2 text-sm text-cloud/60">
						<span className="font-medium text-cloud">Procella</span>
						<span>·</span>
						<span>Self-hosted Pulumi backend</span>
					</div>
					<div className="flex items-center gap-4">
						<a
							href={`https://docs.${DOMAIN}`}
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm text-cloud/60 hover:text-cloud transition-colors"
						>
							Docs
						</a>
						<a
							href="https://github.com/tektum/procella"
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm text-cloud/60 hover:text-cloud transition-colors"
						>
							GitHub
						</a>
					</div>
				</div>
			</footer>
		</div>
	);
}

function Step({ number, title, code }: { number: string; title: string; code: string }) {
	return (
		<div className="flex gap-4 items-start bg-slate-brand/50 border border-slate-brand rounded-xl p-5">
			<div className="w-8 h-8 rounded-full bg-lightning/10 border border-lightning/20 flex items-center justify-center text-lightning text-sm font-semibold shrink-0">
				{number}
			</div>
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium text-mist/80 mb-2">{title}</p>
				<div className="bg-deep-sky border border-slate-brand rounded-lg px-4 py-2.5 font-mono text-sm text-cloud overflow-x-auto">
					<span className="text-success mr-2">$</span>
					{code}
				</div>
			</div>
		</div>
	);
}
