import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRunner } from '../test-support/cli.mjs'

const invoke = createRunner({ GONDO_API_KEY: 'fake-key' })

test('a key alone discovers its account on the production runtime', async () => {
  const calls = []
  const result = await invoke(['guide'], async (url, init) => {
    calls.push({ url: String(url), method: init.method, authorization: init.headers.Authorization })
    return Response.json(calls.length === 1 ? { accountId: 'my-account' } : { version: 2, guide: 'Build a job.' })
  })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).guide, 'Build a job.')
  assert.deepEqual(calls, [
    { url: 'https://runtime.gondo.ai/api/operator/me', method: 'GET', authorization: 'Bearer fake-key' },
    { url: 'https://runtime.gondo.ai/api/accounts/my-account/operator/guide?topic=overview', method: 'GET', authorization: 'Bearer fake-key' },
  ])
})

test('an explicit runtime is also used for account discovery', async () => {
  const urls = []
  const result = await invoke(['employees', 'list'], async (url) => {
    urls.push(String(url))
    return Response.json(urls.length === 1 ? { accountId: 'local-account' } : [])
  }, { env: { GONDO_API_URL: 'http://localhost:3001' } })
  assert.equal(result.code, 0)
  assert.deepEqual(urls, ['http://localhost:3001/api/operator/me', 'http://localhost:3001/api/accounts/local-account/employees'])
})

for (const status of [401, 402, 403]) {
  test(`failed discovery (${status}) prevents the requested mutation`, async () => {
    let calls = 0
    const result = await invoke(['workflows', 'publish', 'job'], async () => {
      calls++
      return Response.json({ message: 'Access denied' }, { status })
    })
    assert.equal(result.code, 1)
    assert.equal(calls, 1)
    assert.equal(JSON.parse(result.stderr).status, status)
  })
}

test('an invalid discovery response never becomes an account request', async () => {
  let calls = 0
  const result = await invoke(['employees', 'list'], async () => {
    calls++
    return Response.json({ accountId: '../another-account' })
  })
  assert.equal(result.code, 1)
  assert.equal(calls, 1)
})

test('an existing account override skips discovery', async () => {
  const urls = []
  const result = await invoke(['guide'], async (url) => {
    urls.push(String(url))
    return Response.json({ version: 2, guide: 'Existing configuration.' })
  }, { env: { GONDO_ACCOUNT_ID: 'existing-account' } })
  assert.equal(result.code, 0)
  assert.deepEqual(urls, ['https://runtime.gondo.ai/api/accounts/existing-account/operator/guide?topic=overview'])
})
