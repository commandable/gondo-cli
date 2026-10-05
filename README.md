# Gondo CLI

Use Gondo Admin capabilities from a coding agent or terminal. Requires Node.js 22.12+, a Gondo account with Pro access, and an API key created by an account admin.

## Start

Save `GONDO_API_KEY=…` in a private `gondo.env` file outside source control, then run:

```sh
npx --yes @gondoai/cli@0.2.0 --env-file /absolute/path/gondo.env guide
```

The key identifies its account automatically. Optional `GONDO_API_URL` and `GONDO_ACCOUNT_ID` overrides support development. Environment variables override the explicitly selected env file. Never paste credentials into prompts or command arguments.

## Shared capabilities

```sh
npx --yes @gondoai/cli@0.2.0 --env-file /absolute/path/gondo.env tools list
npx --yes @gondoai/cli@0.2.0 --env-file /absolute/path/gondo.env tools describe gondo_upsert_workflow_node
npx --yes @gondoai/cli@0.2.0 --env-file /absolute/path/gondo.env call gondo_upsert_workflow_node --file arguments.json
npx --yes @gondoai/cli@0.2.0 --env-file /absolute/path/gondo.env call load_skill --file skill.json --session os_existing
npx --yes @gondoai/cli@0.2.0 --env-file /absolute/path/gondo.env workflows get <id> --source active --format json
npx --yes @gondoai/cli@0.2.0 --help
```

The server supplies Admin's existing guides, tool names, descriptions and schemas. The CLI contains no separate authoring manual. `guide --topic workflows` returns the authoritative workflow bundle. Convenience commands adapt to the same operations. Workflow reads return one definition; use `--editor-state` explicitly for the complete editor state.

Use the host's native web search, delegation and authorization. The catalog preserves Admin's `requireConfirmation` flag; the host applies its authorization policy before invocation, including authorization already given by the user. Required workflow human reviews and login stay in signed-in Gondo; interactive calls return action links. File tools return session artifacts; download inspection images and view them in the host before making visual claims.

Integration management requires `integrations:manage`. Creation follows Admin defaults. Change availability explicitly with `integrations enable|disable <id>`. Submit credentials using `integrations credentials <id> --file <private-file>` or stdin. Credential replacement never implicitly enables a connection. Custom API, custom-tool and browser management are available through the shared catalog.

Responses are JSON. Exit codes: **0** success, **1** failure, **2** action required. Mutations are never automatically retried. After an uncertain write, inspect its run or execution before proceeding. Existing session, binary transfer, private webhook output and attempt download commands remain available through `--help`.

## Development and release

```sh
npm ci
npm test
npm pack --dry-run
```

Tests include an installed packed artifact, authenticated HTTP transport, server capability-version checks, private credential files and binary downloads.

**Deploy the paired app release exposing capability protocol version 2 before publishing CLI 0.2.0.** This release requires `/operator/tools` and the shared `/operator/guide`; discovery on an older server fails clearly without falling back to stale instructions. This is the initial supported CLI contract; older CLI releases are not supported.

The [shared implementation brief](https://github.com/commandable/commandable-app-v1/blob/main/docs/unified-authoring.md) documents the paired app change and verification.

After that deployment, an authorized npm maintainer can publish with `npm publish --access public`. Creating or merging these PRs does not itself publish the npm package.
