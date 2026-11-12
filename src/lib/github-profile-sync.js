"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  formatPartsDayKey,
  getZonedParts,
  normalizeQueueRow,
  resolveQueuePath,
} = require("./local-api");
const {
  computeRowCost,
  ensurePricingLoaded,
  getModelPricingInfo,
} = require("./pricing");

const SCHEMA_VERSION = 1;
const TIMEZONE = "Asia/Shanghai";
const DEVICE_SCOPE = "this-mac-queue";
const USAGE_START = "<!-- tokentracker-usage:start -->";
const USAGE_END = "<!-- tokentracker-usage:end -->";
const SUMMARY_PATH = "data/tokentracker/summary.json";
const DAILY_DIR = "data/tokentracker/daily";
const TOKENS_SVG = "assets/tokentracker/tokens.svg";
const COST_SVG = "assets/tokentracker/cost.svg";
const README_PATH = "README.md";
const PROFILE_REPO = "https://github.com/zaizuole/zaizuole";
const CODE_REPO = "https://github.com/zaizuole/TokenTracker";
const DEFAULT_PROFILE_DIR = "/Volumes/xcode/codex-work/zaizuole-profile";
const AGENT_LABEL = "com.zaizuole.tokentracker-github-sync";

const TOKEN_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "billable_total_tokens",
  "conversation_count",
];

function blankTotals() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
    billable_total_tokens: 0,
    conversation_count: 0,
    estimated_cost_usd: 0,
    unpriced_total_tokens: 0,
  };
}

function num(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function addRow(totals, row) {
  for (const field of TOKEN_FIELDS) {
    if (field === "billable_total_tokens") {
      totals.billable_total_tokens += row.billable_total_tokens ?? row.total_tokens ?? 0;
      continue;
    }
    totals[field] += num(row[field]);
  }
  const cost = computeRowCost(row);
  totals.estimated_cost_usd += cost;
  const pricing = getModelPricingInfo(row.model, { source: row.source });
  if (pricing.status === "unpriced" && cost === 0) {
    totals.unpriced_total_tokens += num(row.total_tokens);
  }
}

function finalizeTotals(totals) {
  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cached_input_tokens: totals.cached_input_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens,
    reasoning_output_tokens: totals.reasoning_output_tokens,
    total_tokens: totals.total_tokens,
    billable_total_tokens: totals.billable_total_tokens,
    conversation_count: totals.conversation_count,
    estimated_cost_usd: totals.estimated_cost_usd.toFixed(6),
    unpriced_total_tokens: totals.unpriced_total_tokens,
  };
}

function sourceBucket(map, source) {
  const name = source || "unknown";
  if (!map.has(name)) map.set(name, blankTotals());
  return map.get(name);
}

function finalizeSources(map) {
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([source, totals]) => ({ source, ...finalizeTotals(totals) }))
    .filter((source) => source.total_tokens > 0 || source.conversation_count > 0 || Number(source.estimated_cost_usd) > 0);
}

function dayKey(hourStart, timeZone) {
  return formatPartsDayKey(getZonedParts(new Date(hourStart), { timeZone })) || "";
}

function shanghaiStamp(date) {
  const parts = getZonedParts(date, { timeZone: TIMEZONE });
  const pad = (value) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}+08:00`;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

function contentHash(snapshot) {
  const { content_sha256, content_updated_at, ...stats } = snapshot;
  return crypto.createHash("sha256").update(stableStringify(stats)).digest("hex");
}

async function readDedupedQueue(queuePath) {
  let raw;
  try {
    raw = await fsp.readFile(queuePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw Object.assign(new Error("本地队列不存在，已跳过同步"), { code: "queue_missing" });
    }
    throw error;
  }
  const latest = new Map();
  let parsed = 0;
  let failed = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      failed += 1;
      continue;
    }
    parsed += 1;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (row.kind === "account_session_state" || row.kind === "account_sync_watermark") continue;
    const normalized = normalizeQueueRow(row);
    const key = `${normalized.source || ""}|${normalized.model || ""}|${normalized.hour_start || ""}`;
    latest.set(key, normalized);
  }
  if (parsed === 0 && failed > 0) {
    throw Object.assign(new Error("队列无法解析，已跳过同步"), { code: "queue_unreadable" });
  }
  return { rows: [...latest.values()], bytes: Buffer.byteLength(raw) };
}

async function buildUsageSnapshot({
  queuePath = resolveQueuePath(),
  now = new Date(),
  timeZone = TIMEZONE,
  loadPricing = true,
  pricingCachePath = null,
} = {}) {
  if (loadPricing) {
    await ensurePricingLoaded(pricingCachePath ? { cachePath: pricingCachePath } : {});
  }
  const { rows, bytes } = await readDedupedQueue(queuePath);
  if (bytes > 1024 && rows.length === 0) {
    throw Object.assign(new Error("队列没有可用汇总，已跳过同步，避免把已发布统计写成 0"), { code: "queue_empty" });
  }

  const today = dayKey(now.toISOString(), timeZone);
  const allTotals = blankTotals();
  const allSources = new Map();
  const todayTotals = blankTotals();
  const todaySources = new Map();
  const months = new Map();

  for (const row of rows) {
    if (!row.hour_start) continue;
    const day = dayKey(row.hour_start, timeZone);
    if (!day) continue;
    addRow(allTotals, row);
    addRow(sourceBucket(allSources, row.source), row);
    if (day === today) {
      addRow(todayTotals, row);
      addRow(sourceBucket(todaySources, row.source), row);
    }
    const month = day.slice(0, 7);
    if (!months.has(month)) months.set(month, new Map());
    const days = months.get(month);
    if (!days.has(day)) days.set(day, { totals: blankTotals(), sources: new Map() });
    const bucket = days.get(day);
    addRow(bucket.totals, row);
    addRow(sourceBucket(bucket.sources, row.source), row);
  }

  const monthPayload = {};
  for (const month of [...months.keys()].sort()) {
    monthPayload[month] = [...months.get(month).keys()].sort().map((day) => {
      const bucket = months.get(month).get(day);
      return { day, totals: finalizeTotals(bucket.totals), sources: finalizeSources(bucket.sources) };
    });
  }
  const days = Object.values(monthPayload).flat().map((day) => day.day);
  return {
    schema_version: SCHEMA_VERSION,
    timezone: timeZone,
    device_scope: DEVICE_SCOPE,
    dedupe: "latest row per (source, model, hour_start)",
    cost: {
      kind: "estimate",
      note: "Sum of TokenTracker computeRowCost. Not an invoice. Unpriced models add 0 and increment unpriced_total_tokens.",
    },
    range: days.length ? { from: days[0], to: days[days.length - 1] } : { from: null, to: null },
    today,
    all_time: { totals: finalizeTotals(allTotals), sources: finalizeSources(allSources) },
    today_usage: { totals: finalizeTotals(todayTotals), sources: finalizeSources(todaySources) },
    months: monthPayload,
  };
}

function withPublication(snapshot, previous, now) {
  const hash = contentHash(snapshot);
  const updatedAt = previous && previous.content_sha256 === hash && previous.content_updated_at
    ? previous.content_updated_at
    : shanghaiStamp(now);
  return { ...snapshot, content_sha256: hash, content_updated_at: updatedAt };
}

function readPreviousSummary(profileDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, SUMMARY_PATH), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function formatTokenCount(value) {
  const n = Number(value) || 0;
  const trim = (scaled) => (scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, ""));
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1e3)}k`;
  if (n < 1_000_000_000) return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e9)}B`;
}

function formatUsd(value) {
  const n = Number(value) || 0;
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  }[ch]));
}

function badgeSvg({ label, value, color, titleId }) {
  const labelWidth = Math.max(46, 10 + label.length * 7);
  const valueWidth = Math.max(40, 14 + value.length * 7);
  const width = labelWidth + valueWidth;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-labelledby="${titleId}">`,
    `<title id="${titleId}">${xmlEscape(label)}: ${xmlEscape(value)}</title>`,
    `<linearGradient id="${titleId}-shade" x2="0" y2="100%">`,
    `<stop offset="0" stop-color="#fff" stop-opacity=".12"/>`,
    `<stop offset="1" stop-opacity=".12"/>`,
    `</linearGradient>`,
    `<clipPath id="${titleId}-clip"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#${titleId}-clip)">`,
    `<rect width="${labelWidth}" height="20" fill="#555"/>`,
    `<rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`,
    `<rect width="${width}" height="20" fill="url(#${titleId}-shade)"/>`,
    `</g>`,
    `<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">`,
    `<text x="${labelWidth / 2}" y="14">${xmlEscape(label)}</text>`,
    `<text x="${labelWidth + valueWidth / 2}" y="14">${xmlEscape(value)}</text>`,
    `</g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

function renderUsageBlock(snapshot) {
  const all = snapshot.all_time.totals;
  const today = snapshot.today_usage.totals;
  const unpriced = Number(all.unpriced_total_tokens) > 0
    ? "部分模型没有单价，对应用量没有被估成费用。"
    : "";
  return [
    `[![tokens](${TOKENS_SVG})](${CODE_REPO})`,
    `[![estimated cost](${COST_SVG})](${PROFILE_REPO}/blob/main/${SUMMARY_PATH})`,
    ``,
    `本机 TokenTracker 队列汇总，日期按 Asia/Shanghai。费用按模型单价估算，不是服务商实际扣款。单机数据，不含排名。${unpriced}`,
    `内容更新时间：${snapshot.content_updated_at}。累计 ${formatTokenCount(all.total_tokens)} tokens，估算 ${formatUsd(all.estimated_cost_usd)}。今日 ${formatTokenCount(today.total_tokens)} tokens，估算 ${formatUsd(today.estimated_cost_usd)}。`,
  ].join("\n");
}

function isReplacedBadgeLine(line) {
  return /^\s*\[[^\]]*!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*$/.test(line)
    || /^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line);
}

function updateReadme(existing, snapshot) {
  const wrapped = `${USAGE_START}\n${renderUsageBlock(snapshot)}\n${USAGE_END}`;
  if (existing.includes(USAGE_START) && existing.includes(USAGE_END)) {
    return existing.replace(/<!-- tokentracker-usage:start -->[\s\S]*?<!-- tokentracker-usage:end -->/, wrapped);
  }
  const heading = "### AI 编程用量";
  const index = existing.indexOf(heading);
  if (index < 0) {
    const prefix = existing.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${heading}\n\n${wrapped}\n`;
  }
  const afterHeading = existing.slice(index + heading.length);
  const nextHeading = afterHeading.search(/\n#{1,6} /);
  const section = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  const rest = nextHeading >= 0 ? afterHeading.slice(nextHeading) : "";
  const kept = section.split("\n").filter((line) => line.trim() && !isReplacedBadgeLine(line)).join("\n");
  return `${existing.slice(0, index)}${heading}\n\n${wrapped}${kept ? `\n\n${kept}\n` : "\n"}${rest}`;
}

function readmeOutside(text) {
  const start = text.indexOf(USAGE_START);
  const end = text.indexOf(USAGE_END);
  if (start < 0 || end < start) return text;
  return text.slice(0, start) + text.slice(end + USAGE_END.length);
}

function filesForSnapshot(snapshot, readme) {
  const { months, ...summary } = snapshot;
  const files = new Map();
  files.set(SUMMARY_PATH, stableStringify(summary));
  for (const [month, days] of Object.entries(months)) {
    files.set(`${DAILY_DIR}/${month}.json`, stableStringify({
      schema_version: SCHEMA_VERSION,
      timezone: snapshot.timezone,
      device_scope: DEVICE_SCOPE,
      month,
      days,
    }));
  }
  files.set(TOKENS_SVG, badgeSvg({
    label: "tokens",
    value: formatTokenCount(snapshot.all_time.totals.total_tokens),
    color: "#007ec6",
    titleId: "tokens-badge",
  }));
  files.set(COST_SVG, badgeSvg({
    label: "cost",
    value: `${formatUsd(snapshot.all_time.totals.estimated_cost_usd)} est`,
    color: "#2da44e",
    titleId: "cost-badge",
  }));
  files.set(README_PATH, updateReadme(readme, snapshot));
  return files;
}

function redact(text) {
  return String(text || "")
    .replace(/\b(?:gho|ghp|ghu|ghs|github_pat)_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/(Authorization:\s*)\S+/gi, "$1[redacted]");
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw Object.assign(new Error(redact(result.stderr || result.stdout || `git ${args[0]} 失败`).trim()), {
      code: "git_failed",
    });
  }
  return result.stdout;
}

function gitStatus(cwd) {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw Object.assign(new Error(redact(result.stderr || "git status 失败").trim()), { code: "git_failed" });
  }
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const payload = line.slice(3);
    const arrow = payload.indexOf(" -> ");
    return arrow >= 0 ? payload.slice(arrow + 4) : payload;
  });
}

function isManagedPath(filePath) {
  if (filePath === README_PATH || filePath === SUMMARY_PATH || filePath === TOKENS_SVG || filePath === COST_SVG) return true;
  return /^data\/tokentracker\/daily\/\d{4}-\d{2}\.json$/.test(filePath);
}

function abort(code, message) {
  return Object.assign(new Error(message), { code });
}

async function publishProfile({
  profileDir = DEFAULT_PROFILE_DIR,
  snapshot,
  now = new Date(),
  push = true,
  allowEmpty = false,
} = {}) {
  const branch = runGit(profileDir, ["branch", "--show-current"]).trim();
  if (branch !== "main") throw abort("unexpected_branch", `主页仓库当前在 ${branch || "detached"}，未改动`);

  const dirty = gitStatus(profileDir);
  const foreign = dirty.filter((filePath) => !isManagedPath(filePath));
  if (foreign.length) {
    throw abort("dirty_profile", `主页仓库有其他未提交改动，已保留现场：${foreign.join(", ")}`);
  }
  const headReadme = runGit(profileDir, ["show", "HEAD:README.md"]);
  const workingReadme = fs.existsSync(path.join(profileDir, README_PATH))
    ? fs.readFileSync(path.join(profileDir, README_PATH), "utf8")
    : headReadme;
  if (readmeOutside(workingReadme) !== readmeOutside(headReadme)) {
    throw abort("dirty_profile", "README 受管区块之外有未提交改动，已保留现场");
  }

  if (push) {
    runGit(profileDir, ["fetch", "origin", "main"]);
    const head = runGit(profileDir, ["rev-parse", "HEAD"]).trim();
    const remote = runGit(profileDir, ["rev-parse", "origin/main"]).trim();
    const remoteIsAncestor = spawnSync("git", ["merge-base", "--is-ancestor", remote, head], { cwd: profileDir }).status === 0;
    const headIsAncestor = spawnSync("git", ["merge-base", "--is-ancestor", head, remote], { cwd: profileDir }).status === 0;
    if (!remoteIsAncestor && !headIsAncestor) {
      throw abort("not_fast_forward", "主页仓库与 origin/main 已分叉，未改动也未强推");
    }
    if (headIsAncestor && head !== remote) runGit(profileDir, ["merge", "--ff-only", "origin/main"]);
  }

  const previous = readPreviousSummary(profileDir);
  if (!allowEmpty && Number(previous?.all_time?.totals?.total_tokens || 0) > 0 && snapshot.all_time.totals.total_tokens === 0) {
    throw abort("refusing_zero", "新汇总为 0 而远端已有用量，已保留上次发布");
  }
  const published = withPublication(snapshot, previous, now);
  if (previous?.content_sha256 === published.content_sha256) {
    const managedDirty = dirty.filter(isManagedPath);
    if (managedDirty.length) runGit(profileDir, ["checkout", "--", ...managedDirty]);
    const ahead = push ? Number(runGit(profileDir, ["rev-list", "--count", "origin/main..HEAD"]).trim()) : 0;
    if (ahead > 0) {
      runGit(profileDir, ["push", "origin", "HEAD:main"]);
      return { status: "pushed_existing", commit: runGit(profileDir, ["rev-parse", "HEAD"]).trim(), snapshot: published };
    }
    return { status: "unchanged", commit: runGit(profileDir, ["rev-parse", "HEAD"]).trim(), snapshot: published };
  }

  const files = filesForSnapshot(published, workingReadme);
  for (const [relativePath, contents] of files) {
    const absolute = path.join(profileDir, relativePath);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, contents);
  }
  const existingDaily = fs.existsSync(path.join(profileDir, DAILY_DIR))
    ? fs.readdirSync(path.join(profileDir, DAILY_DIR)).filter((name) => /^\d{4}-\d{2}\.json$/.test(name))
    : [];
  const stale = existingDaily
    .map((name) => `${DAILY_DIR}/${name}`)
    .filter((relativePath) => !files.has(relativePath));
  for (const relativePath of stale) await fsp.rm(path.join(profileDir, relativePath), { force: true });

  // Path-limited. Stages new, modified, and deleted managed files only.
  const addPaths = [SUMMARY_PATH, TOKENS_SVG, COST_SVG, README_PATH];
  if (fs.existsSync(path.join(profileDir, DAILY_DIR))) addPaths.push(DAILY_DIR);
  runGit(profileDir, ["add", "-A", "--", ...addPaths]);
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: profileDir }).status;
  if (staged === 0) {
    return { status: "unchanged", commit: runGit(profileDir, ["rev-parse", "HEAD"]).trim(), snapshot: published };
  }
  runGit(profileDir, ["commit", "-m", [
    "同步本机 TokenTracker 用量汇总到主页。",
    "",
    "用 Asia/Shanghai 的去重队列汇总替换官方云徽章，费用仅为估算。",
    "统计内容未变化时不提交。",
    "",
    "Co-authored-by: codex <codex@openai.com>",
  ].join("\n")]);
  const commit = runGit(profileDir, ["rev-parse", "HEAD"]).trim();
  if (!push) return { status: "committed", commit, snapshot: published };
  try {
    runGit(profileDir, ["push", "origin", "HEAD:main"]);
  } catch (error) {
    error.code = "push_failed";
    error.commit = commit;
    throw error;
  }
  return { status: "published", commit, snapshot: published };
}

function localSummaryUrl(from, to, origin = "http://127.0.0.1:7680") {
  const params = new URLSearchParams({
    from,
    to,
    tz: TIMEZONE,
    tz_offset_minutes: "480",
    account: "0",
  });
  return `${origin}/functions/tokentracker-usage-summary?${params}`;
}

function repoRoot() {
  return path.resolve(__dirname, "../..");
}

function agentPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);
}

function renderLaunchAgentPlist({
  nodePath = process.execPath,
  trackerBin = path.join(repoRoot(), "bin", "tracker.js"),
  profileDir = DEFAULT_PROFILE_DIR,
  home = os.homedir(),
} = {}) {
  const args = [nodePath, trackerBin, "github-profile-sync", "--profile", profileDir];
  const xmlArgs = args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${xmlArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(path.dirname(trackerBin))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(`/usr/local/bin:${path.join(home, ".local/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
    <key>LANG</key>
    <string>zh_CN.UTF-8</string>
  </dict>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function lockPathFor(queuePath = resolveQueuePath()) {
  return path.join(path.dirname(queuePath), "github-profile-sync.lock");
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquireLock(lockFile = lockPathFor()) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
      return fd;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = {};
      try {
        owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        owner = {};
      }
      if (processAlive(owner.pid)) return null;
      fs.rmSync(lockFile, { force: true });
    }
  }
  return null;
}

function releaseLock(fd, lockFile = lockPathFor()) {
  if (fd == null) return;
  try { fs.closeSync(fd); } catch { /* already closed */ }
  try { fs.rmSync(lockFile, { force: true }); } catch { /* another run may own a new lock */ }
}

module.exports = {
  AGENT_LABEL,
  COST_SVG,
  DEFAULT_PROFILE_DIR,
  SCHEMA_VERSION,
  SUMMARY_PATH,
  TIMEZONE,
  TOKENS_SVG,
  USAGE_END,
  USAGE_START,
  acquireLock,
  agentPlistPath,
  badgeSvg,
  buildUsageSnapshot,
  contentHash,
  filesForSnapshot,
  formatTokenCount,
  formatUsd,
  localSummaryUrl,
  lockPathFor,
  publishProfile,
  readDedupedQueue,
  redact,
  releaseLock,
  renderLaunchAgentPlist,
  renderUsageBlock,
  repoRoot,
  shanghaiStamp,
  updateReadme,
  withPublication,
};
