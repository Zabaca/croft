import { createVerify, generateKeyPairSync } from 'node:crypto'
import { expect, test } from 'bun:test'
import { parseServiceAccountKey, signAssertion } from './index'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

test('a key file whose newlines a YAML scalar ate is refused, naming the secret', () => {
  const flattened = JSON.stringify({
    client_email: 'a@b.iam.gserviceaccount.com',
    private_key: PEM.replaceAll('\n', ' '),
  })
  // This is the failure the guard exists for: `BEGIN` is still in there, and
  // without the check it reaches the signer and dies about DECODER routines.
  expect(() => parseServiceAccountKey(flattened, 'GCP_SERVICE_ACCOUNT_KEY')).toThrow(
    /GCP_SERVICE_ACCOUNT_KEY.*private_key/s,
  )
})

test('a key whose newlines are escaped is unescaped, and the result signs', () => {
  const escaped = JSON.stringify({
    client_email: 'a@b.iam.gserviceaccount.com',
    private_key: PEM.replaceAll('\n', '\\n'),
  })
  const credential = parseServiceAccountKey(escaped, 'GCP_SERVICE_ACCOUNT_KEY')
  expect(credential.private_key).toBe(PEM)

  const assertion = signAssertion(
    credential,
    ['https://www.googleapis.com/auth/cloud-platform'],
    100,
  )
  const [header, claims, signature] = assertion.split('.')
  expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
    alg: 'RS256',
    typ: 'JWT',
  })
  expect(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString())).toEqual({
    iss: 'a@b.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 100,
    // Google rejects — rather than clamps — anything past one hour.
    exp: 3700,
  })
  const verified = createVerify('RSA-SHA256')
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature ?? '', 'base64url'))
  expect(verified).toBe(true)
})

test('a body that is not a key file fails at the edge, not inside the signer', () => {
  expect(() => parseServiceAccountKey('not json', 'K')).toThrow(/K is not valid JSON/)
  expect(() => parseServiceAccountKey('{"private_key":"x"}', 'K')).toThrow(/client_email/)
})
