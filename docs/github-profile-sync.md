# 个人 GitHub 用量同步

本机 TokenTracker 继续用本地队列统计。这条命令只把去重后的公开汇总推到 `zaizuole/zaizuole`，用来替换主页上的官方云徽章。它不改菜单栏、不上传原始日志，也不替代官方云同步。

## 数据口径

- 读取 `~/.tokentracker/tracker/queue.jsonl`。同一 `(source, model, hour_start)` 只保留最后一条，不把追加快照逐行相加。
- 日期用 `Asia/Shanghai`，与本地 API 的 `getZonedParts` 相同。跨过 UTC 0 点但还在北京时间同一天的记录归到北京时间当天。
- 费用调用项目里的 `computeRowCost`。Codex 等来源的推理 Token 已经含在 output 里，不再另加。没有单价的模型费用记 0，并计入 `unpriced_total_tokens`，不编造价格。
- 只统计这台 Mac 的队列。不合并 `local-usage.json` 里的其他设备，也不读取 `account=1` 的官方云视图。

## 公开与禁止

公开：日期、工具来源、各类 Token 合计、`total_tokens`、`billable_total_tokens`、估算美元、内容更新时间。

不公开：模型名、原始会话、提示词、回答、项目路径、邮箱、主机名、机器标识、backend URL、cookie、Token、认证配置。

`content_sha256` 覆盖汇总和每月明细，不含哈希自身和更新时间。统计不变时保留原来的更新时间，不产生新提交。

## 主页文件

```text
data/tokentracker/summary.json
data/tokentracker/daily/YYYY-MM.json
assets/tokentracker/tokens.svg
assets/tokentracker/cost.svg
README.md 里的 tokentracker-usage 区块
```

徽章是累计 Tokens 和累计估算费用。README 只保留一行内容更新时间、累计和今日数字。

## 给别人用

每人自己配置仓库和 GitHub token。token 只留在本机 `~/.tokentracker/github-sync.json`，权限 600，不进仓库、不进日志。

```bash
node bin/tracker.js github-profile-sync setup --repo owner/name --token-file /path/to/token
node bin/tracker.js github-profile-sync --dry-run
node bin/tracker.js github-profile-sync install-agent
```

token 需要目标仓库的 Contents 写权限。经典 PAT 勾选 `repo`；fine-grained token 只给这一个仓库的 Contents 读写。不写 token 时，先用环境变量 `TOKENTRACKER_GITHUB_TOKEN`，再否则用本机 `gh auth token`。

推送走 GitHub Git 接口，一次提交写入 JSON、SVG 和 README 区块。不需要事先克隆主页仓库，也不使用 SSH。

## 命令

```bash
node bin/tracker.js github-profile-sync setup --repo owner/name [--branch main] [--token-file 文件]
node bin/tracker.js github-profile-sync --dry-run --check-local-api
node bin/tracker.js github-profile-sync
node bin/tracker.js github-profile-sync install-agent
node bin/tracker.js github-profile-sync status
node bin/tracker.js github-profile-sync uninstall-agent
```

`install-agent` 写入 `~/Library/LaunchAgents/com.zaizuole.tokentracker-github-sync.plist`，每 15 分钟运行一次。任务只带 `HOME`、`PATH`、`LANG`，从上面的配置文件读仓库和 token。

电脑睡眠或断网时这一轮不会跑。醒来后的下一次会补传。已有一轮在跑时，新的一轮直接跳过。

## 失败时

队列缺失、队列无法解析、GitHub 连不上、主页有其他未提交文件、README 受管区块之外有改动、或远端不是快进时，命令停止。已经发布的 JSON、SVG 和 README 保持上一次成功的内容。新汇总变成 0 而主页上一次不是 0 时也拒绝覆盖，除非显式加上 `--allow-empty`。

关闭自动任务只卸载这个 LaunchAgent，不影响 TokenTracker 采集。
