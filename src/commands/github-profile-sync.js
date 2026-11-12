"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  AGENT_LABEL,
  acquireLock,
  agentPlistPath,
  buildUsageSnapshot,
  githubRequest,
  localSummaryUrl,
  lockPathFor,
  publishToGitHub,
  readConfig,
  redact,
  releaseLock,
  renderLaunchAgentPlist,
  resolveToken,
  tokenSource,
  writeConfig,
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
    queuePath: resolveQueuePath(),
    repo: "",
    branch: "main",
    tokenFile: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--check-local-api") opts.checkLocalApi = true;
    else if (arg === "--allow-empty") opts.allowEmpty = true;
    else if (arg === "--repo" || arg === "--branch" || arg === "--token-file" || arg === "--queue" || arg === "--profile") {
      const value = argv[++index];
      if (!value) throw Object.assign(new Error(`${arg} 缺少值`), { code: "bad_args" });
      if (arg === "--repo") opts.repo = value;
      else if (arg === "--branch") opts.branch = value;
      else if (arg === "--token-file") opts.tokenFile = value;
      else if (arg === "--queue") opts.queuePath = value;
    }
    else if (arg === "setup" || arg === "install-agent" || arg === "uninstall-agent" || arg === "status" || arg === "help") opts.action = arg;
    else if (arg === "-h" || arg === "--help") opts.action = "help";
    else throw Object.assign(new Error(`未知参数: ${arg}`), { code: "bad_args" });
  }
  return opts;
}

function printHelp() {
  process.stdout.write([
    "把本机 TokenTracker 用量汇总同步到配置好的 GitHub 仓库。",
    "",
    "  github-profile-sync setup --repo owner/name [--branch main] [--token-file 文件]",
    "  github-profile-sync [--dry-run] [--check-local-api] [--queue 路径]",
    "  github-profile-sync install-agent",
    "  github-profile-sync uninstall-agent",
    "  github-profile-sync status",
    "",
    "token 放在 ~/.tokentracker/github-sync.json，文件权限 600。",
    "不写 token 时使用 TOKENTRACKER_GITHUB_TOKEN，再否则使用本机 gh 登录。",
    "token 需要目标仓库的 Contents 写权限。统计没变不会提交。",
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

function setup(opts) {
  if (!opts.repo) throw Object.assign(new Error("setup 需要 --repo owner/name"), { code: "bad_args" });
  const token = opts.tokenFile ? fs.readFileSync(opts.tokenFile, "utf8").trim() : "";
  const saved = writeConfig({ repo: opts.repo, branch: opts.branch, token });
  console.log(`已写入 ${saved.path}`);
  console.log(`仓库 ${saved.repo}，分支 ${saved.branch}`);
  console.log(saved.hasToken
    ? "token 已写在本机配置里，权限 600。不会进入 Git 仓库。"
    : "未保存 token。同步时使用 TOKENTRACKER_GITHUB_TOKEN，或本机已登录的 gh。");
}

function printStatus() {
  const print = launchctl(["print", `gui/${process.getuid()}/${AGENT_LABEL}`]);
  console.log(fs.existsSync(agentPlistPath()) ? `plist: ${agentPlistPath()}` : "plist: 未安装");
  console.log(print.status === 0 ? "launchd: 已加载" : "launchd: 未加载");
  try {
    const config = readConfig();
    console.log(`仓库: ${config.repo}#${config.branch}`);
    console.log(`token: ${tokenSource(config)}`);
  } catch (error) {
    console.log(redact(error.message));
  }
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
    const config = readConfig();
    const token = resolveToken(config);
    const built = await buildUsageSnapshot({ queuePath: opts.queuePath });
    if (opts.checkLocalApi) await checkAgainstLocalApi(built);
    if (opts.dryRun) {
      await githubRequest({ token, method: "GET", path: `/repos/${config.repo}` });
      console.log(`dry-run 将同步到 ${config.repo}#${config.branch}`);
      console.log(`累计 ${built.all_time.totals.total_tokens} tokens，估算 $${built.all_time.totals.estimated_cost_usd}，今日 ${built.today_usage.totals.total_tokens} tokens`);
      console.log("未写入仓库。");
      return;
    }
    const result = await publishToGitHub({
      snapshot: built,
      repo: config.repo,
      branch: config.branch,
      token,
      allowEmpty: opts.allowEmpty,
    });
    const line = `${new Date().toISOString()} ${result.status} ${result.repo} ${result.commit || ""} 累计 ${result.snapshot.all_time.totals.total_tokens} 今日 ${result.snapshot.today_usage.totals.total_tokens}`;
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
    if (opts.action === "setup") {
      setup(opts);
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
