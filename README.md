# Gondo CLI

Give a coding agent access to [Gondo](https://www.gondo.ai) to create employees, build and test their jobs, and inspect results. The CLI calls Gondo's HTTP API and loads its current authoring guide from the service.

Requires **Node.js 22.12 or later** and a Gondo API key. API access is currently a private trial for allowlisted accounts with Pro, an active Pro trial, or complimentary Pro. Installing the CLI does not enable API access.

## Get started

1. In Gondo, open **Account → API keys** and create a key. This requires an account admin. The key is all your agent needs.
2. Save the key in a local file called `gondo.env`, outside your source repository:

   ```dotenv
   GONDO_API_KEY=your-api-key
   ```

3. From any directory, read the guide:

   ```bash
   npx --yes gondo --env-file /absolute/path/to/gondo.env guide
   ```

No Gondo app checkout is needed. To install a persistent `gondo` command instead:

```bash
npm install --global gondo
gondo --env-file /absolute/path/to/gondo.env guide
```

`--env-file` accepts dotenv syntax, including quoted values. Existing environment variables take precedence over the file. If `GONDO_API_KEY` is already set in your agent's environment, omit the flag. The CLI never loads an env file implicitly. It connects to `https://runtime.gondo.ai` and discovers the account belonging to your key automatically. For development, set `GONDO_API_URL` to another runtime; `GONDO_ACCOUNT_ID` remains an optional override for existing setups. Overrides do not change which account a key can access.

Keep the key out of prompts, source control, and shared logs. Give your agent the local env-file path, not the key text. Required integrations must already be connected or enabled in Gondo; enable Public browsing for public websites.

## Give this to your agent

Use a coding agent with terminal access, such as Codex or Claude Code. Replace the task and local file path:

> Use Gondo to build an employee that **[describe the task]**. Your credentials are in **[/absolute/path/to/gondo.env]**; do not print them. Start by running `npx --yes gondo --env-file /absolute/path/to/gondo.env guide`. Read the workflow and node guides as directed, then inspect the available integrations. Create a new employee and job, validate it, test with **[agreed inputs]**, and inspect the actual run output. Publish the new job while leaving it disabled for my review. Do not change existing jobs or send messages unless my task explicitly requires it. Report the employee and job IDs and the test results.

Commands shown as `gondo …` in the served guide can all be run as `npx --yes gondo --env-file /absolute/path/to/gondo.env …`. If an older guide mentions `pnpm gondo` or the app checkout, use this npm command instead.

## Useful commands

After a global install, with credentials in `gondo.env`:

```bash
gondo --env-file ./gondo.env guide --topic workflows
gondo --env-file ./gondo.env guide --topic nodes
gondo --env-file ./gondo.env list /integrations
gondo --env-file ./gondo.env employees list
gondo --env-file ./gondo.env workflows list
gondo --help
gondo --version
```

The command name remains `workflows`; Gondo calls them jobs in the app. The guide documents authoring, execution, file upload/download, resumable workspaces, browser login handoffs, and run inspection. Human approvals are completed by a signed-in person in Gondo.

API responses are JSON. Exit codes: **0** success, **1** failure, **2** user action required. Tests and investigation code execute real actions through your connected integrations. The CLI does not retry mutations automatically; inspect the run or execution after a timeout before trying again.

## Development and publishing

The service must support `GET /api/operator/me` before publishing this key-only CLI release. That endpoint authenticates the key and returns its account; the existing allowlist and Pro requirements still apply.

This repository owns the standalone CLI. Workflow schemas, authoring guides, and authorization remain in the Gondo service. The initial client was extracted from the app's existing operator CLI; it has one runtime dependency and no build step.

```bash
npm ci
npm test
```

Tests exercise the packed npm artifact installed in a separate temporary directory, including its executable, env-file loading, HTTP authentication, and YAML requests. No Gondo credentials or live account are required.

To publish the prepared `0.1.0` release from this repository:

```bash
npm login
npm whoami
npm pack --dry-run
npm publish --access public
```

Publishing runs the tests again. Complete npm's authentication/2FA prompt when requested. Then verify the registry install from any other directory:

```bash
npx --yes gondo@0.1.0 --version
npx --yes gondo@0.1.0 --env-file /absolute/path/to/gondo.env guide
```

`0.1.0` is prepared for its first publication; it is not published by creating or pushing this repository. The npm name was unregistered when checked, but the registry makes the final availability decision at publish time. Future releases need a new version number. The package is public with no open-source license grant (`UNLICENSED`).

## Connection setup and API-key scopes

All keys have `operator` access. In Account → API keys, admins can additionally select **Manage integrations** (`integrations:manage`) when creating a key. Existing keys do not gain this permission automatically; create a replacement and revoke the old key to change permissions. Ordinary keys can already use connected APIs, including writes; this additional scope controls connection setup, not provider API permissions. Keys cannot grant scopes or approve human reviews.

```sh
gondo integrations providers
gondo integrations provider clio
gondo integrations create --provider clio --name "Demo Clio"
gondo integrations credentials <id> --file ./private-credentials.json --variant <variant>
gondo integrations test <id>
gondo integrations enable <id>
```

Only prebuilt providers with supplied credentials are supported. Credential JSON/YAML must match the displayed schema; `--file -` reads stdin. Do not pass secret values as arguments. Connections start disabled, and enablement is explicit. Failed checks preserve previous credentials. `checked: false` means no provider check was available. Use `integrations list|get <id>`, `disable <id>`, or `update <id> --file settings.json` (fields: `label`, `maxScope`, `enabledToolsets`, `disabledTools`). Provider metadata lists valid tool names; `maxScope` accepts `read`, `write`, `admin`. These settings govern named tools, not direct API code.

## Webhooks and workflow documents

```sh
gondo workflows webhook get <workflow-id>
gondo workflows webhook configure <workflow-id> --output ./private-webhook.json
gondo attempts files list <attempt-id>
gondo attempts files download <attempt-id> <artifact-id> --output-dir ./outputs
```

Webhook configuration requires a new private output file and never prints its secret. Repeating `configure` preserves existing credentials; explicitly use `rotate-secret` with another output file to replace a lost secret. Trigger the returned URL with curl using its `headerName` and `secret`, then inspect runs. No mutations are automatically retried.

Workflow downloads target an attempt, not a CLI workspace session. Downloads refuse unsafe filenames or overwrites, remove partial files, verify available size/checksum metadata and cap files without size metadata at 512 MiB. Storage requests never carry the Gondo API key.

Deploy the backend API-key scope migration and matching runtime before releasing this CLI. No SharePoint file-transfer changes are part of this release.
