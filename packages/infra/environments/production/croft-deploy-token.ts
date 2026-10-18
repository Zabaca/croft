import { cloudflareTokenModule } from '../../../../vendor/zbc/modules/cloudflare-token'

// The credential the site deploys with: minted from CLOUDFLARE_ROOT_TOKEN on every apply, held in memory only,
// never in secrets.yaml. Workers Scripts Write is all an assets Worker on workers.dev needs. A custom hostname
// would add Workers Routes Write and Zone Read, as games-deploy-token in Zabaca/games-cars does.
export default cloudflareTokenModule.instance({
  name: 'croft-deploy-token',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    tokenName: 'zabaca-croft-deploy',
    permissions: ['Workers Scripts Write'],
  },
})
