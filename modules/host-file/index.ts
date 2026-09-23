import { z } from 'zod'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { defineModule } from '../../src/define-module'

// Writes a file on this host, converging on content + mode. Content comes
// either inline (`content`) or from a SOPS secret (`secretKey` — the value in
// environments/<env>/secrets.yaml). Idempotent: only rewrites when the
// on-disk bytes differ, so downstream instances can key restarts off
// `outputs.changed`.
export const hostFileModule = defineModule({
  name: 'host-file',
  configSchema: z
    .object({
      path: z.string(),
      content: z.string().optional(),
      secretKey: z.string().optional(),
      mode: z.string().default('0644'),
    })
    .refine((c) => (c.content === undefined) !== (c.secretKey === undefined), {
      message: 'exactly one of content or secretKey is required',
    }),
  outputs: z.object({ path: z.string(), changed: z.boolean() }),
  apply: async (config, ctx) => {
    // `allowBlank`: presence is the contract. An empty secret is a legitimate
    // file body, and refusing it would make "no value yet" unrepresentable.
    const desired =
      config.content !== undefined
        ? config.content
        : ctx.secret(config.secretKey!, { allowBlank: true })
    const existing = fs.existsSync(config.path) ? fs.readFileSync(config.path, 'utf8') : null
    const changed = existing !== desired
    const mode = parseInt(config.mode, 8)
    if (changed) {
      fs.mkdirSync(path.dirname(config.path), { recursive: true })
      // mode at create time — a default-umask write followed by chmod leaves
      // a window where a secret-bearing file is world-readable. (The mode
      // option is ignored when overwriting; chmodSync below converges that.)
      fs.writeFileSync(config.path, desired, { mode })
    }
    fs.chmodSync(config.path, mode)
    console.log(`  ${config.path} ${changed ? 'written' : 'unchanged'}`)
    return { path: config.path, changed }
  },
})
