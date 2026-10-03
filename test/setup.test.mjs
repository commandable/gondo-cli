import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { buildRequest, runCli } from '../src/cli.mjs'

async function invoke(args, fetchImpl, stdin) {
  let stdout = ''; let stderr = ''
  const code = await runCli(args, { env: { GONDO_API_KEY: 'fake-key', GONDO_ACCOUNT_ID: 'account' }, fetchImpl,
    stdout: { write: v => { stdout += v } }, stderr: { write: v => { stderr += v } }, stdin })
  return { code, stdout, stderr }
}

test('routes nested setup commands and rejects extra positional arguments', async () => {
  assert.equal((await buildRequest(['integrations', 'provider', 'clio'])).path, '/operator/integrations/providers/clio')
  assert.deepEqual((await buildRequest(['integrations', 'create', '--provider', 'clio', '--name', 'Demo'])).body, { providerKey: 'clio', label: 'Demo' })
  assert.equal((await buildRequest(['workflows', 'webhook', 'get', 'wf'])).path, '/workflows/wf/webhook/connection')
  assert.equal((await buildRequest(['attempts', 'files', 'list', 'attempt'])).path, '/run-attempts/attempt')
  await assert.rejects(buildRequest(['attempts', 'files', 'list', 'attempt', 'extra']), /Unexpected positional/)
  await assert.rejects(buildRequest(['workflows', 'webhook', 'configure', 'wf']), /--output/)
})

test('credential stdin works and errors never print supplied secrets', async () => {
  const result = await invoke(['integrations', 'credentials', 'i', '--file', '-', '--variant', 'eu'], async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { credentials: { token: 'very-private' }, variantKey: 'eu' })
    return Response.json({ message: 'Rejected very-private' }, { status: 400 })
  }, Readable.from(['{"token":"very-private"}']))
  assert.equal(result.code, 1)
  assert.ok(!result.stderr.includes('very-private'))
  const invalid = await invoke(['integrations', 'credentials', 'i', '--file', '-'], () => assert.fail('must not send'), Readable.from(['token: [secret-invalid']))
  assert.equal(invalid.code, 1)
  assert.ok(!invalid.stderr.includes('secret-invalid'))
})

test('missing scope is actionable and mutations are not retried', async () => {
  let calls = 0
  const result = await invoke(['integrations', 'enable', 'i'], async () => {
    calls++
    return Response.json({ statusMessage: 'API key requires integrations:manage scope.' }, { status: 403 })
  })
  assert.equal(result.code, 1)
  assert.equal(calls, 1)
  assert.match(result.stderr, /integrations:manage/)
})

test('webhook secret is saved privately, never printed, and existing files block requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gondo-secret-'))
  const file = join(dir, 'webhook.json')
  let calls = 0
  const send = async () => { calls++; return Response.json({ configured: true, endpointUrl: 'https://example.test/hook', secret: 'hook-private' }) }
  const result = await invoke(['workflows', 'webhook', 'configure', 'wf', '--output', file], send)
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).secret, 'hook-private')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.ok(!result.stdout.includes('hook-private'))
  const blocked = await invoke(['workflows', 'webhook', 'rotate-secret', 'wf', '--output', file], send)
  assert.equal(blocked.code, 1)
  assert.equal(calls, 1)
})

test('existing webhook configuration does not invent or rotate secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gondo-secret-'))
  const result = await invoke(['workflows', 'webhook', 'configure', 'wf', '--output', join(dir, 'existing.json')], async () => Response.json({ configured: true, secret: null }))
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).secretIssued, false)
})

for (const corrupt of [false, true]) {
  test(`artifact download separates authorization and verifies integrity (corrupt=${corrupt})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gondo-artifact-'))
    const bytes = Buffer.from('docx bytes')
    const file = { id: 'artifact', name: 'letter.docx', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    const result = await invoke(['attempts', 'files', 'download', 'attempt', 'artifact', '--output-dir', dir], async (url, init) => {
      if (url.hostname === 'storage.test') {
        assert.equal(init.headers, undefined)
        return new Response(corrupt ? Buffer.from('bad bytes!') : bytes)
      }
      assert.equal(init.headers.Authorization, 'Bearer fake-key')
      return Response.json(url.pathname.endsWith('download-url') ? { sasUrl: 'https://storage.test/letter?token=private' } : { fileArtifacts: [file] })
    })
    assert.equal(result.code, corrupt ? 1 : 0)
    if (corrupt) assert.deepEqual(await readdir(dir), [])
    else assert.deepEqual(await readFile(join(dir, 'letter.docx')), bytes)
    assert.ok(!result.stdout.includes('token=private'))
  })
}

test('unsafe filenames and existing outputs fail before storage requests', async () => {
  for (const name of ['../escape.docx', 'existing.docx']) {
    const dir = await mkdtemp(join(tmpdir(), 'gondo-artifact-'))
    await writeFile(join(dir, 'existing.docx'), 'keep')
    let calls = 0
    const result = await invoke(['attempts', 'files', 'download', 'attempt', 'artifact', '--output-dir', dir], async () => {
      calls++
      return Response.json({ fileArtifacts: [{ id: 'artifact', name }] })
    })
    assert.equal(result.code, 1)
    assert.equal(calls, 1)
    assert.equal(await readFile(join(dir, 'existing.docx'), 'utf8'), 'keep')
  }
})
