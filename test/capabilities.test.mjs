import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildRequest } from '../src/cli.mjs'
import { createRunner, directory } from '../test-support/cli.mjs'

const invoke = createRunner({ GONDO_API_KEY: 'private-key', GONDO_ACCOUNT_ID: 'account' })

test('catalog commands return the server schema without a local tool registry', async () => {
  for (const args of [['tools', 'list'], ['tools', 'describe', 'gondo_upsert_workflow_node']]) {
    const result = await invoke(args, async (url, init) => {
      assert.equal(init.method, 'GET')
      assert.match(url.pathname, /\/operator\/tools/)
      return Response.json({ version: 2, tools: [{ name: 'new_server_tool', inputSchema: { type: 'object' }, requireConfirmation: true }] })
    })
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).tools[0].name, 'new_server_tool')
    assert.equal(JSON.parse(result.stdout).tools[0].requireConfirmation, true)
  }
})

test('generic calls preserve arguments and keep session outside the tool schema', async t => {
  const file = join(await directory(t), 'args.json')
  await writeFile(file, JSON.stringify({ skill_id: 'docx' }))
  let calls = 0
  const result = await invoke(['call', 'load_skill', '--file', file, '--session', 'os_existing'], async (url, init) => {
    calls++
    assert.equal(url.pathname, '/api/accounts/account/operator/tools/load_skill/call')
    assert.deepEqual(JSON.parse(init.body), { arguments: { skill_id: 'docx' }, sessionId: 'os_existing' })
    return Response.json({ version: 2, success: true, result: { content: 'Actual skill instructions' } })
  })
  assert.equal(calls, 1)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /Actual skill instructions/)
})

test('rejects unsupported server capabilities without fallback or retry', async () => {
  for (const response of [() => Response.json({ version: 1, guide: 'stale text' }), () => new Response('not found', { status: 404 })]) {
    let calls = 0
    const result = await invoke(['guide'], async () => { calls++; return response() })
    assert.equal(calls, 1)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /CLI 0\.2\.0/)
    assert.ok(!result.stdout.includes('stale text'))
  }
})

test('host and interactive actions exit 2 without claiming they were approved', async t => {
  const file = join(await directory(t), 'args.json')
  await writeFile(file, '{}')
  for (const kind of ['host', 'integration_setup']) {
    const result = await invoke(['call', 'confirm_action', '--file', file], async () => Response.json({ version: 2, success: false, requiredAction: { kind } }))
    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stdout).requiredAction.kind, kind)
    assert.ok(!result.stdout.includes('approved'))
  }
})

test('workflow reads select one definition, with explicit optional presentation', async () => {
  const compact = await buildRequest(['workflows', 'get', 'wf'])
  assert.equal(compact.path, '/operator/tools/gondo_read/call')
  assert.deepEqual(compact.body, { arguments: { path: '/workflows/wf' }, presentation: { source: 'active', format: 'json', editorState: false } })
  const full = await buildRequest(['workflows', 'get', 'wf', '--source', 'published', '--format', 'yaml', '--editor-state'])
  assert.deepEqual(full.body.presentation, { source: 'published', format: 'yaml', editorState: true })
})

test('creation uses the shared Admin defaults', async () => {
  const args = ['integrations', 'create', '--provider', 'clio', '--name', 'Claims']
  assert.deepEqual((await buildRequest(args)).body.arguments, { type: 'clio', label: 'Claims' })
})

test('invalid limits fail before transport for both list interfaces', async () => {
  for (const command of [['list', '/runs'], ['runs', 'list']]) {
    for (const limit of ['abc', '', ' ', '0', '-1', '1.5', 'Infinity', '9007199254740992', '0x10', '1e2']) {
      const result = await invoke([...command, `--limit=${limit}`], () => assert.fail('must not send'))
      assert.equal(result.code, 1)
      assert.match(result.stderr, /--limit must be a positive safe integer/)
    }
  }
  assert.equal((await buildRequest(['list', '/runs', '--limit', '25'])).body.arguments.limit, 25)
  assert.equal((await buildRequest(['runs', 'list', '--limit', '25'])).query.limit, 25)
})

test('all workflow adapters normalize IDs before sending paths or tool arguments', async t => {
  const file = join(await directory(t), 'workflow.yaml')
  await writeFile(file, 'version: 3\nnodes: {}\nedges: []\n')
  for (const [action, flags] of [
    ['save-draft', ['--file', file]], ['publish', []], ['rename', ['--name', 'Claims']], ['validate', []],
  ]) {
    const request = await buildRequest(['workflows', action, ' wf ', ...flags])
    assert.equal(request.body.arguments.workflow_id, 'wf')
  }
  assert.equal((await buildRequest(['workflows', 'get', ' wf '])).body.arguments.path, '/workflows/wf')
  assert.equal((await buildRequest(['workflows', 'disable', ' wf '])).path, '/workflows/wf')
  assert.equal((await buildRequest(['workflows', 'validate', ' wf ', '--source', 'draft'])).path, '/workflows/wf/validate')
  await assert.rejects(buildRequest(['workflows', 'publish', ' ../other ']), /single ID/)
})

test('tool calls without sessions report uncertain writes after transport errors and never retry', async t => {
  const file = join(await directory(t), 'args.json')
  await writeFile(file, '{"workflow_id":"wf"}')
  for (const args of [['call', 'gondo_publish_workflow', '--file', file], ['workflows', 'publish', 'wf']]) {
    let calls = 0
    const result = await invoke(args, async () => {
      calls++
      throw new Error('Request timed out')
    })
    assert.equal(calls, 1)
    assert.equal(result.code, 1)
    const error = JSON.parse(result.stderr)
    assert.match(error.recovery, /may have changed state/)
    assert.match(error.recovery, /affected resources/)
    assert.match(error.recovery, /do not repeat/)
  }
})

test('failures before a tool call is sent do not claim an uncertain write', async () => {
  const result = await invoke(['workflows', 'publish', 'wf'], () => assert.fail('must not send'), { env: { GONDO_API_KEY: '' } })
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stderr).recovery, undefined)
})
