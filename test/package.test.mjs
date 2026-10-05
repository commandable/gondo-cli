import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

test('the published artifact works without an app checkout', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gondo-package-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const { stdout } = await exec(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: root })
  const [packed] = JSON.parse(stdout)
  assert.equal(packed.name, '@gondoai/cli')
  assert.deepEqual(packed.files.map(file => file.path).sort(), [
    'README.md', 'bin/gondo.mjs', 'gondo.env.example', 'package.json', 'src/cli.mjs',
  ])
  await exec(npm, ['install', '--prefix', directory, '--prefer-offline', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed.filename)])

  // Exercise the npm-created executable, including its symlink on Unix.
  const bin = process.platform === 'win32'
    ? join(directory, 'node_modules/@gondoai/cli/bin/gondo.mjs')
    : join(directory, 'node_modules/.bin/gondo')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GONDO_')))
  const invoke = (args, extraEnv = {}) => exec(process.execPath, [bin, ...args], { cwd: directory, env: { ...env, ...extraEnv } })

  await t.test('help and version work before configuration', async () => {
    assert.match((await invoke(['--help'])).stdout, /gondo --env-file/)
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.equal((await invoke(['--version'])).stdout.trim(), version)
    const installed = await exec(npm, ['exec', '--offline', '--', '@gondoai/cli', '--version'], { cwd: directory, env })
    assert.equal(installed.stdout.trim(), version)
  })

  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(request.url === '/api/operator/me'
      ? { accountId: 'trial-account' }
      : { ok: true, guide: 'Read the workflow and node guides.' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const base = `http://127.0.0.1:${server.address().port}`
  await writeFile(join(directory, 'gondo.env'), `GONDO_API_URL=${base}\nGONDO_API_KEY="fake-test-key"\n`, { mode: 0o600 })

  await t.test('an env file configures an authenticated guide request', async () => {
    const result = await invoke(['--env-file', './gondo.env', 'guide'])
    assert.equal(JSON.parse(result.stdout).ok, true)
    assert.deepEqual(requests[0], {
      url: '/api/operator/me', method: 'GET', authorization: 'Bearer fake-test-key', body: undefined,
    })
    assert.deepEqual(requests.at(-1), {
      url: '/api/accounts/trial-account/operator/guide?topic=overview', method: 'GET',
      authorization: 'Bearer fake-test-key', body: undefined,
    })
    assert.equal(result.stderr, '')
  })

  await t.test('the environment overrides file values', async () => {
    await invoke(['guide', '--env-file', './gondo.env'], { GONDO_ACCOUNT_ID: 'environment-account' })
    assert.match(requests.at(-1).url, /\/accounts\/environment-account\//)
  })

  await t.test('the installed YAML dependency supports employee creation', async () => {
    await writeFile(join(directory, 'employee.yaml'), 'name: Trial employee\nrole: Researcher\nallowedIntegrationRefs: []\n')
    await invoke(['--env-file', './gondo.env', 'employees', 'create', '--file', 'employee.yaml'])
    assert.deepEqual(requests.at(-1), {
      url: '/api/accounts/trial-account/employees', method: 'POST', authorization: 'Bearer fake-test-key',
      body: { name: 'Trial employee', role: 'Researcher', allowedIntegrationRefs: [] },
    })
  })

  await t.test('missing configuration and missing env files fail clearly', async () => {
    await assert.rejects(invoke(['guide']), error => error.code === 1 && /GONDO_API_KEY is required/.test(error.stderr))
    // Node versions that pre-read --env-file can fail before the CLI starts.
    await assert.rejects(invoke(['--env-file', './absent.env', 'guide']), error => [1, 9].includes(error.code) && /ENOENT|not found/.test(error.stderr))
  })
})
