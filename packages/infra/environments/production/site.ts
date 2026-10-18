import { cloudflareModule } from '../../../../vendor/zbc/modules/cloudflare'
import croftDeployToken from './croft-deploy-token'

// croft's website and docs (packages/site): the static Astro build as the assets of one Worker, whose script only
// picks HTML or Markdown for `/` and `/docs/*` by Accept (topology in packages/site/wrangler.jsonc). `build` runs
// the site's own build, which first writes the Guides and Reference from croft's `croft docs` pages.
//
// It lands on croft.<account subdomain>.workers.dev, the SITE in packages/site/site.mjs. A custom hostname goes
// here as `routes`, never in wrangler.jsonc, and its DNS record in Zabaca/zbc's zabaca-zone.
export default cloudflareModule.instance({
  name: 'site',
  imports: [croftDeployToken],
  config: {
    workdir: 'packages/site',
    accountId: '99a19e584439be0568f33aad0477372b',
    apiToken: { from: 'croft-deploy-token', output: 'tokenValue' },
    build: { command: 'bun run build', cwd: 'packages/site' },
  },
})
