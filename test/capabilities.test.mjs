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
      return Response.json({ version: 2, tools: [{ name: 'new_server_tool', inputSchema: { type: 'object' } }] })
    })
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).tools[0].name, 'new_server_tool')
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
