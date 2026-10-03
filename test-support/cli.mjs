import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../src/cli.mjs'

export function createRunner(defaultEnv) {
  return async (args, fetchImpl, { env = {}, stdin } = {}) => {
    let stdout = ''; let stderr = ''
    const code = await runCli(args, {
      env: { ...defaultEnv, ...env }, fetchImpl, stdin,
      stdout: { write: value => { stdout += value } },
      stderr: { write: value => { stderr += value } },
    })
    return { code, stdout, stderr }
  }
}

export async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'gondo-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
