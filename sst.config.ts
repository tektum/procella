/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
	app(input) {
		return {
			name: "procella",
			removal: input.stage === "production" ? "retain" : "remove",
			protect: input.stage === "production",
			home: "aws",
			providers: {
				aws: { region: "us-east-1", version: "7.20.0" },
				"@descope/pulumi-descope": "1.0.1",
				"@pulumi/command": "1.2.1",
			},
		};
	},
	async run() {
		await import("./infra/secrets");
		await import("./infra/database");
		await import("./infra/storage");
		const descopeProjectId = $dev ? undefined : (await import("./infra/descope")).projectId;
		const { router } = await import("./infra/router");
		await import("./infra/esc");
		const { api } = await import("./infra/api");
		await import("./infra/gc");
		await import("./infra/web-api");
		const { site } = await import("./infra/site");
		const { docs } = await import("./infra/docs");

		return {
			router: router.url,
			app: site.url,
			docs: docs.url,
			api: api.url,
			...(descopeProjectId ? { descopeProjectId } : {}),
		};
	},
});
