import { cloudflareTokenModule } from '../../../../vendor/zbc/modules/cloudflare-token'

// The credential the site deploys with: minted from CLOUDFLARE_ROOT_TOKEN on every apply, held in memory only,
// never in secrets.yaml. Scripts Write deploys the Worker and its assets; Routes Write plus Zone Read claim
// croft.zabaca.com/* (the DNS record itself is declared in Zabaca/zbc's zabaca-zone). Same shape as
// games-deploy-token in Zabaca/games-cars.
export default cloudflareTokenModule.instance({
  name: 'croft-deploy-token',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    tokenName: 'zabaca-croft-deploy',
    permissions: ['Workers Scripts Write', 'Workers Routes Write', 'Zone Read'],
  },
})
