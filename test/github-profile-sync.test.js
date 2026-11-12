"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { createLocalApiHandler } = require("../src/lib/local-api");
const { computeRowCost } = require("../src/lib/pricing");
const {
  acquireLock,
  buildUsageSnapshot,
  contentHash,
  filesForSnapshot,
  githubRequest,
  localSummaryUrl,
  lockPathFor,
  parseRepo,
  publishProfile,
  publishToGitHub,
  releaseLock,
  renderLaunchAgentPlist,
  resolveToken,
  updateReadme,
  writeConfig,
} = require("../src/lib/github-profile-sync");

const SECRET = "SUPER_SECRET_PROMPT";
const SECRET_KEY = "sk-test-SECRETKEY";
const SECRET_EMAIL = "secret-user@example.com";
const SECRET_HOST = "secret-host-name";
const SECRET_PATH = "/Users/secret/project";
const SECRET_URL = "https://backend.secret.example";
const SECRET_COOKIE = "session=SECRETCOOKIE";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function writeQueue(queuePath, rows) {
  fs.writeFileSync(queuePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function row(overrides) {
  return {
    source: "claude",
    model: "claude-opus-4-6",
    hour_start: "2026-11-11T16:00:00.000Z",
    input_tokens: 10,
    output_tokens: 5,
    cached_input_tokens: 1,
    cache_creation_input_tokens: 2,
    reasoning_output_tokens: 0,
    total_tokens: 18,
    billable_total_tokens: 18,
    conversation_count: 1,
    ...overrides,
  };
}

async function callSummary(queuePath, from, to) {
  const handler = createLocalApiHandler({ queuePath });
  const endpoint = `/functions/tokentracker-usage-summary?from=${from}&to=${to}&tz=Asia%2FShanghai&tz_offset_minutes=480&account=0`;
  const url = new URL(`http://127.0.0.1${endpoint}`);
  const chunks = [];
  const response = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    write(chunk) { chunks.push(chunk); },
    end(body) { if (body) chunks.push(body); },
  };
  const handled = await handler({ method: "GET", url: url.pathname + url.search, headers: { host: "127.0.0.1" } }, response, url);
  assert.equal(handled, true);
  return JSON.parse(chunks.join(""));
}

function initProfile(root) {
  const bare = path.join(root, "remote.git");
  const profile = path.join(root, "profile");
  git(root, ["init", "--bare", "-b", "main", bare]);
  git(root, ["clone", bare, profile]);
  fs.writeFileSync(path.join(profile, "README.md"), "\n### AI 编程用量\n\n[![rank](https://example.invalid/rank)](https://example.invalid)\n\n手工备注保持不动\n");
  git(profile, ["add", "README.md"]);
  git(profile, ["commit", "-m", "初始主页"]);
  git(profile, ["push", "origin", "HEAD:main"]);
  return profile;
}

test("local summary URL stays on this machine", () => {
  const url = new URL(localSummaryUrl("2026-11-12", "2026-11-12"));
  assert.equal(url.searchParams.get("account"), "0");
  assert.equal(url.searchParams.get("tz"), "Asia/Shanghai");
  assert.equal(url.searchParams.get("tz_offset_minutes"), "480");
});

test("dedupes buckets, splits Shanghai days, and matches the local API", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-github-sync-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  const first = row({ total_tokens: 100, billable_total_tokens: 100, input_tokens: 80, output_tokens: 20 });
  const corrected = row({ total_tokens: 250, billable_total_tokens: 250, input_tokens: 200, output_tokens: 50 });
  const previousDay = row({
    hour_start: "2026-11-11T15:30:00.000Z",
    total_tokens: 30,
    billable_total_tokens: 30,
    input_tokens: 30,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  const codex = row({
    source: "codex",
    model: "gpt-5.4",
    input_tokens: 10,
    output_tokens: 20,
    cached_input_tokens: 30,
    reasoning_output_tokens: 8,
    total_tokens: 60,
    billable_total_tokens: 60,
  });
  const unpriced = row({
    model: "totally-unknown-model-zz",
    input_tokens: 100,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_tokens: 100,
    billable_total_tokens: 100,
    prompt: SECRET,
    api_key: SECRET_KEY,
    email: SECRET_EMAIL,
    hostname: SECRET_HOST,
    project_path: SECRET_PATH,
    backend_url: SECRET_URL,
    cookie: SECRET_COOKIE,
  });
  const cursor = row({
    source: "cursor",
    model: "cursor-composer",
    total_tokens: 50,
    billable_total_tokens: 0,
    input_tokens: 40,
    output_tokens: 10,
    cached_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
  writeQueue(queuePath, [first, corrected, previousDay, codex, unpriced, cursor]);

  const now = new Date("2026-11-12T02:00:00.000Z");
  const snapshot = await buildUsageSnapshot({ queuePath, now, loadPricing: false });
  assert.equal(snapshot.today, "2026-11-12");
  assert.equal(snapshot.range.from, "2026-11-11");
  assert.equal(snapshot.range.to, "2026-11-12");
  assert.equal(snapshot.months["2026-11"].find((day) => day.day === "2026-11-12").totals.total_tokens, 250 + 60 + 100 + 50);
  assert.equal(snapshot.months["2026-11"].find((day) => day.day === "2026-11-11").totals.total_tokens, 30);
  assert.equal(snapshot.all_time.totals.total_tokens, 490);
  assert.equal(snapshot.all_time.totals.total_tokens, 250 + 30 + 60 + 100 + 50);

  const codexSource = snapshot.all_time.sources.find((source) => source.source === "codex");
  assert.equal(codexSource.total_tokens, 60);
  assert.equal(codexSource.reasoning_output_tokens, 8);
  assert.equal(codexSource.estimated_cost_usd, computeRowCost(codex).toFixed(6));
  const unpricedSource = snapshot.months["2026-11"][1].sources.find((source) => source.source === "claude");
  assert.ok(unpricedSource.unpriced_total_tokens >= 100);
  assert.equal(Number(unpricedSource.estimated_cost_usd) > 0, true);
  const cursorSource = snapshot.all_time.sources.find((source) => source.source === "cursor");
  assert.equal(cursorSource.billable_total_tokens, 50);

  const api = await callSummary(queuePath, "2026-11-01", "2026-11-30");
  assert.equal(api.totals.total_tokens, snapshot.all_time.totals.total_tokens);
  assert.equal(api.totals.billable_total_tokens, snapshot.all_time.totals.billable_total_tokens);
  assert.equal(api.totals.input_tokens, snapshot.all_time.totals.input_tokens);
  assert.equal(api.totals.output_tokens, snapshot.all_time.totals.output_tokens);
  assert.equal(api.totals.cached_input_tokens, snapshot.all_time.totals.cached_input_tokens);
  assert.equal(api.totals.reasoning_output_tokens, snapshot.all_time.totals.reasoning_output_tokens);
  assert.equal(String(api.totals.total_cost_usd), snapshot.all_time.totals.estimated_cost_usd);

  const again = await buildUsageSnapshot({ queuePath, now, loadPricing: false });
  assert.equal(contentHash(again), contentHash(snapshot));

  writeQueue(queuePath, [corrected, previousDay, codex, unpriced, cursor, { ...corrected, total_tokens: 400, billable_total_tokens: 400, input_tokens: 300, output_tokens: 100 }]);
  const repaired = await buildUsageSnapshot({ queuePath, now, loadPricing: false });
  assert.equal(repaired.all_time.totals.total_tokens, 400 + 30 + 60 + 100 + 50);
  assert.notEqual(repaired.all_time.totals.total_tokens, snapshot.all_time.totals.total_tokens + 400);

  const published = { ...snapshot, content_sha256: "abc", content_updated_at: "2026-11-12T10:00:00+08:00" };
  const files = filesForSnapshot(published, "\n### AI 编程用量\n\nold\n");
  const packed = [...files.values()].join("\n");
  for (const secret of [SECRET, SECRET_KEY, SECRET_EMAIL, SECRET_HOST, SECRET_PATH, SECRET_URL, SECRET_COOKIE, "totally-unknown-model-zz"]) {
    assert.equal(packed.includes(secret), false, secret);
  }
  assert.equal(packed.includes("\"model\""), false);
  assert.match(files.get("README.md"), /内容更新时间：/);
  assert.equal(files.get("README.md").includes("本机 TokenTracker"), false);
  assert.equal(files.get("README.md").includes("不含排名"), false);
  assert.equal(files.get("README.md").includes("rank"), false);
});

test("readme keeps text outside the managed block", () => {
  const snapshot = {
    content_updated_at: "2026-11-12T10:00:00+08:00",
    all_time: { totals: { total_tokens: 10, estimated_cost_usd: "1.000000", unpriced_total_tokens: 0 } },
    today_usage: { totals: { total_tokens: 4, estimated_cost_usd: "0.250000" } },
  };
  const updated = updateReadme("前言\n\n### AI 编程用量\n\nold badges\n", snapshot);
  assert.equal(updated.startsWith("前言\n\n### AI 编程用量"), true);
  const second = updateReadme(`${updated}\n手工结尾\n`, { ...snapshot, content_updated_at: "2026-11-12T11:00:00+08:00" });
  assert.equal(second.startsWith("前言\n\n### AI 编程用量"), true);
  assert.equal(second.endsWith("手工结尾\n"), true);
  assert.equal(second.includes("2026-11-12T11:00:00+08:00"), true);
});

test("launch agent plist is a 15 minute local job without secrets", () => {
  const plist = renderLaunchAgentPlist({
    nodePath: "/usr/local/bin/node",
    trackerBin: "/Volumes/xcode/codex-work/TokenTracker/bin/tracker.js",
    profileDir: "/Volumes/xcode/codex-work/zaizuole-profile",
    home: "/Users/example",
  });
  assert.match(plist, /<integer>900<\/integer>/);
  assert.match(plist, /github-profile-sync/);
  assert.equal(plist.includes("gho_"), false);
  assert.equal(plist.includes("BEGIN "), false);
  assert.match(plist, /\/usr\/local\/bin\/node/);
});

test("lock skips a live owner and replaces a dead one", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-github-lock-"));
  const lockFile = lockPathFor(path.join(tmp, "queue.jsonl"));
  const first = acquireLock(lockFile);
  assert.ok(first);
  assert.equal(acquireLock(lockFile), null);
  releaseLock(first, lockFile);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, started_at: "2026-11-12T00:00:00Z" }));
  const second = acquireLock(lockFile);
  assert.ok(second);
  releaseLock(second, lockFile);
});

test("publish is idempotent and refuses foreign edits, divergence, and a failed remote", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-github-publish-"));
  const profile = initProfile(root);
  const queuePath = path.join(root, "queue.jsonl");
  writeQueue(queuePath, [row({ total_tokens: 120, billable_total_tokens: 120, input_tokens: 100, output_tokens: 20 })]);
  const now = new Date("2026-11-12T03:00:00.000Z");
  const snapshot = await buildUsageSnapshot({ queuePath, now, loadPricing: false });
  const first = await publishProfile({ profileDir: profile, snapshot, now, push: true });
  assert.equal(first.status, "published");
  const remoteCommit = git(profile, ["rev-parse", "origin/main"]).trim();
  assert.equal(remoteCommit, first.commit);
  const summary = JSON.parse(fs.readFileSync(path.join(profile, "data/tokentracker/summary.json"), "utf8"));
  assert.equal(summary.all_time.totals.total_tokens, 120);
  assert.equal(summary.timezone, "Asia/Shanghai");
  assert.equal(fs.readFileSync(path.join(profile, "README.md"), "utf8").includes("手工备注保持不动"), true);

  const second = await publishProfile({ profileDir: profile, snapshot, now: new Date("2026-11-12T05:00:00.000Z"), push: true });
  assert.equal(second.status, "unchanged");
  assert.equal(second.commit, first.commit);
  assert.equal(git(profile, ["rev-list", "--count", "HEAD"]).trim(), "2");

  const readmePath = path.join(profile, "README.md");
  fs.writeFileSync(readmePath, fs.readFileSync(readmePath, "utf8").replace(
    "内容更新时间：",
    "本机 TokenTracker 队列汇总，日期按 Asia/Shanghai。\n内容更新时间：",
  ));
  git(profile, ["add", "README.md"]);
  git(profile, ["commit", "-m", "拉长说明"]);
  git(profile, ["push", "origin", "HEAD:main"]);
  const shortened = await publishProfile({ profileDir: profile, snapshot, now, push: true });
  assert.equal(shortened.status, "published");
  const shortenedReadme = fs.readFileSync(readmePath, "utf8");
  assert.equal(shortenedReadme.includes("本机 TokenTracker"), false);
  assert.match(shortenedReadme, /内容更新时间：/);
  assert.equal(shortenedReadme.includes("手工备注保持不动"), true);

  fs.writeFileSync(path.join(profile, "NOTES.txt"), "用户的其他修改");
  await assert.rejects(
    publishProfile({ profileDir: profile, snapshot, now, push: true }),
    (error) => error.code === "dirty_profile",
  );
  fs.rmSync(path.join(profile, "NOTES.txt"));
  assert.equal(git(profile, ["status", "--porcelain"]).trim(), "");

  const other = path.join(root, "other");
  git(root, ["clone", path.join(root, "remote.git"), other]);
  git(other, ["commit", "--allow-empty", "-m", "远端另一笔提交"]);
  git(other, ["push", "origin", "HEAD:main"]);
  git(profile, ["commit", "--allow-empty", "-m", "本地另一笔提交"]);
  await assert.rejects(
    publishProfile({ profileDir: profile, snapshot, now, push: true }),
    (error) => error.code === "not_fast_forward",
  );
  assert.equal(fs.existsSync(path.join(profile, "NOTES.txt")), false);

  git(profile, ["reset", "--hard", "origin/main"]);
  const before = fs.readFileSync(path.join(profile, "data/tokentracker/summary.json"), "utf8");
  git(profile, ["remote", "set-url", "origin", path.join(root, "missing.git")]);
  const changed = await buildUsageSnapshot({
    queuePath: (() => {
      writeQueue(queuePath, [row({ total_tokens: 180, billable_total_tokens: 180, input_tokens: 150, output_tokens: 30 })]);
      return queuePath;
    })(),
    now,
    loadPricing: false,
  });
  await assert.rejects(publishProfile({ profileDir: profile, snapshot: changed, now, push: true }));
  assert.equal(fs.readFileSync(path.join(profile, "data/tokentracker/summary.json"), "utf8"), before);

  const zero = await buildUsageSnapshot({
    queuePath: (() => {
      writeQueue(queuePath, [row({
        total_tokens: 0,
        billable_total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        conversation_count: 0,
      })]);
      return queuePath;
    })(),
    now,
    loadPricing: false,
  });
  git(profile, ["remote", "set-url", "origin", path.join(root, "remote.git")]);
  await assert.rejects(
    publishProfile({ profileDir: profile, snapshot: zero, now, push: true }),
    (error) => error.code === "refusing_zero",
  );
});

test("repo config accepts owner/name and keeps the token private", () => {
  assert.equal(parseRepo("https://github.com/octocat/profile.git"), "octocat/profile");
  assert.throws(() => parseRepo("not a repo"), (error) => error.code === "bad_repo");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-github-config-"));
  const file = path.join(dir, "github-sync.json");
  const saved = writeConfig({ repo: "octocat/profile", token: "github_pat_example", file });
  assert.equal(saved.hasToken, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(stored.repo, "octocat/profile");
  assert.equal(stored.token, "github_pat_example");
  assert.equal(resolveToken({ token: "" }, { TOKENTRACKER_GITHUB_TOKEN: "from-env" }, () => ""), "from-env");
  assert.equal(resolveToken({ token: "" }, {}, () => "from-gh"), "from-gh");
});

test("github error text does not keep the token", async () => {
  const token = "github_pat_supersecretvalue";
  await assert.rejects(
    githubRequest({
      token,
      path: "/user",
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          async text() { return JSON.stringify({ message: `bad ${token}` }); },
        };
      },
    }),
    (error) => error.code === "github_auth" && !String(error.message).includes(token),
  );
});

test("token publish writes one commit and skips the same snapshot", async () => {
  const blobs = new Map();
  const files = new Map();
  let ref = null;
  let commits = 0;
  const token = "github_pat_publish";
  async function request({ token: got, method, path: apiPath, body }) {
    assert.equal(got, token);
    if (apiPath === "/repos/acme/profile/git/ref/heads/main" && method === "GET") {
      if (!ref) throw Object.assign(new Error("missing"), { status: 404 });
      return { object: { sha: ref } };
    }
    if (apiPath.startsWith("/repos/acme/profile/contents/")) {
      const filePath = decodeURIComponent(apiPath.slice("/repos/acme/profile/contents/".length).split("?")[0]);
      if (filePath === "data/tokentracker/daily") {
        const names = [...files.keys()].filter((name) => name.startsWith("data/tokentracker/daily/"));
        if (!names.length) throw Object.assign(new Error("missing"), { status: 404 });
        return names.map((name) => ({ name: name.split("/").pop() }));
      }
      if (!files.has(filePath)) throw Object.assign(new Error("missing"), { status: 404 });
      return { content: Buffer.from(files.get(filePath)).toString("base64") };
    }
    if (apiPath === "/repos/acme/profile/git/blobs") {
      const text = Buffer.from(body.content, "base64").toString("utf8");
      const sha = `blob${blobs.size + 1}`;
      blobs.set(sha, text);
      return { sha };
    }
    if (apiPath === "/repos/acme/profile/git/trees") {
      for (const item of body.tree) {
        if (item.sha == null) files.delete(item.path);
        else files.set(item.path, blobs.get(item.sha));
      }
      return { sha: "tree" };
    }
    if (apiPath === "/repos/acme/profile/git/commits") {
      commits += 1;
      return { sha: `commit${commits}` };
    }
    if (apiPath === "/repos/acme/profile/git/refs" && method === "POST") {
      ref = body.sha;
      return { ref: body.ref, object: { sha: ref } };
    }
    if (apiPath === "/repos/acme/profile/git/refs/heads/main" && method === "PATCH") {
      ref = body.sha;
      return { object: { sha: ref } };
    }
    throw new Error(`unexpected ${method} ${apiPath}`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-github-api-"));
  const queuePath = path.join(tmp, "queue.jsonl");
  writeQueue(queuePath, [row({ total_tokens: 80, billable_total_tokens: 80, input_tokens: 50, output_tokens: 30 })]);
  const snapshot = await buildUsageSnapshot({ queuePath, now: new Date("2026-11-12T03:00:00.000Z"), loadPricing: false });
  const first = await publishToGitHub({ snapshot, repo: "acme/profile", token, request });
  assert.equal(first.status, "published");
  assert.equal(first.commit, "commit1");
  assert.match(files.get("README.md"), /https:\/\/github.com\/acme\/profile/);
  assert.match(files.get("README.md"), /内容更新时间：/);
  assert.equal(files.get("README.md").includes("不含排名"), false);
  const second = await publishToGitHub({ snapshot, repo: "acme/profile", token, now: new Date("2026-11-12T06:00:00.000Z"), request });
  assert.equal(second.status, "unchanged");
  assert.equal(commits, 1);
});
