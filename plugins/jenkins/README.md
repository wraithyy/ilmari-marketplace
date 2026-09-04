# ilmari-plugin-jenkins

Jenkins inside an [ilmari](https://github.com/wraithyy/ilmari) workflow.

The point of the `jenkins-build` node: an agent saying "tests pass" is not
evidence. A green build on your real pipeline is. Put the node after the
implement step and the workflow only delivers what Jenkins actually built.

```
implement ──▶ jenkins-build ──▶ deliver
                   │ red
                   └──▶ agent (gets the console tail as {{build.result}})
```

## What it contributes

| Kind | Name | What it does |
|---|---|---|
| node type | `jenkins-build` | Runs a job, waits for it, passes only on `SUCCESS`. On red the step fails with the console tail as its output. |
| trigger | `jenkins` | A finished build starts a task, with the console tail already in the prompt. Webhook or polling. |
| tool | `jenkins_console` | An agent reads any build's status and log itself, optionally grepped. |
| metric source | `jenkins` | One dashboard card per watched job: last result, green ratio over the last 20 builds, average duration. |

Capabilities: **`net`** (Jenkins' REST API over HTTP) and **`secrets`** (its own
API token and webhook secret). No `fs`, no `exec`, no `git` — the plugin never
touches your working copy.

## Setup

1. In Jenkins: user menu → **Configure** → **API Token** → create a token.
2. In ilmari's Plugins screen, fill in this plugin's config (below).
3. Add the `jenkins` trigger to a project in the workflow builder if you want
   failed builds to start tasks, or drop a `jenkins-build` step into a workflow.

### Config

| Field | Env fallback | Meaning |
|---|---|---|
| `baseUrl` | `JENKINS_URL` | Jenkins address, e.g. `https://ci.example.com`. **Everything is inert until this is set.** |
| `user` | `JENKINS_USER` | The Jenkins user the token belongs to; its permissions decide what ilmari can read and build. |
| `apiToken` | `JENKINS_TOKEN` | That user's API token (secret). Not a password. |
| `webhookSecret` | `ILMARI_JENKINS_SECRET` | Secret (secret) for the inbound webhook. Only needed for instant notification; polling works without it. |

Per-project config overrides the global one, so several projects can point at
different Jenkins instances or use different service accounts.

### Job references

Anywhere a job is named, all of these work:

```
my-job                      -> <baseUrl>/job/my-job
folder/sub/my-job           -> <baseUrl>/job/folder/job/sub/job/my-job
job/folder/job/my-job       -> pasted from the browser URL bar
https://ci/job/my-job       -> another instance entirely
```

## `jenkins-build`

| Param | Meaning |
|---|---|
| `job` (required) | Job to run. Templates interpolate, so a branch-parameterized job can take `{{trigger.body.branch}}`. |
| `params` | Build parameters as a JSON object; empty means an unparameterized build. |
| `timeoutMin` | Fail the step after this many minutes, queue time included (default 30). The build keeps running in Jenkins. |
| `allowUnstable` | Count `UNSTABLE` as a pass. Off by default. |
| `logLines` | Console lines attached when the build is not green (default 80, max 500). |

On failure the step sets **both** `reason` (a one-line summary) and `output`
(summary + console tail), because a `catch` or `fallback` branch reads
`{{<nodeId>.result}}`, which is the output. That is how the agent gets the
error text without an extra tool call.

```json
{
  "id": "verify",
  "type": "jenkins-build",
  "job": "cez/dje/crv/crv-fe",
  "params": "{ \"BRANCH\": \"{{branch}}\" }",
  "timeoutMin": 45,
  "catch": "fix-it"
}
```

**This builds whatever Jenkins checks out for that job.** Point it at a job
that builds the task's branch (a parameterized job, or a multibranch job whose
branch exists) or you have verified the wrong code.

## `jenkins` trigger

| Param | Meaning |
|---|---|
| `job` (required) | Job to watch. |
| `event` (required) | `build_failed` \| `build_unstable` \| `build_succeeded` \| `build_finished`. |
| `taskTemplate` | The task text, which is also the agent's prompt. `{{job}}`, `{{number}}`, `{{result}}`, `{{url}}`, `{{log}}`. Empty gives a default that already includes the log. |
| `logLines` | Console lines put into the task (default 80, max 500). |

`build_failed` is `FAILURE` only. An `ABORTED` build was cancelled by a human
and has nothing to fix — use `build_finished` to catch every outcome.

Both delivery routes can be configured at once; a build is only ever acted on
once, and each trigger instance keeps its own cursor.

**Polling** (nothing to configure in Jenkins) checks the job's last completed
build every 60s. On startup it records where each job stands *without firing*,
so restarting `ilmari serve` does not re-run a failure you already fixed. The
flip side: a build that finished while the server was down is never picked up
by polling.

**Webhook** is instant. Set `webhookSecret`, then have Jenkins call
`POST <ilmari>/api/hooks/jenkins` with the secret in the `X-Ilmari-Secret`
header. Two payload shapes are read:

```groovy
// in a pipeline's post block
post {
  always {
    sh """curl -sS -X POST ${ILMARI_URL}/api/hooks/jenkins \
      -H 'X-Ilmari-Secret: ${ILMARI_SECRET}' -H 'Content-Type: application/json' \
      -d '{"job":"${JOB_NAME}","number":${BUILD_NUMBER},"result":"${currentBuild.currentResult}","url":"${BUILD_URL}"}'"""
  }
}
```

or Jenkins' own **Notification** plugin (`{ name, build: { number, phase,
status, full_url } }`) — its `STARTED` phase is ignored. Note the Notification
plugin cannot set a custom header, so with it the secret has to ride in the
body as `"secret"`.

Where the payload carries a URL, the folder path is read back out of it, so a
job inside folders is identified correctly. A payload with only a bare job name
falls back to matching on the last path segment, which can match the wrong job
if two folders hold same-named jobs — configure the full folder path when that
is the case.

## `jenkins_console` tool

| Param | Meaning |
|---|---|
| `job` (required) | Job to read. |
| `build` | A number, or `lastBuild` / `lastCompletedBuild` / `lastFailedBuild` / `lastSuccessfulBuild`. Default `lastBuild`. |
| `lines` | Trailing lines to return (default 200, max 500). |
| `grep` | Case-insensitive regex; only matching lines are returned, and the line limit then applies to the matches. |

Give it to a role with `tools: ["jenkins_console"]`.

## Notes and limits

- **CSRF crumb**: Jenkins accepts an API token instead of a crumb, but
  instances that force the crumb issuer on still reject a bare POST. The
  plugin fetches a crumb when one is offered and ignores a 404.
- **Metric cards need a running server.** `MetricSource.collect()` is handed no
  context by ilmari, so this plugin reaches its config and its job list through
  the `TriggerContext` that `ilmari serve` passes to the trigger's `start()`.
  No cards in a one-off CLI run, and none for jobs that have no trigger
  instance.
- **Trigger cursors are in memory.** An installed plugin cannot reach ilmari's
  kv store; the silent-seeding rule above is what makes a restart harmless.
- Search the source for `ponytail:` to find every deliberate shortcut.

## Development

This plugin lives inside the catalog repository rather than in its own, so its
catalog entry points at `ilmari-marketplace` with
`"entry": "plugins/jenkins/dist/index.js"`.

`ilmari-plugin-kit` is not published to npm yet, so the devDependency points at
a local checkout of ilmari, expected as a sibling of the catalog checkout:

```sh
git clone https://github.com/wraithyy/ilmari.git ../../../ilmari
cd plugins/jenkins
npm install
npm test          # node --test, no framework
npm run typecheck
npm run build     # dist/index.js — commit it, ilmari never builds a plugin
```

`dist/index.js` is committed on purpose. ilmari installs a plugin by cloning
its repository at the newest `vX.Y.Z` tag and running
`npm ci --ignore-scripts --omit=dev` — skipped entirely here, since this
plugin declares no runtime dependencies.

Because the repository is shared, so is the tag: **every** plugin hosted in
this repository installs at the catalog's newest `v*` tag, and shipping a fix
to one of them means tagging the catalog again. A plugin that needs to release
on its own cadence belongs in its own repository.

Keep the plugin one file, and keep every field of the exported object a plain
literal. ilmari's install step reads name, version, capabilities, config and
node-type params out of the source text without executing it, and it drops any
entry with a computed field — a `description` written as `"a" + "b"` is enough
to make the node type invisible in the Builder.

## License

Apache-2.0
