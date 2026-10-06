import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { buildRequest, safeDownloadName } from '../src/cli.mjs'
import { createRunner, directory } from '../test-support/cli.mjs'

const env = { GONDO_API_URL: 'https://runtime.test', GONDO_ACCOUNT_ID: 'account', GONDO_API_KEY: 'fake-secret' }
const invoke = createRunner(env)

const invalidArguments = [
  [['bogus']], [['guide', 'unexpected']], [['employees', 'get']],
  [['employees', 'get', '../other']], [['exec']],
  [['workflows', 'create', '--employee', 'emp']], [['guide', '--unknown']],
  [['integrations', 'providers', 'typo'], /Unexpected positional/],
  [['integrations', 'list', 'typo'], /Unexpected positional/],
  [['integrations', 'create', 'typo', '--provider', 'clio', '--name', 'Demo'], /Unexpected positional/],
  [['attempts', 'files', 'list', 'attempt', 'extra'], /Unexpected positional/],
  [['workflows', 'webhook', 'configure', 'wf'], /--output/],
]
for (const [args, message] of invalidArguments) {
  test(`invalid arguments fail before transport: ${args}`, async () => {
    let calls = 0
    const result = await invoke(args, () => { calls++; assert.fail('must not send') })
    assert.equal(calls, 0)
    assert.equal(result.code, 1)
    if (message) assert.match(result.stderr, message)
  })
}
for (const url of ['http://runtime.test', 'https://user:pass@runtime.test', 'https://runtime.test?secret=1', 'https://runtime.test#fragment']) {
  test(`unsafe runtime URL fails before transport: ${url}`, async () => {
    assert.equal((await invoke(['guide'], () => assert.fail('must not send'), { env: { GONDO_API_URL: url } })).code, 1)
  })
}
for (const account of ['../other', 'a/b', '.', '..']) {
  test(`unsafe account path fails before transport: ${account}`, async () => {
    assert.equal((await invoke(['guide'], () => assert.fail('must not send'), { env: { GONDO_ACCOUNT_ID: account } })).code, 1)
  })
}
for (const url of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
  test(`supports loopback runtime: ${url}`, async () => {
    assert.equal((await invoke(['guide'], async () => Response.json({ version: 2, guide: 'ok' }), { env: { GONDO_API_URL: url } })).code, 0)
  })
}
for (const [status, body] of [[503, { message: 'Unavailable' }], [200, { success: false }], [200, { ok: false }]]) {
  test(`HTTP/logical failure is not retried: ${status} ${JSON.stringify(body)}`, async () => {
    let calls = 0
    const result = await invoke(['workflows', 'publish', 'wf'], async () => { calls++; return Response.json(body, { status }) })
    assert.equal(result.code, 1)
    assert.equal(calls, 1)
  })
}
test('network and non-JSON errors never print the API key or server HTML', async () => {
  for (const send of [async () => { throw new Error(`echo ${env.GONDO_API_KEY}`) }, async () => new Response(`<html>${env.GONDO_API_KEY}</html>`, { status: 502 })]) {
    const result = await invoke(['guide'], send)
    assert.equal(result.code, 1)
    assert.ok(!result.stderr.includes(env.GONDO_API_KEY))
    assert.ok(!result.stderr.includes('<html>'))
  }
})
test('run commands resolve one current attempt and cancellation never retries', async () => {
  const calls = []
  const result = await invoke(['runs', 'cancel', 'run'], async (url, init) => {
    calls.push([url.pathname, init.method])
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, `Bearer ${env.GONDO_API_KEY}`)
    assert.ok(init.signal instanceof AbortSignal)
    return calls.length === 1 ? Response.json({ currentAttemptId: 'attempt' }) : Response.json({ message: 'Unavailable' }, { status: 503 })
  })
  assert.equal(result.code, 1)
  assert.deepEqual(calls, [['/api/accounts/account/runs/run', 'GET'], ['/api/accounts/account/run-attempts/attempt/cancel', 'POST']])
  let count = 0
  assert.equal((await invoke(['runs', 'cancel', 'missing'], async () => { count++; return Response.json({}, { status: 404 }) })).code, 1)
  assert.equal(count, 1)
})
test('request construction preserves source files and export writes private YAML', async t => {
  const dir = await directory(t)
  const code = join(dir, 'code.js'); await writeFile(code, 'return { ready: true }')
  assert.deepEqual((await buildRequest(['exec', '--file', code, '--integrations', 'crm, crm_two'])).body, { code: 'return { ready: true }', channels: [], integrations: ['crm', 'crm_two'] })
  const yaml = join(dir, 'workflow.yaml'); await writeFile(yaml, 'version: 3\nnodes: {}\nedges: []\n')
  assert.deepEqual((await buildRequest(['workflows', 'save-draft', 'wf', '--file', yaml])).body, { arguments: { op: 'replace', workflow_id: 'wf', definition_yaml: await readFile(yaml, 'utf8') } })
  const json = join(dir, 'workflow.json'); await writeFile(json, '{"nodes":{},"edges":[],"version":3}')
  assert.deepEqual(parse((await buildRequest(['workflows', 'save-draft', 'wf', '--file', json])).body.arguments.definition_yaml), { nodes: {}, edges: [], version: 3 })
  assert.deepEqual((await buildRequest(['runs', 'start', 'wf'])).body, { workflowId: 'wf', useDraft: false, startAsync: true, triggerData: {} })
  assert.deepEqual((await buildRequest(['list', '/runs', '--limit', '10'])).body, { arguments: { path: '/runs', limit: 10 } })
  const output = join(dir, 'export.yaml')
  assert.equal((await invoke(['workflows', 'export', 'wf', '--output', output], async () => Response.json({ yaml: 'version: 3\n' }))).code, 0)
  assert.equal(await readFile(output, 'utf8'), 'version: 3\n')
  assert.equal((await stat(output)).mode & 0o777, 0o600)
})
test('session attachments and outputs retain their exact binary bytes', async t => {
  const dir = await directory(t)
  const bytes = Buffer.from([0, 255, 128, 13, 10, 42])
  const input = join(dir, 'input.bin'); await writeFile(input, bytes)
  const code = join(dir, 'code.js'); await writeFile(code, 'return 1')
  const artifact = { id: 'output', name: 'result.bin', sessionId: 'session', executionId: 'execution', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  let executions = 0
  const result = await invoke(['exec', '--file', code, '--attach', input, '--output-dir', join(dir, 'out')], async (url, init) => {
    if (url.pathname.endsWith('/code/sessions')) return Response.json({ id: 'session' })
    if (url.pathname.endsWith('/files') && init.method === 'POST') {
      assert.equal(init.duplex, 'half')
      const chunks = []; for await (const chunk of init.body) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), bytes)
      return Response.json({ id: 'input' })
    }
    if (url.pathname.endsWith('/code/execute')) {
      executions++
      assert.deepEqual(JSON.parse(init.body).fileIds, ['input'])
      return Response.json({ executionId: 'execution', sessionId: 'session', success: true, files: [artifact] })
    }
    return new Response(bytes)
  })
  assert.equal(result.code, 0)
  assert.equal(executions, 1)
  assert.deepEqual(await readFile(join(dir, 'out/result.bin')), bytes)
})
test('login handoff returns exit 2 and preserves an explicit session', async t => {
  const dir = await directory(t); const code = join(dir, 'code.js'); await writeFile(code, 'return 1')
  let calls = 0
  const result = await invoke(['exec', '--session', 'session', '--file', code], async (_url, init) => {
    calls++; assert.equal(JSON.parse(init.body).sessionId, 'session')
    return Response.json({ success: false, requiredAction: { kind: 'browser_login' } })
  })
  assert.equal(result.code, 2); assert.equal(calls, 1)
})
test('session downloads reject unsafe names and symlink overwrites', async t => {
  for (const name of ['../secret', '/etc/passwd', '..', 'a\\b', 'bad\0name']) assert.throws(() => safeDownloadName(name))
  const dir = await directory(t); await writeFile(join(dir, 'target'), 'keep'); await symlink(join(dir, 'target'), join(dir, 'result.bin'))
  let calls = 0
  const result = await invoke(['files', 'download', 'file', '--session', 'session', '--output-dir', dir], async () => {
    calls++; return Response.json({ files: [{ id: 'file', name: 'result.bin', sizeBytes: 4 }] })
  })
  assert.equal(result.code, 1); assert.equal(calls, 1)
  assert.equal(await readFile(join(dir, 'target'), 'utf8'), 'keep')
})

test('maps session inspection, closing and browser restart explicitly', async () => {
  assert.equal((await buildRequest(['sessions', 'get', 's'])).path, '/code/sessions/s')
  const close = await buildRequest(['sessions', 'close', 's'])
  assert.equal(close.method, 'POST'); assert.equal(close.path, '/code/sessions/s/close')
  assert.equal((await buildRequest(['executions', 'get', 'e', '--session', 's'])).path, '/code/sessions/s/executions/e')
  const restart = await buildRequest(['browser', 'restart', 's', '--integration', 'portal'])
  assert.equal(restart.path, '/code/sessions/s/browser/restart'); assert.deepEqual(restart.body, { integration: 'portal' })
})
