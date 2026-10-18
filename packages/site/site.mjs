// The site's public address. Canonical links, the sitemap, llms.txt, robots.txt and the plugin's skill all print
// it, so it lives here once (test/agents.test.ts holds the skill to it). packages/infra/environments/production/
// site.ts deploys to the same host.
export const SITE = process.env.SITE_URL ?? 'https://croft.zabaca.com'
