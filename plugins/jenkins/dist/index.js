/**
 * ilmari-plugin-jenkins — Jenkins inside an ilmari workflow.
 *
 * Four surfaces:
 *   - node type `jenkins-build`: run a job, wait for it, pass only on SUCCESS.
 *     Real CI evidence for a verification step instead of the agent's word.
 *   - trigger `jenkins`: a failed build starts a task, with the console tail
 *     already in the prompt. Fires from a webhook or from polling.
 *   - tool `jenkins_console`: an agent reads a build's status and log itself.
 *   - metric source `jenkins`: one dashboard card per configured job.
 *
 * Written against ilmari-plugin-kit's types only — nothing from ilmari's core
 * is importable from an installed plugin, so the few helpers core would have
 * given us (a timing-safe compare, a template renderer) are inlined below.
 *
 * The plugin object is one literal on purpose: ilmari's install step reads
 * name/version/capabilities/config/nodeTypes out of the source text without
 * executing it (plugin-static.ts), and only plain literals survive that read.
 * Hoisting any of those into a `const` would make the plugin show up as
 * "unparseable" on the Plugins screen.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
const PLUGIN = "jenkins";
const HTTP_TIMEOUT_MS = 30_000;
const BUILD_POLL_MS = 5_000;
const TRIGGER_POLL_MS = 60_000;
const DEFAULT_TIMEOUT_MIN = 30;
const DEFAULT_LOG_LINES = 80;
const DEFAULT_TOOL_LINES = 200;
const MAX_LOG_LINES = 500;
/** How many recent builds the metric card's green ratio is computed over. */
const METRIC_WINDOW = 20;
/** Null when no base URL is set — the plugin then stays inert rather than
 *  guessing at a Jenkins address. */
function config(read, project) {
    const c = read(PLUGIN, project);
    const baseUrl = String(c.baseUrl ?? "")
        .trim()
        .replace(/\/+$/, "");
    if (!baseUrl)
        return null;
    return {
        baseUrl,
        ...(c.user ? { user: c.user } : {}),
        ...(c.apiToken ? { apiToken: c.apiToken } : {}),
        ...(c.webhookSecret ? { webhookSecret: c.webhookSecret } : {}),
    };
}
/* ---------- small helpers core would otherwise provide ---------- */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secretEquals = (given, expected) => {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};
/** `{{key}}` substitution, matching what core does to workflow templates.
 *  Unknown keys become empty rather than staying literal, so a typo fails the
 *  step loudly instead of sending `{{jbo}}` to Jenkins as a job name. */
export const render = (template, vars) => template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => vars[key] ?? "");
export function tail(text, lines) {
    const n = Math.max(1, Math.min(Math.floor(lines) || DEFAULT_LOG_LINES, MAX_LOG_LINES));
    const all = text.split(/\r?\n/);
    return all.length <= n ? text : all.slice(-n).join("\n");
}
/* ---------- Jenkins REST ---------- */
/**
 * A job reference becomes a URL. Accepted forms:
 *   "my-job"                  -> <base>/job/my-job
 *   "folder/sub/my-job"       -> <base>/job/folder/job/sub/job/my-job
 *   "job/folder/job/my-job"   -> <base>/job/folder/job/my-job  (pasted path)
 *   "https://ci/job/my-job"   -> used as-is
 */
export function jobUrl(baseUrl, job) {
    const j = job.trim().replace(/^\/+|\/+$/g, "");
    if (/^https?:\/\//i.test(j))
        return j.replace(/\/+$/, "");
    if (j.startsWith("job/"))
        return `${baseUrl}/${j}`;
    const path = j
        .split("/")
        .filter(Boolean)
        .map((segment) => `job/${encodeURIComponent(segment)}`)
        .join("/");
    return `${baseUrl}/${path}`;
}
async function req(c, url, init = {}) {
    const headers = new Headers(init.headers);
    if (c.user && c.apiToken) {
        const basic = Buffer.from(`${c.user}:${c.apiToken}`).toString("base64");
        headers.set("authorization", `Basic ${basic}`);
    }
    const res = await fetch(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status} ${body}`);
    }
    return res;
}
const json = async (c, url) => (await req(c, url)).json();
/**
 * Jenkins accepts an API token in place of a CSRF crumb, but instances that
 * force the crumb issuer on (or sit behind a proxy that drops the token's
 * exemption) still reject a bare POST. Fetch a crumb when one is offered; a
 * 404 means the issuer is disabled and the POST goes through as-is.
 */
async function crumbHeader(c) {
    try {
        const issued = await json(c, `${c.baseUrl}/crumbIssuer/api/json`);
        return issued.crumbRequestField && issued.crumb
            ? { [issued.crumbRequestField]: issued.crumb }
            : {};
    }
    catch {
        return {};
    }
}
/** Queues a build; returns the queue item URL from the Location header. */
async function startBuild(c, job, buildParams) {
    const parameterized = Object.keys(buildParams).length > 0;
    const url = `${jobUrl(c.baseUrl, job)}/${parameterized ? "buildWithParameters" : "build"}`;
    const res = await req(c, url, {
        method: "POST",
        headers: {
            ...(await crumbHeader(c)),
            ...(parameterized ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(parameterized ? { body: new URLSearchParams(buildParams).toString() } : {}),
    });
    const location = res.headers.get("location");
    if (!location)
        throw new Error(`${url} returned no queue Location header (status ${res.status})`);
    return location.replace(/\/+$/, "");
}
/** Waits for the queue item to be assigned an executor, then reports the build. */
async function awaitQueue(c, queueUrl, deadline) {
    for (;;) {
        const item = await json(c, `${queueUrl}/api/json`);
        if (item.cancelled) {
            throw new Error(`queued build was cancelled${item.why ? `: ${item.why}` : ""}`);
        }
        const number = item.executable?.number;
        const url = item.executable?.url;
        if (number && url)
            return { number, url: url.replace(/\/+$/, "") };
        if (Date.now() > deadline) {
            throw new Error(`still queued after the timeout${item.why ? ` (${item.why})` : ""}`);
        }
        await sleep(BUILD_POLL_MS);
    }
}
const BUILD_TREE = "number,building,result,url,duration,displayName";
async function awaitBuild(c, buildUrl, deadline) {
    for (;;) {
        const build = await json(c, `${buildUrl}/api/json?tree=${BUILD_TREE}`);
        if (!build.building && build.result)
            return build;
        if (Date.now() > deadline)
            throw new Error(`build ${buildUrl} still running after the timeout`);
        await sleep(BUILD_POLL_MS);
    }
}
const consoleText = async (c, buildUrl) => (await req(c, `${buildUrl}/consoleText`)).text();
/** Job path out of a Jenkins URL: ".../job/folder/job/my-job/12/" -> "folder/my-job". */
export function jobFromUrl(url) {
    const parts = url.split("/").filter(Boolean);
    const segments = [];
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] === "job")
            segments.push(decodeURIComponent(parts[i + 1]));
    }
    return segments.join("/");
}
/**
 * Reads both webhook shapes we support:
 *   - Jenkins' Notification plugin: { name, build: { number, phase, status, full_url } }
 *   - a plain curl from a pipeline:  { job, number, result, url }
 * Returns null for a delivery with no completed result — the Notification
 * plugin's STARTED phase, or a shape we don't recognize.
 */
export function normalizeJenkinsWebhook(body) {
    const build = (body.build ?? {});
    const url = String(body.url ?? build.full_url ?? build.url ?? "");
    const job = jobFromUrl(url) || String(body.job ?? body.name ?? "");
    const number = Number(body.number ?? build.number ?? 0);
    const result = String(body.result ?? body.status ?? build.status ?? "").toUpperCase();
    if (!job || !number || !result)
        return null;
    return { job, number, result, url: url.replace(/\/+$/, "") };
}
export const EVENT_NAMES = [
    "build_failed",
    "build_unstable",
    "build_succeeded",
    "build_finished",
];
/** ABORTED is deliberately not a failure: someone cancelled it, there is
 *  nothing for an agent to fix. Use build_finished to catch those too. */
export function matchesEvent(event, result) {
    switch (event) {
        case "build_finished":
            return true;
        case "build_failed":
            return result === "FAILURE";
        case "build_unstable":
            return result === "UNSTABLE";
        case "build_succeeded":
            return result === "SUCCESS";
        default:
            return false;
    }
}
const lastSegment = (job) => job
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s && s !== "job")
    .pop() ?? "";
/** The configured job vs. the one a delivery names. The bare-name fallback is
 *  for payloads that carry only a job name and no folder path; it can match
 *  the wrong job if two folders hold same-named jobs, so configure the full
 *  folder path when that is the case. */
export function jobMatches(configured, incoming) {
    if (!configured || !incoming)
        return false;
    const a = configured.toLowerCase();
    const b = incoming.toLowerCase();
    return a === b || lastSegment(a) === lastSegment(b);
}
const DEFAULT_TASK = "Jenkins build {{job}} #{{number}} finished as {{result}}. Find the cause and fix it.\n\n" +
    "{{url}}\n\nConsole tail:\n{{log}}";
/**
 * Highest build number already handled, per instance. In memory on purpose:
 * an installed plugin has no access to core's kv store, and the seeding rule
 * below is what makes a restart harmless.
 *
 * ponytail: an `ilmari serve` restart re-seeds, so a build that failed while
 * the server was down is never picked up by polling. The webhook path has no
 * such gap. Persist through a kv reachable from plugin-kit if that matters.
 */
const handled = new Map();
const instanceKey = (project, instance, job) => [project, job, String(instance.event ?? ""), String(instance.workflow ?? "")].join("::");
/**
 * Spawns the task for one build, or nothing. `explicit` marks a delivery we
 * were told about (a webhook) rather than one we discovered by polling.
 */
export async function fire(ctx, c, project, instance, event, explicit) {
    const key = instanceKey(project, instance, String(instance.job ?? ""));
    const previous = handled.get(key);
    if (previous !== undefined && event.number <= previous)
        return undefined;
    handled.set(key, event.number);
    // A poll that has never seen this job records where it is and stays quiet:
    // otherwise every restart re-fires the last failure, which is usually long
    // fixed. A webhook is an explicit delivery, so it always counts.
    if (previous === undefined && !explicit)
        return undefined;
    if (!matchesEvent(String(instance.event ?? "build_failed"), event.result))
        return undefined;
    const lines = Number(instance.logLines ?? DEFAULT_LOG_LINES);
    const log = event.url
        ? await consoleText(c, event.url)
            .then((text) => tail(text, lines))
            .catch(() => "")
        : "";
    const vars = {
        job: event.job,
        number: String(event.number),
        result: event.result,
        url: event.url,
        log,
    };
    const template = String(instance.taskTemplate ?? "") || DEFAULT_TASK;
    return ctx.spawnTask({
        project,
        title: render(template, vars).trim(),
        trigger: PLUGIN,
        payload: vars,
        ...(instance.workflow !== undefined ? { workflow: instance.workflow } : {}),
        ...(instance.mr !== undefined ? { mr: instance.mr } : {}),
    });
}
async function pollOnce(ctx) {
    for (const { project, instance } of ctx.instancesOf(PLUGIN)) {
        const job = String(instance.job ?? "");
        if (!job)
            continue;
        const c = config(ctx.pluginConfig, project);
        if (!c)
            continue;
        try {
            const { lastCompletedBuild } = await json(c, `${jobUrl(c.baseUrl, job)}/api/json?tree=lastCompletedBuild[${BUILD_TREE}]`);
            if (!lastCompletedBuild?.number || !lastCompletedBuild.result)
                continue;
            await fire(ctx, c, project, instance, {
                job,
                number: lastCompletedBuild.number,
                result: lastCompletedBuild.result,
                url: (lastCompletedBuild.url ?? "").replace(/\/+$/, ""),
            }, false);
        }
        catch {
            // unreachable Jenkins, wrong credentials, renamed job — the next poll retries
        }
    }
}
/**
 * MetricSource.collect() is handed no context, so the only route to this
 * plugin's GUI-stored config and its configured jobs is the TriggerContext
 * that `ilmari serve` passes to start(). Cached here for the cards.
 *
 * ponytail: no cards outside a running server (a one-off CLI run never calls
 * start). Give MetricSource a context upstream if that becomes a problem.
 */
let liveCtx;
const plugin = {
    name: "jenkins",
    version: "0.1.0",
    description: "Connects ilmari to Jenkins. A workflow step can run a Jenkins job and pass only when the build goes green, so a change is verified by your real CI pipeline instead of the agent's own claim that it works. A failed build can start a task automatically, with the console log already in the prompt, and agents can read any build's log themselves while they work. Jenkins hosts no code, so the branch and merge request still go to the project's code host (github, gitlab or azure-devops).",
    setup: "In Jenkins open your user menu -> Configure -> API Token and create a token. Put your Jenkins base URL, your user name and that token in this plugin's config. To have failed builds start tasks, add the jenkins trigger to a project in the workflow builder and give it the job path. For instant reactions (instead of one-minute polling) also set a webhook secret here and have Jenkins POST to <ilmari>/api/hooks/jenkins with that value in the X-Ilmari-Secret header.",
    docs: "https://github.com/wraithyy/ilmari-marketplace/tree/main/plugins/jenkins",
    capabilities: ["net", "secrets"],
    config: {
        baseUrl: {
            label: "Jenkins URL",
            description: "Address of your Jenkins server, without a trailing path — for example https://ci.example.com. Everything this plugin does is inert until this is set.",
            env: "JENKINS_URL",
        },
        user: {
            label: "User name",
            description: "The Jenkins user the API token belongs to. Its permissions decide which jobs ilmari can read and build.",
            env: "JENKINS_USER",
        },
        apiToken: {
            label: "API token",
            description: "The API token for that user (Jenkins user menu -> Configure -> API Token). Not your password.",
            secret: true,
            env: "JENKINS_TOKEN",
        },
        webhookSecret: {
            label: "Webhook secret",
            description: "A password you make up, needed only if Jenkins should notify ilmari the moment a build finishes. Jenkins must send it back in the X-Ilmari-Secret header when it calls <ilmari>/api/hooks/jenkins, or the call is rejected. Leave empty to rely on polling instead.",
            secret: true,
            env: "ILMARI_JENKINS_SECRET",
        },
    },
    nodeTypes: [
        {
            type: "jenkins-build",
            // one string literal, not a concatenation: ilmari's static inspect drops
            // any nodeTypes/triggers entry that has a non-literal field, which would
            // hide this node type from the Plugins screen and the Builder palette
            description: "Runs a Jenkins job and waits for the verdict: the step passes only when the build ends in SUCCESS, so it is real CI evidence rather than the agent's word. On a red build the step fails with the console tail attached, which a catch or fallback step can hand straight to an agent as {{<nodeId>.result}}. Note this builds whatever Jenkins checks out for the job — point it at a job that builds this task's branch, or it verifies the wrong code.",
            params: {
                job: {
                    type: "string",
                    required: true,
                    description: "Which job to run: its name, a folder path with slashes, or a full job URL. Templates interpolate, so a branch-parameterized job can take {{task}} or {{trigger.body.<name>}}.",
                    example: "cez/dje/crv/crv-fe",
                },
                params: {
                    type: "string",
                    description: "Build parameters as a JSON object; empty triggers an unparameterized build. Values are sent as strings.",
                    example: '{ "BRANCH": "ilmari/fix-retry" }',
                },
                timeoutMin: {
                    type: "number",
                    description: "Fail the step if the build has not finished within this many minutes, queue time included (default 30). The build itself keeps running in Jenkins.",
                    example: "45",
                },
                allowUnstable: {
                    type: "boolean",
                    description: "Treat an UNSTABLE build (built, but some tests failed) as a pass. Off by default — unstable means something is broken.",
                },
                logLines: {
                    type: "number",
                    description: "How many trailing console lines to attach when the build is not green (default 80, max 500).",
                    example: "150",
                },
            },
            async run(params, ctx) {
                const c = config(ctx.pluginConfig);
                if (!c)
                    return { ok: false, reason: "jenkins-build: the jenkins plugin has no URL configured" };
                // core renders template placeholders in string params before we see them
                const job = String(params.job ?? "").trim();
                if (!job)
                    return { ok: false, reason: "jenkins-build: job is required" };
                let buildParams = {};
                const rawParams = String(params.params ?? "").trim();
                if (rawParams) {
                    try {
                        const parsed = JSON.parse(rawParams);
                        buildParams = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
                    }
                    catch {
                        return { ok: false, reason: "jenkins-build: params is not valid JSON" };
                    }
                }
                const deadline = Date.now() + Number(params.timeoutMin ?? DEFAULT_TIMEOUT_MIN) * 60_000;
                try {
                    const queueUrl = await startBuild(c, job, buildParams);
                    ctx.emit("jenkins_build_queued", { job, queueUrl });
                    const queued = await awaitQueue(c, queueUrl, deadline);
                    ctx.emit("jenkins_build_started", { job, ...queued });
                    const build = await awaitBuild(c, queued.url, deadline);
                    const result = build.result ?? "UNKNOWN";
                    const ok = result === "SUCCESS" || (params.allowUnstable === true && result === "UNSTABLE");
                    const seconds = Math.round((build.duration ?? 0) / 1000);
                    const summary = `${job} #${queued.number} ${result} (${seconds}s) ${queued.url}`;
                    ctx.emit("jenkins_build_finished", { job, ...queued, result, ok });
                    if (ok)
                        return { ok: true, output: summary };
                    const log = tail(await consoleText(c, queued.url).catch(() => ""), Number(params.logLines ?? DEFAULT_LOG_LINES));
                    // output as well as reason: a catch/fallback branch reads the log
                    // through {{<nodeId>.result}}, which is the output, not the reason
                    return { ok: false, output: `${summary}\n\n${log}`, reason: `jenkins-build: ${summary}` };
                }
                catch (error) {
                    return {
                        ok: false,
                        reason: `jenkins-build: ${error instanceof Error ? error.message : String(error)}`,
                    };
                }
            },
        },
    ],
    tools: [
        {
            name: "jenkins_console",
            description: "Read a Jenkins build's status and console log. Use it to find out why a pipeline is red: which stage failed, the compiler or test output, the stack trace. Returns a status line followed by the log; narrow a long log with the grep parameter instead of raising lines.",
            parameters: {
                job: {
                    type: "string",
                    required: true,
                    description: "Job name, folder path with slashes, or full job URL.",
                },
                build: {
                    type: "string",
                    description: "Which build: a number, or one of lastBuild, lastCompletedBuild, lastFailedBuild, lastSuccessfulBuild. Default lastBuild.",
                },
                lines: {
                    type: "number",
                    description: "How many trailing lines to return (default 200, max 500).",
                },
                grep: {
                    type: "string",
                    description: "Return only lines matching this case-insensitive regular expression; the line limit then applies to the matches.",
                },
            },
            async execute(input, ctx) {
                const c = config(ctx.pluginConfig);
                if (!c)
                    return "jenkins_console: the jenkins plugin has no URL configured";
                const job = String(input.job ?? "").trim();
                if (!job)
                    return "jenkins_console: job is required";
                const which = String(input.build ?? "").trim() || "lastBuild";
                const url = `${jobUrl(c.baseUrl, job)}/${encodeURIComponent(which)}`;
                try {
                    const build = await json(c, `${url}/api/json?tree=${BUILD_TREE}`);
                    let log = await consoleText(c, url);
                    const pattern = String(input.grep ?? "").trim();
                    if (pattern) {
                        const re = new RegExp(pattern, "i");
                        log = log.split(/\r?\n/).filter((line) => re.test(line)).join("\n");
                    }
                    const status = build.building ? "BUILDING" : (build.result ?? "UNKNOWN");
                    const name = build.displayName ?? `#${build.number ?? which}`;
                    const header = `${job} ${name}: ${status} — ${build.url ?? url}`;
                    return `${header}\n\n${tail(log, Number(input.lines ?? DEFAULT_TOOL_LINES))}`;
                }
                catch (error) {
                    return `jenkins_console: ${error instanceof Error ? error.message : String(error)}`;
                }
            },
        },
    ],
    triggers: [
        {
            name: "jenkins",
            description: "Start this workflow from a Jenkins build. Two ways in, and configuring both is fine — a build is only ever acted on once. Polling needs nothing on the Jenkins side: the job's last completed build is checked every minute. For an instant reaction, set a webhook secret in the plugin's config and have Jenkins POST to <ilmari>/api/hooks/jenkins with that value in the X-Ilmari-Secret header — either via the Notification plugin or a curl in the pipeline's post block. The task's prompt already contains the console tail, so the agent starts from the actual error. On startup polling records where each job stands without firing, so a restart does not re-run an already fixed failure.",
            params: {
                job: {
                    type: "string",
                    required: true,
                    description: "Which job to watch: its name, or a folder path with slashes. Deliveries for other jobs are ignored.",
                    example: "cez/dje/crv/crv-fe",
                },
                event: {
                    type: "string",
                    required: true,
                    options: [...EVENT_NAMES],
                    description: "Which outcome fires this. build_failed is FAILURE only — an ABORTED build was cancelled by someone and has nothing to fix; use build_finished to catch every outcome.",
                },
                taskTemplate: {
                    type: "string",
                    description: "The spawned task's text, which is also what the agent is asked to do. {{job}}, {{number}}, {{result}}, {{url}} and {{log}} (the console tail) interpolate. Empty gives a sensible default that already includes the log — keep {{log}} in a custom one, or the agent has to fetch it with the jenkins_console tool. Every field is also available to workflow prompts as {{trigger.body.<name>}}.",
                },
                logLines: {
                    type: "number",
                    description: "How many trailing console lines go into the task (default 80, max 500). The webhook payload cap is 64KB.",
                    example: "150",
                },
            },
            start(ctx) {
                liveCtx = ctx;
                void pollOnce(ctx);
                // plain setInterval: core's managedInterval is not reachable from an
                // installed plugin. unref so it never holds the process open.
                setInterval(() => void pollOnce(ctx), TRIGGER_POLL_MS).unref();
            },
            async webhook(payload, ctx) {
                const body = payload;
                // the hooks route normalizes X-Ilmari-Secret onto body.secret
                const gate = config(ctx.pluginConfig);
                if (!gate?.webhookSecret) {
                    return { ok: false, error: "jenkins plugin has no webhook secret configured" };
                }
                if (!secretEquals(body.secret, gate.webhookSecret)) {
                    return { ok: false, error: "invalid webhook secret" };
                }
                const event = normalizeJenkinsWebhook(body);
                if (!event)
                    return { ok: true }; // a STARTED phase or a shape we don't read
                let task;
                for (const { project, instance } of ctx.instancesOf(PLUGIN)) {
                    if (!jobMatches(String(instance.job ?? ""), event.job))
                        continue;
                    const c = config(ctx.pluginConfig, project);
                    if (!c)
                        continue;
                    // the configured path is what identifies the job everywhere else
                    const forInstance = { ...event, job: String(instance.job) };
                    task = (await fire(ctx, c, project, instance, forInstance, true)) ?? task;
                }
                return task ? { ok: true, task } : { ok: true };
            },
        },
    ],
    metrics: [
        {
            name: "jenkins",
            title: "Jenkins jobs",
            async collect() {
                const ctx = liveCtx;
                if (!ctx)
                    return [];
                const c = config(ctx.pluginConfig);
                if (!c)
                    return [];
                const jobs = [
                    ...new Set(ctx
                        .instancesOf(PLUGIN)
                        .map(({ instance }) => String(instance.job ?? ""))
                        .filter(Boolean)),
                ];
                const cards = await Promise.all(jobs.map(async (job) => {
                    try {
                        const { builds = [] } = await json(c, `${jobUrl(c.baseUrl, job)}/api/json?tree=builds[number,result,duration]{0,${METRIC_WINDOW}}`);
                        const done = builds.filter((b) => b.result);
                        const last = done[0];
                        if (!last)
                            return null;
                        const green = done.filter((b) => b.result === "SUCCESS").length;
                        const avgMin = done.reduce((sum, b) => sum + (b.duration ?? 0), 0) / done.length / 60_000;
                        return {
                            id: `jenkins:${job}`,
                            label: job,
                            value: `${last.result} #${last.number}`,
                            detail: `${green}/${done.length} green · ~${avgMin.toFixed(1)} min`,
                            ratio: green / done.length,
                            tone: last.result === "SUCCESS" ? "ok" : last.result === "UNSTABLE" ? "warn" : "bad",
                        };
                    }
                    catch {
                        return null; // unreachable or forbidden job: no card, not a broken dashboard
                    }
                }));
                return cards.filter((card) => card !== null);
            },
        },
    ],
};
export default plugin;
