"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  AGENT_LABEL,
  DEFAULT_PROFILE_DIR,
  acquireLock,
  agentPlistPath,
  buildUsageSnapshot,
  localSummaryUrl,
  lockPathFor,
  publishProfile,
  redact,
  releaseLock,
  renderLaunchAgentPlist,
} = require("../lib/github-profile-sync");
const { resolveQueuePath } = require("../lib/local-api");

const LOG_LIMIT = 200_000;

function logFile() {
  return path.join(os.homedir(), ".tokentracker", "tracker", "github-profile-sync.log");
}

function appendLog(line) {
  const file = logFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (Buffer.byteLength(existing) > LOG_LIMIT) existing = existing.slice(-Math.floor(LOG_LIMIT / 2));
  fs.writeFileSync(file, `${existing}${line}\n`);
}

function parseArgs(argv) {
  const opts = {
    action: "sync",
    dryRun: false,
    checkLocalApi: false,
    allowEmpty: false,
    profileDir: process.env.TOKENTRACKER_GITHUB_PROFILE_DIR || DEFAULT_PROFILE_DIR,
    queuePath: resolveQueuePath(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--check-local-api") opts.checkLocalApi = true;
    else if (arg === "--allow-empty") opts.allowEmpty = true;
    else if (arg === "--profile" || arg === "--queue") {
      const value = argv[++index];
      if (!value) throw Object.assign(new Error(`${arg} 缺少路径`), { code: "bad_args" });
      if (arg === "--profile") opts.profileDir = value;
      else opts.queuePath = value;
    }
    else if (arg === "install-agent" || arg === "uninstall-agent" || arg === "status" || arg === "help") opts.action = arg;
    else if (arg === "-h" || arg === "--help") opts.action = "help";
    else throw Object.assign(new Error(`未知参数: ${arg}`), { code: "bad_args" });
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    "把本机 TokenTracker 用量汇总同步到 zaizuole/zaizuole。",
    "",
    "  github-profile-sync [--dry-run] [--check-local-api] [--queue 路径] [--profile 目录]",
    "  github-profile-sync install-agent",
    "  github-profile-sync uninstall-agent",
    "  github-profile-sync status",
    "",
    "默认每 15 分钟由本机 LaunchAgent 执行。统计没变不会提交。",
    "关闭自动任务不会停止 TokenTracker 本身的采集。",
    "",
  ].join("\n"));
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error(`本地统计服务返回 ${response.status}`), { code: "local_api_unavailable" });
  return response.json();
}

async function checkAgainstLocalApi(snapshot) {
  const { from, to } = snapshot.range;
  if (!from || !to) return;
  const fields = [
    "total_tokens",
    "billable_total_tokens",
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_creation_input_tokens",
    "reasoning_output_tokens",
    "conversation_count",
  ];
  let body;
  try {
    body = await readJson(localSummaryUrl(from, to));
  } catch (error) {
    if (error.code === "local_api_unavailable") throw error;
    throw Object.assign(new Error("本地统计服务不可用，未把缺失响应当成 0"), { code: "local_api_unavailable" });
  }
  if (String(localSummaryUrl(from, to)).includes("account=1")) {
    throw Object.assign(new Error("禁止用 account=1 作为本机数据"), { code: "bad_account" });
  }
  for (const field of fields) {
    if (Number(body.totals[field]) !== snapshot.all_time.totals[field]) {
      throw Object.assign(new Error(`与本地 API 不一致 ${field}: api=${body.totals[field]} export=${snapshot.all_time.totals[field]}`), { code: "api_mismatch" });
    }
  }
  if (String(body.totals.total_cost_usd) !== snapshot.all_time.totals.estimated_cost_usd) {
    throw Object.assign(new Error(`估算费用与本地 API 不一致 api=${body.totals.total_cost_usd} export=${snapshot.all_time.totals.estimated_cost_usd}`), { code: "api_mismatch" });
  }
  const today = await readJson(localSummaryUrl(snapshot.today, snapshot.today));
  if (Number(today.totals.total_tokens) !== snapshot.today_usage.totals.total_tokens) {
    throw Object.assign(new Error(`今日用量与本地 API 不一致 api=${today.totals.total_tokens} export=${snapshot.today_usage.totals.total_tokens}`), { code: "api_mismatch" });
  }
}

function launchctl(args) {
  return spawnSync("launchctl", args, { encoding: "utf8" });
}

function installAgent() {
  const dest = agentPlistPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderLaunchAgentPlist());
  const domain = `gui/${process.getuid()}`;
  const target = `${domain}/${AGENT_LABEL}`;
  launchctl(["bootout", target]);
  const boot = launchctl(["bootstrap", domain, dest]);
  if (boot.status !== 0) {
    throw Object.assign(new Error(redact(boot.stderr || boot.stdout || "launchctl bootstrap 失败").trim()), { code: "agent_install_failed" });
  }
  launchctl(["enable", target]);
  console.log(`已安装自动任务 ${AGENT_LABEL}，每 15 分钟运行。`);
  console.log(`关闭：node ${path.join(path.resolve(__dirname, "../.."), "bin/tracker.js")} github-profile-sync uninstall-agent`);
}

function uninstallAgent() {
  const domain = `gui/${process.getuid()}`;
  launchctl(["bootout", `${domain}/${AGENT_LABEL}`]);
  fs.rmSync(agentPlistPath(), { force: true });
  console.log("已关闭 GitHub 用量同步。TokenTracker 本地采集不受影响。");
}

function printStatus() {
  const print = launchctl(["print", `gui/${process.getuid()}/${AGENT_LABEL}`]);
  console.log(fs.existsSync(agentPlistPath()) ? `plist: ${agentPlistPath()}` : "plist: 未安装");
  console.log(print.status === 0 ? "launchd: 已加载" : "launchd: 未加载");
  if (fs.existsSync(logFile())) {
    const lines = fs.readFileSync(logFile(), "utf8").trim().split("\n").slice(-8);
    console.log(lines.join("\n"));
  }
}

async function sync(opts) {
  const lockFile = lockPathFor(opts.queuePath);
  const lock = acquireLock(lockFile);
  if (lock == null) {
    const line = `${new Date().toISOString()} 已有同步在运行，跳过`;
    appendLog(line);
    console.log(line);
    return;
  }
  try {
    const built = await buildUsageSnapshot({ queuePath: opts.queuePath });
    if (opts.checkLocalApi) await checkAgainstLocalApi(built);
    if (opts.dryRun) {
      console.log(`dry-run 累计 ${built.all_time.totals.total_tokens} tokens，估算 $${built.all_time.totals.estimated_cost_usd}，今日 ${built.today_usage.totals.total_tokens} tokens`);
      console.log("未写入主页仓库。");
      return;
    }
    const result = await publishProfile({
      profileDir: opts.profileDir,
      snapshot: built,
      allowEmpty: opts.allowEmpty,
    });
    const line = `${new Date().toISOString()} ${result.status} ${result.commit || ""} 累计 ${result.snapshot.all_time.totals.total_tokens} 今日 ${result.snapshot.today_usage.totals.total_tokens}`;
    appendLog(redact(line));
    console.log(line);
  } finally {
    releaseLock(lock, lockFile);
  }
}

async function cmdGithubProfileSync(argv) {
  try {
    const opts = parseArgs(argv);
    if (opts.action === "help") {
      printHelp();
      return;
    }
    if (opts.action === "install-agent") {
      installAgent();
      return;
    }
    if (opts.action === "uninstall-agent") {
      uninstallAgent();
      return;
    }
    if (opts.action === "status") {
      printStatus();
      return;
    }
    await sync(opts);
  } catch (error) {
    const line = redact(error?.message || String(error));
    appendLog(`${new Date().toISOString()} 失败 ${line}`);
    console.error(line);
    process.exitCode = 1;
  }
}

module.exports = {
  cmdGithubProfileSync,
  parseArgs,
};
