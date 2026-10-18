// The repository's README (GitHub's front page) and the package's (npm's) say the same thing: npm's is GitHub's
// without the "This repository" section, its top line linking GitHub where GitHub's links npm, and every link
// absolute, since npm does not resolve a link relative to the repository. npm shows the README of the version
// published last, so a change here reaches npm with the next release.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
const github = readFileSync(join(ROOT, 'README.md'), 'utf8')
const npm = readFileSync(join(ROOT, 'packages/croft/README.md'), 'utf8')

test('npm README is the GitHub README up to its repository section', () => {
  const shared = github.slice(0, github.indexOf('## This repository'))
  const expected = shared.replace('[npm](https://www.npmjs.com/package/@zabaca/croft)', '[GitHub](https://github.com/Zabaca/croft)')
  expect(npm.slice(0, npm.indexOf('## Links'))).toBe(expected)
})

test('every link in the npm README is absolute', () => {
  for (const m of npm.matchAll(/\]\(([^)]+)\)/g)) expect(m[1]!, m[0]).toMatch(/^https:\/\//)
})
