import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs, parseEnv } from 'node:util'
import packageJson from '../package.json' with { type: 'json' }
import { parseDocument } from 'yaml'

export const HELP = `Gondo account operator CLI

Configure GONDO_API_URL (runtime URL), GONDO_ACCOUNT_ID, GONDO_API_KEY.
Load a local env file with: gondo --env-file ./gondo.env guide
Use gondo --version to show the installed CLI version.
Account admins create keys in Account Settings. Never put a key in source code.

gondo guide [--topic overview|workflows|nodes]
gondo list [namespace-path] [--limit 25]
gondo read <namespace-path>
gondo employees list|get <id>|create --file employee.yaml|update <id> --file changes.json|delete <id>
gondo workflows list|get <id>|create --employee <id> --name <name>
gondo workflows save-draft <id> --file workflow.yaml
gondo workflows validate <id> [--file workflow.yaml] [--source draft|published]
gondo workflows export <id> [--source active|draft|published] [--output workflow.yaml]
gondo workflows publish|enable|disable|discard-draft|delete <id>
gondo workflows rename <id> --name <name>
gondo runs list|get|attempts|events|definition|cancel <run-id>
gondo attempts get|events|definition|cancel <attempt-id>
gondo runs test|start <workflow-id> [--input input.json]
gondo exec --file investigate.js --integrations ref_one,ref_two [--session <id>] [--attach <path> ...] [--output-dir <dir>]
gondo sessions create|list|get <id>|close <id>
gondo files list <session-id>|upload <session-id> --file <path>
gondo files download <file-id> --session <id> --output-dir <dir>
gondo executions get <execution-id> --session <id>
gondo browser restart <session-id> --integration <ref>

Requires Pro, including active Pro trials. Responses are JSON. Exit 0: success; 1: failure; 2: user action required.
Workspaces retain files for 24h inactivity. Browsers expire after 10m idle / 30m total.
Login links are included in JSON. Login never reruns code. Use exec --session for the next explicit call.
Tests and code execute real external actions. No mutations are retried automatically.
Run commands follow the current attempt; attempts commands target a specific execution. A timeout does not imply no writes occurred.
`

const options = {
  'env-file': { type: 'string' },
  'version': { type: 'boolean', short: 'v' },
  'file': { type: 'string' },
  'session': { type: 'string' },
  'attach': { type: 'string', multiple: true },
  'output-dir': { type: 'string' },
  'integration': { type: 'string' },
  'input': { type: 'string' },
  'output': { type: 'string' },
  'employee': { type: 'string' },
  'name': { type: 'string' },
  'integrations': { type: 'string' },
  'source': { type: 'string' },
  'topic': { type: 'string' },
  'limit': { type: 'string' },
  'help': { type: 'boolean', short: 'h' },
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} is required. Use --help for examples.`)

  return value.trim()
}

function segment(value, label = 'ID') {
  const result = required(value, label)

  if (result === '.' || result === '..' || result.includes('/'))
    throw new Error(`${label} must be a single ID`)

  return encodeURIComponent(result)
}

async function readStructured(file) {
  const source = await readFile(required(file, '--file or --input'), 'utf8')

  if (file.toLowerCase().endsWith('.json'))
    return JSON.parse(source)

  const document = parseDocument(source, { uniqueKeys: true, schema: 'core', merge: false })

  if (document.errors.length)
    throw new Error(document.errors.map(error => error.message).join('\n'))

  return document.toJS({ maxAliasCount: 0 })
}

async function definitionBody(file) {
  required(file, '--file')

  if (file.toLowerCase().endsWith('.json'))
    return { definition: await readStructured(file) }

  // Keep YAML text intact so the server's canonical parser checks it.
  return { definitionYaml: await readFile(file, 'utf8') }
}

export async function buildRequest(argv) {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true })

  if (values.version)
    return { version: true }

  if (values.help || !positionals.length)
    return { help: true }

  const [command, action, id] = positionals

  const request = { method: 'GET', path: '', query: {}, body: undefined, output: values.output, ...(values['env-file'] ? { envFile: values['env-file'] } : {}) }

  if (command === 'guide') {
    request.path = '/operator/guide'

    request.query.topic = values.topic ?? 'overview'
  }
  else if (command === 'list' || command === 'read') {
    request.path = '/operator/resources'

    request.query = { action: command, path: command === 'read' ? required(action, 'namespace path') : action ?? '/' }

    if (values.limit)
      request.query.limit = values.limit
  }
  else if (command === 'exec') {
    request.path = '/code/execute'

    request.method = 'POST'

    request.body = {
      code: await readFile(required(values.file, '--file'), 'utf8'),
      integrations: values.integrations?.split(',').map(ref => ref.trim()).filter(Boolean) ?? [],
      ...(values.session ? { sessionId: values.session } : {}),
    }
  }
  else if (command === 'sessions' || command === 'session') {
    if (action === 'create' || action === 'list') {
      request.path = '/code/sessions'

      request.method = action === 'create' ? 'POST' : 'GET'
    }
    else if (action === 'get' || action === 'close') {
      request.path = `/code/sessions/${segment(id)}${action === 'close' ? '/close' : ''}`

      request.method = action === 'close' ? 'POST' : 'GET'
    }
  }
  else if (command === 'files') {
    const sessionId = action === 'download' ? required(values.session, '--session') : required(id, 'session ID')

    request.path = `/code/sessions/${segment(sessionId)}/files`

    if (action === 'upload') {
      request.method = 'POST'
      request.upload = required(values.file, '--file')
    }
    else if (action === 'download') {
      request.path += `/${segment(id)}`

      request.download = { sessionId, fileId: id, directory: required(values['output-dir'], '--output-dir') }
    }
    else if (action !== 'list') {
      request.path = ''
    }
  }
  else if (command === 'executions' && action === 'get') {
    request.path = `/code/sessions/${segment(values.session, '--session')}/executions/${segment(id)}`
  }
  else if (command === 'browser' && action === 'restart') {
    request.path = `/code/sessions/${segment(id)}/browser/restart`

    request.method = 'POST'

    request.body = { integration: required(values.integration, '--integration') }
  }
  else if (command === 'employees') {
    if (action === 'list') {
      request.path = '/employees'
    }
    else if (action === 'create') {
      request.path = '/employees'

      request.method = 'POST'

      request.body = await readStructured(values.file)
    }
    else if (['get', 'update', 'delete'].includes(action)) {
      request.path = `/employees/${segment(id)}`

      request.method = { get: 'GET', update: 'PATCH', delete: 'DELETE' }[action]

      if (action === 'update')
        request.body = await readStructured(values.file)
    }
  }
  else if (command === 'workflows') {
    if (action === 'list') {
      request.path = '/workflows'
    }
    else if (action === 'create') {
      request.path = '/workflows'

      request.method = 'POST'

      request.body = { employeeId: required(values.employee, '--employee'), name: required(values.name, '--name') }
    }
    else {
      const base = `/workflows/${segment(id)}`

      const routes = {
        'get': ['GET', '/editor'],
        'save-draft': ['PUT', '/draft'],
        'discard-draft': ['DELETE', '/draft'],
        'validate': ['POST', '/validate'],
        'export': ['POST', '/yaml'],
        'publish': ['POST', '/publish'],
        'enable': ['PATCH', ''],
        'disable': ['PATCH', ''],
        'rename': ['PATCH', ''],
        'delete': ['DELETE', ''],
      }

      const route = routes[action]

      if (route) {
        request.method = route[0]

        request.path = `${base}${route[1]}`

        if (action === 'save-draft')
          request.body = await definitionBody(values.file)

        if (action === 'validate')
          request.body = { source: values.source ?? 'draft', ...(values.file ? await definitionBody(values.file) : {}) }

        if (action === 'export')
          request.body = { source: values.source ?? 'active' }

        if (action === 'publish')
          request.body = {}

        if (action === 'enable' || action === 'disable')
          request.body = { enabled: action === 'enable' }

        if (action === 'rename')
          request.body = { name: required(values.name, '--name') }
      }
    }
  }
  else if (command === 'runs') {
    if (action === 'list') {
      request.path = '/runs'

      if (values.limit)
        request.query.limit = values.limit
    }
    else if (action === 'test' || action === 'start') {
      request.path = '/runs'

      request.method = 'POST'

      request.body = {
        workflowId: required(id, 'workflow ID'),
        useDraft: action === 'test',
        startAsync: true,
        triggerData: values.input ? await readStructured(values.input) : {},
      }
    }
    else if (action === 'get' || action === 'attempts') {
      request.path = `/runs/${segment(id)}${action === 'get' ? '' : '/attempts'}`
    }
    else if (['events', 'definition', 'cancel'].includes(action)) {
      request.path = `/runs/${segment(id)}`

      request.resolveAttemptAction = action
    }
  }
  else if (command === 'attempts' && ['get', 'events', 'definition', 'cancel'].includes(action)) {
    request.path = `/run-attempts/${segment(id)}${action === 'get' ? '' : `/${action}`}`

    if (action === 'cancel')
      request.method = 'POST'
  }

  if (!request.path)
    throw new Error('Unknown command. Use --help for supported commands.')

  const maxPositionals = ['guide', 'exec'].includes(command) ? 1 : ['list', 'read'].includes(command) ? 2 : 3

  if (positionals.length > maxPositionals)
    throw new Error('Unexpected positional argument. Use --help for command syntax.')

  if (command === 'exec' && values.attach?.length)
    request.attach = values.attach

  if (command === 'exec' && values['output-dir'])
    request.outputDir = values['output-dir']

  return request
}

// Reject separators and control characters before creating any local file.
// eslint-disable-next-line no-control-regex
const UNSAFE_DOWNLOAD_NAME = /[\\/\x00-\x1F\x7F]/
const WINDOWS_FILENAME_CHARS = /[<>:"|?*]/g

export function safeDownloadName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || UNSAFE_DOWNLOAD_NAME.test(name))
    throw new Error('Unsafe output filename')

  return name.replace(WINDOWS_FILENAME_CHARS, '_')
}

export async function runCli(argv, { env = process.env, fetchImpl = fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  let recovery
  let request
  try {
    request = await buildRequest(argv)

    if (request.version) {
      stdout.write(`${packageJson.version}\n`)

      return 0
    }

    if (request.help) {
      stdout.write(HELP)

      return 0
    }

    if (request.envFile)
      env = { ...parseEnv(await readFile(request.envFile, 'utf8')), ...env }

    const base = new URL(required(env.GONDO_API_URL, 'GONDO_API_URL'))

    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
      throw new Error('GONDO_API_URL must use HTTPS, or HTTP on localhost for development')

    if (base.username || base.password || base.search || base.hash)
      throw new Error('GONDO_API_URL must not include credentials, a query, or a fragment')

    const account = segment(env.GONDO_ACCOUNT_ID, 'GONDO_ACCOUNT_ID')

    const key = required(env.GONDO_API_KEY, 'GONDO_API_KEY')

    const send = async (next) => {
      const url = new URL(`/api/accounts/${account}${next.path}`, base)

      for (const [name, value] of Object.entries(next.query ?? {}))
        url.searchParams.set(name, value)

      let uploadStream

      let uploadHeaders = {}

      if (next.upload) {
        const size = (await stat(next.upload)).size

        if (!(await stat(next.upload)).isFile())
          throw new Error('Only regular files can be uploaded')

        uploadStream = createReadStream(next.upload)

        uploadHeaders = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'X-File-Name': encodeURIComponent(basename(next.upload)) }
      }

      let response

      try {
        response = await fetchImpl(url, {
          method: next.method,
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...uploadHeaders },
          ...(uploadStream ? { body: uploadStream, duplex: 'half' } : next.body !== undefined ? { body: JSON.stringify(next.body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(120000),
        })
      }
      finally {
        uploadStream?.destroy()
      }

      if (next.binary && response.ok)
        return { response }

      const text = (await response.text()).replaceAll(key, '[REDACTED]')

      let result

      try {
        result = text ? JSON.parse(text) : null
      }
      catch {
        throw new Error(`Runtime returned non-JSON (HTTP ${response.status}). Check GONDO_API_URL points to the runtime.`)
      }

      return { response, result }
    }

    const failed = ({ response, result }) => {
      if (response.ok && result?.success !== false && result?.ok !== false)
        return false

      stderr.write(`${JSON.stringify({ status: response.status, ...result })}\n`)

      return true
    }

    const download = async (sessionId, file, directory) => {
      const name = safeDownloadName(file.name)

      await mkdir(directory, { recursive: true })

      const target = resolve(directory, name)

      // Exclusive creation also rejects an existing symlink. Never overwrite an earlier output.
      const handle = await open(target, 'wx', 0o600)

      let done = false

      try {
        const received = await send({ path: `/code/sessions/${segment(sessionId)}/files/${segment(file.id)}`, method: 'GET', binary: true })

        if (!received.response.ok)
          throw new Error(`File download failed (HTTP ${received.response.status})`)

        const hash = createHash('sha256')

        let size = 0

        const check = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length

          if (size > file.sizeBytes)
            return callback(new Error('Download exceeded its declared size'))

          hash.update(chunk)
          callback(null, chunk)
        } })

        await pipeline(Readable.fromWeb(received.response.body), check, handle.createWriteStream())

        if (size !== file.sizeBytes || (file.sha256 && hash.digest('hex') !== file.sha256))
          throw new Error('Downloaded file failed integrity verification')

        done = true

        return { fileId: file.id, savedTo: target }
      }
      finally {
        await handle.close()
        if (!done) {
          await unlink(target).catch(() => {
          })
        }
      }
    }

    if (request.download) {
      const d = request.download

      const listing = await send({ path: `/code/sessions/${segment(d.sessionId)}/files`, method: 'GET' })

      if (failed(listing))
        return 1

      const file = listing.result.files.find(f => f.id === d.fileId)

      if (!file)
        throw new Error('File not found in this session')

      stdout.write(`${JSON.stringify(await download(d.sessionId, file, d.directory))}\n`)

      return 0
    }

    if (request.attach?.length) {
      if (!request.body.sessionId) {
        const created = await send({ path: '/code/sessions', method: 'POST' })

        if (failed(created))
          return 1

        request.body.sessionId = created.result.id
      }

      request.body.fileIds = []

      for (const file of request.attach) {
        const uploaded = await send({ path: `/code/sessions/${segment(request.body.sessionId)}/files`, method: 'POST', upload: file })

        if (failed(uploaded))
          return 1

        request.body.fileIds.push(uploaded.result.id)
      }
    }

    let received = await send(request)
    if (request.path === '/code/execute')
      recovery = { sessionId: received.result?.sessionId, executionId: received.result?.executionId }

    if (request.outputDir && received.result?.files?.length) {
      received.result.downloads = []

      for (const file of received.result.files) {
        if (file.executionId !== received.result.executionId)
          throw new Error('Runtime returned an output from a different execution')

        received.result.downloads.push(await download(received.result.sessionId, file, request.outputDir))
      }
    }

    if (received.result?.requiredAction) {
      stdout.write(`${JSON.stringify(received.result, null, 2)}\n`)

      return 2
    }

    if (failed(received))
      return 1

    if (request.resolveAttemptAction) {
      // Resolve once, then pin this operation to that execution even if a retry
      // becomes current in the meantime. Never retry cancellation automatically.
      const attemptId = segment(received.result?.currentAttemptId, 'current attempt ID')

      received = await send({
        path: `/run-attempts/${attemptId}/${request.resolveAttemptAction}`,
        method: request.resolveAttemptAction === 'cancel' ? 'POST' : 'GET',
      })

      if (failed(received))
        return 1
    }

    const { result } = received

    if (request.output) {
      const content = typeof result?.yaml === 'string' ? result.yaml : `${JSON.stringify(result, null, 2)}\n`

      await writeFile(request.output, content, { encoding: 'utf8', mode: 0o600 })

      stdout.write(`${JSON.stringify({ savedTo: resolve(request.output) })}\n`)
    }
    else {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    }

    return 0
  }
  catch (error) {
    // Do not dump request objects, environment variables, or authorization headers.
    const message = error instanceof Error ? error.message : 'Command failed'

    const key = env.GONDO_API_KEY

    stderr.write(`${JSON.stringify({ error: key ? message.replaceAll(key, '[REDACTED]') : message, ...(request?.path === '/code/execute' ? { sessionId: request.body?.sessionId, ...recovery, recovery: 'Inspect the session and execution before continuing; do not repeat this execution automatically.' } : {}) })}\n`)

    return 1
  }
}
