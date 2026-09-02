import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import codecovAstroPlugin from '@codecov/astro-plugin';

export default defineConfig({
  site: process.env.SITE_URL || 'https://docs.procella.dev',
  base: '/',
  integrations: [
    starlight({
      title: 'Procella',
      description: 'Self-hosted Pulumi backend documentation',
      customCss: ['./src/styles/custom.css'],
      components: {
        Head: './src/components/Head.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/tektum/procella' },
      ],
      editLink: {
        baseUrl: 'https://github.com/tektum/procella/edit/main/apps/docs/',
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Quick Start', slug: 'getting-started/quickstart' },
            { label: 'Configuration', slug: 'getting-started/configuration' },
            { label: 'Pulumi CLI Compatibility', slug: 'getting-started/compatibility' },
            { label: 'Migrating to Procella', slug: 'getting-started/migration' },
            { label: 'Migration Tool', slug: 'getting-started/migration-tool' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture/overview' },
            { label: 'Authentication', slug: 'architecture/authentication' },
            { label: 'Web Dashboard', slug: 'architecture/dashboard' },
            { label: 'Update Lifecycle', slug: 'architecture/update-lifecycle' },
            { label: 'State Operations', slug: 'architecture/state-operations' },
            { label: 'Encryption', slug: 'architecture/encryption' },
            { label: 'Database Schema', slug: 'architecture/database' },
          ],
        },
        {
          label: 'Features',
          items: [
            { label: 'Stack Search', slug: 'features/search' },
            { label: 'Webhooks', slug: 'features/webhooks' },
            { label: 'Audit Logs', slug: 'features/audit' },
            { label: 'GitHub App', slug: 'features/github-app' },
            { label: 'GitHub Action', slug: 'features/github-action' },
          ],
        },
        {
          label: 'Operations',
          items: [
            { label: 'Descope Setup', slug: 'operations/descope' },
            { label: 'OIDC CI Authentication', slug: 'operations/oidc-ci' },
            { label: 'Docker Compose', slug: 'operations/docker-compose' },
            { label: 'Horizontal Scaling', slug: 'operations/horizontal-scaling' },
            { label: 'Blob Storage', slug: 'operations/blob-storage' },
            { label: 'Environment Variables', slug: 'operations/environment-variables' },
          ],
        },
        {
          label: 'Deployment',
          items: [
            { label: 'AWS (SST)', slug: 'deployment/aws-sst' },
            { label: 'AWS (ECS)', slug: 'deployment/aws-ecs' },
            { label: 'Fly.io', slug: 'deployment/fly-io' },
            { label: 'Railway', slug: 'deployment/railway' },
            { label: 'Render', slug: 'deployment/render' },
            { label: 'Coolify', slug: 'deployment/coolify' },
          ],
        },
        {
          label: 'Development',
          items: [
            { label: 'Contributing', slug: 'development/contributing' },
            { label: 'Testing', slug: 'development/testing' },
            { label: 'Benchmarking', slug: 'development/benchmarking' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'Stack API', slug: 'api/stacks' },
            { label: 'Update API', slug: 'api/updates' },
            { label: 'State Operations API', slug: 'api/state' },
            { label: 'Encryption API', slug: 'api/encryption' },
          ],
        },
      ],
    }),
    codecovAstroPlugin({
      enableBundleAnalysis: !!process.env.CI,
      bundleName: 'procella-docs',
      oidc: { useGitHubOIDC: !!process.env.CI },
    }),
  ],
});
