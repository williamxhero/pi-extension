import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("./loop-to-done.ts", import.meta.url));
const windows = process.platform === "win32";
const command = process.env.PI_TEST_COMMAND || (windows
	? execFileSync("where.exe", ["pi.cmd"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]
	: "pi");

async function fixture(t, answer, judge, options = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-loop-test-"));
	const requests = [];
	const seen = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const { messages, model, reasoning_effort } = JSON.parse(Buffer.concat(chunks));
		seen.push({ model, reasoning_effort, messages });
		if (model === "gpt-6.2-sol" && !options.reasoning) assert.equal(reasoning_effort, "medium");
		const prompt = messages.findLast((message) => message.role === "user").content;
		const text = typeof prompt === "string" ? prompt : prompt.map((part) => part.text).join("");
		if (model !== "gpt-6.2-sol") requests.push(text);
		const reply = model === "gpt-6.2-sol" ? await judge(JSON.parse(text)) : await answer(text, requests.length);
		if (res.destroyed) return;
		if (typeof reply === "number") {
			res.writeHead(reply, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: `mock HTTP ${reply}` } }));
			return;
		}
		const chunk = { id: "mock", object: "chat.completion.chunk", created: 1, model: "mock" };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	await writeFile(join(cwd, "models.json"), JSON.stringify({ providers: { loopmock: {
		baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "mock" }],
	}, cpa: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test", models: [{ id: "gpt-6.2-sol", reasoning: true }] } } }));
	await writeFile(join(cwd, "settings.json"), JSON.stringify({ retry: { maxRetries: 1, baseDelayMs: 10 }, telemetry: false }));
	if (options.agentConfig) {
		await writeFile(join(cwd, "loop-to-done.json"), JSON.stringify(options.agentConfig));
	}

	const env = { ...process.env, PI_CODING_AGENT_DIR: cwd, PI_CODING_AGENT_SESSION_DIR: join(cwd, "sessions"), PI_SKIP_VERSION_CHECK: "1" };
	const args = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
		"--no-tools", "--provider", "loopmock", "--model", "mock", "--extension"];
	// Use environment interpolation to quote paths with spaces when running the Windows .cmd launcher.
	const child = windows
		? spawn(`"%PI_TEST_LAUNCHER%" ${args.join(" ")} "%PI_TEST_EXTENSION%"`, {
			cwd, env: { ...env, PI_TEST_LAUNCHER: command, PI_TEST_EXTENSION: extension }, shell: true,
		})
		: spawn(command, [...args, extension], { cwd, env });
	const events = [];
	let stderr = "";
	let spawnError;
	child.on("error", (error) => { spawnError = error; });
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const output = createInterface({ input: child.stdout });
	output.on("line", (line) => { if (line.startsWith("{")) events.push(JSON.parse(line)); });
	t.after(async () => {
		server.close();
		server.closeAllConnections();
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			child.stdin.end();
			const deadline = setTimeout(() => {
				if (windows) spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
				else child.kill();
			}, 1_500);
			try { await once(child, "close"); } finally { clearTimeout(deadline); }
		}
		await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
	});

	async function waitFor(predicate, label) {
		for (let end = Date.now() + 8_000; Date.now() < end; await delay(10)) {
			if (spawnError) throw spawnError;
			const result = predicate();
			if (result) return result;
			if (child.exitCode !== null) break;
		}
		assert.fail(`No ${label}; Pi exit=${child.exitCode}\n${stderr}\n${JSON.stringify(events.slice(-8))}`);
	}

	let nextId = 0;
	async function rpc(type, args = {}) {
		const id = String(++nextId);
		child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
		const result = await waitFor(() => events.find((event) => event.type === "response" && event.id === id), `${type} response`);
		assert.equal(result.success, true, JSON.stringify(result));
		return result.data;
	}
	const prompt = (message, streamingBehavior) => rpc("prompt", { message, streamingBehavior });
	const notify = (message) => waitFor(() => events.find((event) =>
		event.type === "extension_ui_request" && event.method === "notify" && event.message.includes(message)), message);
	const settled = (count) => waitFor(() => events.filter((event) => event.type === "agent_settled").length >= count, `${count} settled runs`);
	const received = (count) => waitFor(() => requests.length >= count, `${count} model requests`);
	const expectLoopStatus = (statusText) => {
		const key = /^[✓■]/.test(statusText) ? "loop-to-done.result" : "loop-to-done";
		const status = events.findLast((event) => event.type === "extension_ui_request"
			&& event.method === "setStatus" && event.statusKey === key);
		assert.equal(status?.statusText, statusText);
	};
	const commands = (await rpc("get_commands")).commands.map((command) => command.name);
	assert.ok(commands.includes("loop-to-done") && commands.includes("stop-loop-to-done"));
	return { requests, seen, rpc, prompt, notify, settled, received, expectLoopStatus };
}

const rows = (v, role) => v.rows.filter(r => r.role === role);
const done = v => JSON.stringify({action:'completed',checks:rows(v,'user').map(r=>({requirement:'通过约定的测试',scope:r.id,evidence:rows(v,'assistant').at(-1).id}))});

test('enabling an idle task immediately supervises it without another user prompt', async t => {
  let checks=0;
  const pi=await fixture(t, (_prompt,i)=>i===1?'尚未验证':'验证通过', v=>++checks===1
    ? JSON.stringify({action:'continue',reply:'执行待做验证'}) : done(v));
  await pi.prompt('完成并验证任务'); await pi.settled(1);
  await pi.prompt('/loop-to-done', 'followUp');
  await pi.notify('自动续跑：已完成');
  assert.equal(checks,2); assert.equal(pi.requests.length,2);
  assert.match(pi.requests[1],/执行待做验证/);
  const { readFile } = await import('node:fs/promises');
  const log = await readFile((await pi.rpc('get_state')).sessionFile, 'utf8');
  const notes = log.trim().split('\n').map(JSON.parse).filter(e => e.customType === 'loop-to-done.supervisor');
  assert.equal(notes[0].content, '执行待做验证');
});

test('restoring an enabled idle task rearms supervision without another prompt', async t => {
  let checks=0;
  const pi=await fixture(t,()=> '尚未验证',v=>++checks===1 ? 'invalid' : done(v));
  await pi.prompt('验证任务'); await pi.settled(1);
  await pi.prompt('/loop-to-done'); await pi.notify('未取得有效判断');
  const file=(await pi.rpc('get_state')).sessionFile;
  await pi.rpc('new_session'); await pi.rpc('switch_session',{sessionPath:file});
  await pi.notify('自动续跑：已完成'); assert.equal(checks,2);
});

test('CPA chooses three distinct next steps and stops with evidence', async t => {
  let n=0;
  const pi=await fixture(t,()=> '已运行指定测试，断言通过。', v=>{
    n++;
    if(n===1) return JSON.stringify({action:'continue',reply:'运行单测 A'});
    if(n===2) return JSON.stringify({action:'authorize',scope:rows(v,'user')[0].id,necessity:'验证原需求',reply:'批准运行单测 B'});
    if(n===3) return JSON.stringify({action:'explore',reply:'改用本地样本验证'});
    return done(v);
  });
  await pi.prompt('/loop-to-done'); await pi.prompt('验证功能');
  await pi.notify('自动续跑：已完成'); pi.expectLoopStatus('✓ 自动续跑：已完成');
  assert.equal(pi.requests.length,4); assert.match(pi.requests[1],/运行单测 A/); assert.match(pi.requests[2],/批准运行单测 B/);assert.match(pi.requests[3],/本地样本/);
});

test('naked completion and unsupported blocker require verification, not closure',async t=>{
  let n=0;
  const pi=await fixture(t,(_p,i)=>i===1?'全部完成':'已核查本地制品，不存在；服务不可达。',v=>{
    n++; if(n===1)return done(v);
    if(n===2)return JSON.stringify({action:'blocked',condition:'缺凭据'});
    return JSON.stringify({action:'blocked',condition:'服务侧签名凭据缺失',resume:'由持有人签名',noOtherWork:'独立验证已完成，剩余交付要求远端签名',routes:[{route:'本地制品和远端服务',result:'均不能签名',evidence:rows(v,'assistant').at(-1).id}]});
  });
  await pi.prompt('/loop-to-done');await pi.prompt('交付签名产物');await pi.notify('自动续跑：硬阻塞');
  assert.equal(pi.requests.length,3);pi.expectLoopStatus('■ 自动续跑：硬阻塞');
  const file=(await pi.rpc('get_state')).sessionFile;await pi.rpc('new_session');pi.expectLoopStatus('○ 自动续跑：已关闭');await pi.rpc('switch_session',{sessionPath:file});pi.expectLoopStatus('■ 自动续跑：硬阻塞');
});

for(const bad of [503,'not json',JSON.stringify({action:'authorize',necessity:'必需',scope:'invented',reply:'发起操作'})])test('invalid decision or CPA failure sends nothing: '+String(bad).slice(0,35),async t=>{
  const pi=await fixture(t,()=> '需要核查',()=>bad);await pi.prompt('/loop-to-done');await pi.prompt('task');await pi.notify('未取得有效判断');pi.expectLoopStatus('● 自动续跑：已开启');
  await pi.prompt('/stop-loop-to-done');assert.deepEqual(pi.requests,['task']);
});

test('a settings file turns supervision on, changes reasoning, and appends to the policy', async t => {
  const pi = await fixture(t, () => '已执行并验证', () => JSON.stringify({ action: 'continue', reply: '继续下一步' }), {
    reasoning: 'high',
    agentConfig: { autoStart: true, reasoning: 'high', policyAppend: '本仓库只允许改动 extensions/。' },
  });
  pi.expectLoopStatus('● 自动续跑：已开启');
  await pi.prompt('完成任务');
  await pi.received(2);
  const supervisor = pi.seen.filter((request) => request.model === 'gpt-6.2-sol');
  assert.ok(supervisor.length >= 1, 'the supervisor was consulted without /loop-to-done');
  assert.equal(supervisor[0].reasoning_effort, 'high', 'the configured reasoning level reaches the request');
  assert.match(JSON.stringify(supervisor[0]), /本仓库只允许改动 extensions\//, 'the appended policy text reaches the request');
  assert.match(pi.requests.at(-1), /继续下一步/);
});

test('a saved manual stop wins over autoStart', async t => {
  const pi = await fixture(t, () => '已执行', () => JSON.stringify({ action: 'continue', reply: '不应出现' }), {
    agentConfig: { autoStart: true },
  });
  await pi.prompt('/stop-loop-to-done');
  await pi.prompt('普通任务');
  await pi.settled(1);
  await delay(300);
  assert.deepEqual(pi.seen.filter((request) => request.model === 'gpt-6.2-sol'), [], 'no supervision after a manual stop');
  assert.deepEqual(pi.requests, ['普通任务']);
});

test('a main-session request error is a hard blocker that stops sending', async t => {
  let checks=0;
  const pi=await fixture(t,()=>500,v=>{checks++;return JSON.stringify({action:'continue',reply:'继续执行'});});
  await pi.prompt('/loop-to-done');await pi.prompt('执行任务');
  await pi.notify('自动续跑已停止');pi.expectLoopStatus('■ 自动续跑：硬阻塞');
  await delay(300);assert.equal(checks,0);
  const { readFile } = await import('node:fs/promises');
  const log = await readFile((await pi.rpc('get_state')).sessionFile,'utf8');
  const notes = log.trim().split('\n').map(JSON.parse).filter(e=>e.customType==='loop-to-done.supervisor');
  assert.equal(notes.length,1);assert.match(notes[0].content,/硬阻塞/);assert.match(notes[0].content,/500/);
});

test('a supervised turn that errors stops instead of asking the supervisor again', async t => {
  let checks=0;
  const pi=await fixture(t,(_p,i)=>i===1?'已处理一步':500,v=>{checks++;return JSON.stringify({action:'continue',reply:'继续执行第二步'});});
  await pi.prompt('/loop-to-done');await pi.prompt('执行任务');
  await pi.notify('自动续跑已停止');pi.expectLoopStatus('■ 自动续跑：硬阻塞');
  await delay(300);assert.equal(checks,1);
  const { readFile } = await import('node:fs/promises');
  const log = await readFile((await pi.rpc('get_state')).sessionFile,'utf8');
  const notes = log.trim().split('\n').map(JSON.parse).filter(e=>e.customType==='loop-to-done.supervisor').map(e=>e.content);
  assert.deepEqual(notes.map(n=>n.includes('硬阻塞')),[false,true]);
});

for(const interrupt of ['stop','new instruction'])test('late CPA answer is discarded: '+interrupt,async t=>{
  let n=0;const entered=Promise.withResolvers(), release=Promise.withResolvers();
  const pi=await fixture(t,()=> '新要求已执行并验证',async v=>{
    if(++n===1){entered.resolve();await release.promise;return JSON.stringify({action:'continue',reply:'过期的指令'});} return done(v);
  });
  await pi.prompt('/loop-to-done');await pi.prompt('first');await Promise.race([entered.promise,delay(5000)]);assert.equal(n,1);
  try {await pi.prompt(interrupt==='stop'?'/stop-loop-to-done':'new instruction');}finally{release.resolve();}
  if(interrupt!=='stop')await pi.notify('自动续跑：已完成');await delay(150);
  assert.deepEqual(pi.requests,interrupt==='stop'?['first']:['first','new instruction']);
});
