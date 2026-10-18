import { cloudflareModule } from '../../../../vendor/zbc/modules/cloudflare'
import croftDeployToken from './croft-deploy-token'

// croft's website and docs (packages/site): the static Astro build as the assets of one Worker, whose script only
// picks HTML or Markdown for `/` and `/docs/*` by Accept (topology in packages/site/wrangler.jsonc). `build` runs
// the site's own build, which first writes the Guides and Reference from croft's `croft docs` pages.
//
// croft.zabaca.com is the site's home, the SITE in packages/site/site.mjs; the *.workers.dev URL keeps working
// alongside it. The route is here and not in wrangler.jsonc, so a deploy of that file under another name could
// never claim production's hostname. The AAAA record lives in Zabaca/zbc's zabaca-zone; this instance assumes it
// exists.
export default cloudflareModule.instance({
  name: 'site',
  imports: [croftDeployToken],
  config: {
    workdir: 'packages/site',
    accountId: '99a19e584439be0568f33aad0477372b',
    apiToken: { from: 'croft-deploy-token', output: 'tokenValue' },
    build: { command: 'bun run build', cwd: 'packages/site' },
    routes: ['croft.zabaca.com/*'],
  },
})
