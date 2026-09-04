import assert from "node:assert/strict";
import test from "node:test";
import type { TriggerContext, TriggerInstance } from "ilmari-plugin-kit";
import {
  fire,
  jobFromUrl,
  jobMatches,
  jobUrl,
  matchesEvent,
  normalizeJenkinsWebhook,
  render,
  tail,
} from "./index.ts";

test("jobUrl accepts a name, a folder path, a pasted path and a full URL", () => {
  assert.equal(jobUrl("https://ci", "my-job"), "https://ci/job/my-job");
  assert.equal(jobUrl("https://ci", "folder/sub/my-job"), "https://ci/job/folder/job/sub/job/my-job");
  assert.equal(jobUrl("https://ci", "job/folder/job/my-job"), "https://ci/job/folder/job/my-job");
  assert.equal(jobUrl("https://ci", "https://other/job/x/"), "https://other/job/x");
  assert.equal(jobUrl("https://ci", "my job"), "https://ci/job/my%20job");
});

test("jobFromUrl reads the folder path back out of a build URL", () => {
  assert.equal(jobFromUrl("https://ci/job/folder/job/my-job/12/"), "folder/my-job");
  assert.equal(jobFromUrl("https://ci/job/my%20job/3/"), "my job");
  assert.equal(jobFromUrl("https://ci/queue/item/9/"), "");
});

test("normalizeJenkinsWebhook reads both payload shapes and skips STARTED", () => {
  assert.deepEqual(
    normalizeJenkinsWebhook({
      name: "my-job",
      build: { number: 12, phase: "COMPLETED", status: "FAILURE", full_url: "https://ci/job/f/job/my-job/12/" },
    }),
    { job: "f/my-job", number: 12, result: "FAILURE", url: "https://ci/job/f/job/my-job/12" },
  );
  assert.deepEqual(
    normalizeJenkinsWebhook({ job: "my-job", number: 3, result: "success", url: "https://ci/job/my-job/3/" }),
    { job: "my-job", number: 3, result: "SUCCESS", url: "https://ci/job/my-job/3" },
  );
  // STARTED carries no status yet
  assert.equal(normalizeJenkinsWebhook({ name: "j", build: { number: 4, phase: "STARTED" } }), null);
  assert.equal(normalizeJenkinsWebhook({}), null);
});

test("matchesEvent treats ABORTED as neither a failure nor a success", () => {
  assert.equal(matchesEvent("build_failed", "FAILURE"), true);
  assert.equal(matchesEvent("build_failed", "ABORTED"), false);
  assert.equal(matchesEvent("build_failed", "UNSTABLE"), false);
  assert.equal(matchesEvent("build_unstable", "UNSTABLE"), true);
  assert.equal(matchesEvent("build_succeeded", "SUCCESS"), true);
  assert.equal(matchesEvent("build_finished", "ABORTED"), true);
  assert.equal(matchesEvent("nonsense", "FAILURE"), false);
});

test("jobMatches falls back to the bare job name", () => {
  assert.equal(jobMatches("folder/my-job", "folder/my-job"), true);
  assert.equal(jobMatches("folder/my-job", "MY-JOB"), true);
  assert.equal(jobMatches("folder/my-job", "other"), false);
  assert.equal(jobMatches("", "my-job"), false);
});

test("render substitutes known keys and empties unknown ones", () => {
  assert.equal(render("{{a}}/{{ b.c }}/{{missing}}", { a: "1", "b.c": "2" }), "1/2/");
});

test("tail keeps the last n lines and clamps the request", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(tail(text, 2), "line 8\nline 9");
  assert.equal(tail(text, 100), text);
  assert.equal(tail(text, 0), text); // 0 -> default, still above 10 lines
});

/** A TriggerContext that records spawned tasks and needs no server. */
function fakeCtx(): { ctx: TriggerContext; spawned: string[] } {
  const spawned: string[] = [];
  const ctx = {
    spawnTask(spec: { title: string }) {
      spawned.push(spec.title);
      return `task-${spawned.length}`;
    },
    spawnFollowUp() {},
    deliverEvent: () => "ok" as const,
    projects: () => [],
    instancesOf: () => [],
    pluginConfig: () => ({}),
  } as unknown as TriggerContext;
  return { ctx, spawned };
}

const cfg = { baseUrl: "https://ci" };
// url "" keeps fire() off the network: it skips the console fetch
const event = (number: number, result: string) => ({ job: "my-job", number, result, url: "" });

test("polling seeds silently on first sight, then fires once per new build", async () => {
  const { ctx, spawned } = fakeCtx();
  const instance: TriggerInstance = { trigger: "jenkins", job: "my-job", event: "build_failed" };
  const project = "seed-test";

  // first poll only records where the job stands — a restart must not re-run
  // an already fixed failure
  assert.equal(await fire(ctx, cfg, project, instance, event(10, "FAILURE"), false), undefined);
  assert.deepEqual(spawned, []);

  // a new failure fires
  assert.equal(await fire(ctx, cfg, project, instance, event(11, "FAILURE"), false), "task-1");
  // the same build seen again (webhook and poll racing) does not
  assert.equal(await fire(ctx, cfg, project, instance, event(11, "FAILURE"), true), undefined);
  // a green build advances the cursor without firing this instance
  assert.equal(await fire(ctx, cfg, project, instance, event(12, "SUCCESS"), false), undefined);
  assert.equal(await fire(ctx, cfg, project, instance, event(13, "FAILURE"), false), "task-2");
  assert.equal(spawned.length, 2);
  assert.match(spawned[0] as string, /my-job #11 finished as FAILURE/);
});

test("a webhook fires on first sight, unlike a poll", async () => {
  const { ctx, spawned } = fakeCtx();
  const instance: TriggerInstance = { trigger: "jenkins", job: "my-job", event: "build_failed" };
  assert.equal(await fire(ctx, cfg, "webhook-test", instance, event(7, "FAILURE"), true), "task-1");
  assert.equal(spawned.length, 1);
});

test("two instances on one job are tracked separately", async () => {
  const { ctx, spawned } = fakeCtx();
  const failed: TriggerInstance = { trigger: "jenkins", job: "my-job", event: "build_failed" };
  const green: TriggerInstance = { trigger: "jenkins", job: "my-job", event: "build_succeeded" };
  await fire(ctx, cfg, "two", failed, event(1, "FAILURE"), true);
  await fire(ctx, cfg, "two", green, event(1, "SUCCESS"), true);
  assert.equal(spawned.length, 2);
});

test("a custom taskTemplate gets exactly what it asks for", async () => {
  const { ctx, spawned } = fakeCtx();
  const instance: TriggerInstance = {
    trigger: "jenkins",
    job: "my-job",
    event: "build_finished",
    taskTemplate: "{{result}} on {{job}} ({{number}})",
  };
  await fire(ctx, cfg, "template", instance, event(5, "UNSTABLE"), true);
  assert.deepEqual(spawned, ["UNSTABLE on my-job (5)"]);
});
