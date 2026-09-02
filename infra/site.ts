import { api } from "./api";
import { router } from "./router";
import { webApi } from "./web-api";

const isProd = $app.stage === "production";
const stage = $app.stage;

const rootDomain = isProd ? "procella.cloud" : `${stage}.procella.cloud`;

export const site = new sst.aws.StaticSite("ProcellaSite", {
	path: "apps/ui",
	build: {
		command: "bun run build",
		output: "dist",
	},
	router: {
		instance: router,
		domain: `app.${rootDomain}`,
	},
	environment: {
		VITE_API_URL: "",
		VITE_APP_URL: `https://app.${rootDomain}`,
		VITE_CLI_API_URL: `https://api.${rootDomain}`,
	},
});

// Root domain serves the same UI
router.route(rootDomain, site.url);

// tRPC + Descope auth routes go to the Web Lambda; ESC routes go to the CLI Lambda.
// SST Router uses prefix matching — do NOT use /* (the * is stored literally
// and startsWith() in the CloudFront Function won't treat it as a wildcard).
router.route(`app.${rootDomain}/trpc`, webApi.url);
router.route(`app.${rootDomain}/api/auth`, webApi.url);
router.route(`app.${rootDomain}/api/esc`, api.url);
router.route(`${rootDomain}/trpc`, webApi.url);
router.route(`${rootDomain}/api/auth`, webApi.url);
router.route(`${rootDomain}/api/esc`, api.url);
