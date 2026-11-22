import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The extension is a single runtime-dependency-free file, so the settings reader
// can be imported directly. Run with `node --experimental-strip-types --test`.
const { DEFAULTS, loadConfig, policy } = await import("./loop-to-done.ts");

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-loop-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { agentDir, cwd };
}

test("without a file every value is the built-in default", async (t) => {
  const { agentDir, cwd } = await sandbox(t);
  assert.deepEqual(loadConfig({ agentDir, cwd, trusted: true }), DEFAULTS);
});

test("the agent-dir file sets values, and a broken value keeps only its own default", async (t) => {
  const { agentDir, cwd } = await sandbox(t);
  await writeFile(join(agentDir, "loop-to-done.json"), JSON.stringify({
    model: "gpt-6.2-sol-mini",
    reasoning: "high",
    maxTokens: 1200,
    autoStart: true,
    // The rest are wrong on purpose: each falls back on its own.
    requestTimeoutMs: 1,
    initialRetryMs: "30000",
    snapshotBudgetChars: 999999,
    policyAppend: 42,
  }));

  const config = loadConfig({ agentDir, cwd });
  assert.equal(config.model, "gpt-6.2-sol-mini");
  assert.equal(config.reasoning, "high");
  assert.equal(config.maxTokens, 1200);
  assert.equal(config.autoStart, true);
  assert.equal(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs);
  assert.equal(config.initialRetryMs, DEFAULTS.initialRetryMs);
  assert.equal(config.snapshotBudgetChars, DEFAULTS.snapshotBudgetChars);
  assert.equal(config.policyAppend, DEFAULTS.policyAppend);
});

test("a project file refines the agent-dir one, but only for a trusted folder", async (t) => {
  const { agentDir, cwd } = await sandbox(t);
  await writeFile(join(agentDir, "loop-to-done.json"), JSON.stringify({ maxTokens: 2000, reasoning: "low" }));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "loop-to-done.json"), JSON.stringify({ maxTokens: 4000 }));

  const trusted = loadConfig({ agentDir, cwd, trusted: true });
  assert.equal(trusted.maxTokens, 4000, "the project file wins");
  assert.equal(trusted.reasoning, "low", "keys the project leaves alone come from the agent dir");

  const untrusted = loadConfig({ agentDir, cwd, trusted: false });
  assert.equal(untrusted.maxTokens, 2000, "an untrusted folder's file is ignored");
});

test("a file that does not parse reads as no file at all", async (t) => {
  const { agentDir, cwd } = await sandbox(t);
  await writeFile(join(agentDir, "loop-to-done.json"), "{ not json");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(cwd, ".pi", "loop-to-done.json"), "[1, 2]");
  assert.deepEqual(loadConfig({ agentDir, cwd, trusted: true }), DEFAULTS);
});

test("a retry cap below the first wait is raised to it, so the backoff never shrinks", async (t) => {
  const { agentDir, cwd } = await sandbox(t);
  await writeFile(join(agentDir, "loop-to-done.json"), JSON.stringify({ initialRetryMs: 120000, maxRetryMs: 60000 }));
  const config = loadConfig({ agentDir, cwd });
  assert.equal(config.initialRetryMs, 120000);
  assert.equal(config.maxRetryMs, 120000);
});

test("policyAppend is appended to the built-in policy and never replaces it", async (t) => {
  const { agentDir, cwd } = await sandbox(t);
  const base = policy(loadConfig({ agentDir, cwd }));
  await writeFile(join(agentDir, "loop-to-done.json"), JSON.stringify({ policyAppend: "本仓库只允许改动 src/。" }));
  const appended = policy(loadConfig({ agentDir, cwd }));
  assert.ok(appended.startsWith(base), "the built-in policy is still there");
  assert.match(appended, /本仓库只允许改动 src\/。/);
  assert.ok(appended.length > base.length);
});
