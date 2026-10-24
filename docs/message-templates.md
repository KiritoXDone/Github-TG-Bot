# 当前消息文本模板

更新日期：2026-10-24。

这是面向 Telegram 的文本审阅清单，包含全部 9 类事件通知、命令回复、命令菜单和用户错误提示。模板实际由 `src/format.js`、`src/bot.js`、`src/targets.js` 生成；修改本文件不会直接改变 Bot。

所有事件通知已统一为 GitHubBot 风格：首行是事件和对象链接，作者另起一行，长正文自动折叠。Push 参考用户提供的真实样例；Issue 参考 [@GitHubBot 转发样例](https://t.me/AWAvenueAdsRule/24)；PR 和评论参考来源显示为 GitHub 的[公开 PR 样例](https://t.me/projectXtls/1385)及[评论样例](https://t.me/projectXtls/1393)。PR、评论样例隐藏了来源账号链接。Release、Review、Actions、Star、Fork 和未验证的动作分支按同一风格设计，不声称是官方原文。

## 1. Release 显示效果

以 Miaopu 2.3.3 为例：

🚀 **New release** [Miaopu 2.3.3](https://github.com/KiritoXDone/Miaopu/releases/tag/2.3.3)<br>
by [@KiritoXDone](https://github.com/KiritoXDone)

• 修复比赛详情中切换队伍时色块跳动的问题。

## 2. 所有通知共用的规则

- 首行直接展示事件和带链接的对象，仓库使用短名 `repo`，保留 GitHub 大小写；没有独立的 `owner/repo` 标题行。
- 普通 Push 在每条提交后显示提交作者。其他事件第二行为 `by @操作人`，PR 使用样例中的 `by: @操作人`。操作人链接到 GitHub 主页；Commit 作者保留显示名称，并链接到事件提供的作者 GitHub 账号，缺少有效账号时保留纯文本。
- 事件使用英文描述，例如 `New issue`、`Merged pull request`、`New release`、`Workflow succeeded`。
- Release、Issue、PR、评论和 Review 正文把 GitHub Markdown 转为 Telegram MarkdownV2：[Telegram 格式说明](https://core.telegram.org/bots/api#markdownv2-style)。标题显示为粗体，支持粗斜体、删除线、行内代码、代码块、行内链接、列表、任务列表和引用。标题字段与 Commit 摘要保持字面文本。
- 表格转为可读文本行；图片显示为图片文字链接；`<details>` 转为可展开引用块，`<summary>` 显示为粗体标题，内部继续解析 Markdown。带 `open` 的 details 使用普通展开引用块；嵌套 details 展平，代码示例中的标签保持字面文本。HTML 注释省略，其他原始 HTML 按文字显示（`<br>` 转换为换行）。Telegram 不允许的嵌套（如粗体里的代码）保留文字，嵌套引用展平。只允许 HTTP(S) 正文链接，不携带账号密码。
- 草稿 Release、草稿 PR 及转为草稿的事件不推送；发布或 `ready_for_review` 后恢复通知，预发布正常推送。Review / 评论事件携带 `pull_request.draft=true` 时同样跳过；普通 `issue_comment` 不提供 PR 草稿状态，不额外查询 GitHub。
- 对象标题、提交数量、哈希、作者使用行内链接，模板不额外附加原文 URL。正文中用户自行写入的 URL 仍作为原文保留。
- 当前 Bot 没有回复回写 GitHub 的功能，因此不显示官方样例中的回复评论提示。
- 非 Push 长字段和长正文以 `…` 截断，完整链接及格式闭合保留。正文字符额度按解析后的文字计算；最多解析前 16000 个字符。Push 的提交条数不设上限，超长按完整提交行分页。每条 Markdown 源文本不超过 3900 字符。
- 普通正文块超过 600 个可见字符或 8 个非空行时自动转为可展开引用块；统计不包含 Markdown 标记和链接目标 URL。标题和操作人保持在块外，短正文直接展示。已有 `<details>` 折叠块及其短引言保留，`open` 仍保持展开；长正文中的普通引用展平，避免嵌套引用。折叠内保留链接、行内代码和代码块。
- 下方代码块使用 Telegram MarkdownV2 的形式：`*文字*` 表示加粗，`[文字](链接)` 表示行内链接。`{变量}` 是占位符；实际发送时由程序代入并转义。
- 为便于审阅，示例省略运行时的特殊字符转义，不能直接当作 Telegram API 请求体发送。
- Bot 管理命令回复保持纯文本，见第 5 节。

### GitHub 折叠内容

例如 `<details><summary>English</summary>…</details>`，发送时转换为 Telegram MarkdownV2 的可展开引用块：

```markdown
**>*English*
>• Improve directory picker.
>• Fix application loading.
>• Update navigation.||
```

Telegram 显示标题和正文开头，用户可点击展开其余内容；具体收起高度由客户端控制。原始 `<details>` / `<summary>` 标签不显示。长正文仍遵循通知长度限制，完整内容见 Release 链接。

### 长正文自动缩略

Issue、PR、Release、评论和 Review 都应用同一自动折叠规则，例如：

```markdown
🔌 *New pull request* [{repo}#{编号} {PR标题}]({PR链接})
by: [@{操作人}]({操作人主页})

**>*Changes*
>• {第一项}
>• {后续内容}
>…||
```

折叠用于减少屏幕占用，仍保留正文上限：Issue / PR 为 1200 字符，评论 / Review 为 2000 字符，Release 为 2400 字符，同时受单条 3900 字符的 Markdown 源文本限制。超出的内容通过首行对象链接查看。

### Issue / PR 通用动作

`{对象}` 对应 `issue` 或 `pull request`。事件自身的特殊状态优先，具体见下文。

| GitHub action | 标题文字 | emoji |
| --- | --- | --- |
| `opened` / `created` | `New {对象}` | Issue 🐛 / PR 🔌 |
| `closed` | `Closed {对象}` | 见对应事件 |
| `reopened` | `Reopened {对象}` | 🔄 |
| `edited` | `Updated {对象}` | ✏️ |
| `deleted` | `Deleted {对象}` | 🗑️ |
| `assigned` / `unassigned` | `Assigned {对象}` / `Unassigned {对象}` | 👤 |
| `labeled` / `unlabeled` | `Labeled {对象}` / `Unlabeled {对象}` | 🏷️ |
| `locked` / `unlocked` | `Locked {对象}` / `Unlocked {对象}` | 🔒 / 🔓 |
| `pinned` / `unpinned` | `Pinned {对象}` / `Unpinned {对象}` | 📌 |
| `milestoned` | `Added milestone to {对象}` | 🎯 |
| `demilestoned` | `Removed milestone from {对象}` | 🎯 |
| `transferred` | `Transferred {对象}` | 📦 |
| `typed` / `untyped` | `Changed type of {对象}` / `Removed type from {对象}` | Issue 🐛 / PR 🔌 |
| 未映射或缺失 | `Issue updated` / `Pull request updated` | Issue 🐛 / PR 🔌 |

## 3. 事件通知模板

### 3.1 Commit / Push

```markdown
🔨 [{数量} new commits]({比较链接}) to *{repo}:{分支名}*:

[{短哈希1}]({提交链接1}): {提交摘要1} by [{提交作者1}]({作者主页1})
[{短哈希2}]({提交链接2}): {提交摘要2} by [{提交作者2}]({作者主页2})
```

单个提交使用 `1 new commit`。提交数量链接到本次 Push 的 compare 页面；缺失比较链接时跳转仓库。短哈希取前 7 个字符，摘要取第一行、最多 180 字符。作者取 `commit.author.name`，缺失时使用 `username`（兼容 `login`），再缺失则显示 `Unknown author`。提供有效用户名时，作者名称链接到 `https://github.com/{username}`；缺少关联账号时保持纯文本，不从显示名称猜测账号，也不使用推送者替代提交作者。作者最多 80 字符。

收到的所有提交都会展示。超过 5 个提交或全部提交行的可见文字超过 600 字符时，列表折叠显示；超长时增加页码并重复标题，每页都使用可展开引用块：

```markdown
🔨 [{提交总数} new commits]({比较链接}) to *{repo}:{分支名}*:
Page {当前页}/{总页数}

**>[{短哈希1}]({提交链接1}): {提交摘要1} by [{提交作者1}]({作者主页1})
>[{短哈希2}]({提交链接2}): {提交摘要2} by [{提交作者2}]({作者主页2})||
```

同一次 Push 的分页依次发送，限流或失败后恢复续发。不同 Push 分开发送，不按分钟聚合。分支名去掉 `refs/heads/` 或 `refs/tags/`，最多 180 字符。GitHub 的 Push Webhook 本身最多包含 2048 个提交；这里只展示实际收到的全部条目，不额外补取。

带提交的强推、新分支、标签推送仍使用提交列表；标题之后、页码之前增加以下一行（强推优先）：

| 场景 | 附加行 |
| --- | --- |
| 强制推送 | `⚠️ Forced push by [@{操作人}]({主页})` |
| 新分支 | `🌱 New branch by [@{操作人}]({主页})` |
| 新标签 | `🏷️ New tag by [@{操作人}]({主页})` |
| 更新标签 | `🏷️ Updated tag by [@{操作人}]({主页})` |

无提交的新分支/标签、删除分支/标签：

```markdown
{emoji} *{New或Deleted} {branch或tag}* [{repo}:{引用名}]({引用链接})
by [@{操作人}]({操作人主页})
```

新分支 🌱、新标签 🏷️，链接到对应 tree 页面；删除使用 🗑️，链接到仓库。普通空 Push 使用 `0 new commits`，没有提交列表。

### 3.2 Issue

```markdown
🐛 *New issue* [{repo}#{编号} {Issue标题}]({Issue链接})
by [@{操作人}]({操作人主页})

{Issue正文}
```

其他动作使用通用动作表。关闭时标题为 `Closed issue`：`completed` 使用 ✅，`not_planned` 使用 🚫，其他关闭原因使用 🔴。标题最多 250 字符，正文最多 1200 字符，并受消息总长度限制。

### 3.3 Pull Request

```markdown
🔌 *New pull request* [{repo}#{编号} {PR标题}]({PR链接})
by: [@{操作人}]({操作人主页})

{PR正文}
```

标题最多 250 字符，正文最多 1200 字符。不额外增加来源分支 → 目标分支行。

| 场景 | 标题文字 | emoji |
| --- | --- | --- |
| 新建草稿 / 仍为草稿 / 转为草稿 | 不推送 | — |
| 同步提交 | `Updated pull request` | 🔄 |
| 准备审查 | `Pull request ready for review` | 🔍 |
| 请求审查 | `Review requested for` | 🔍 |
| 移除审查请求 | `Review request removed from` | 🔌 |
| 自动合并启用 / 停用 | `Auto-merge enabled for` / `Auto-merge disabled for` | 🔌 |
| 加入 / 移出合并队列 | `Added pull request to merge queue` / `Removed pull request from merge queue` | 🔌 |
| 关闭且已合并 | `Merged pull request` | 🔀 |
| 关闭且未合并 | `Closed pull request` | 🚫 |
| 编辑、重开、标签等 | 通用动作表 | 通用动作表 |

### 3.4 Release

```markdown
🚀 *New release* [{发布标题}]({Release链接})
by [@{操作人}]({操作人主页})

{发布说明}
```

标题合并 name 与 tag，name 已含 tag 时不再重复；合并后的标题没有仓库短名时前置短名，已有时保留。

| repo | Release name | Tag | 可点击标题 |
| --- | --- | --- | --- |
| Miaopu | `Miaopu 2.3.3` | `2.3.3` | `Miaopu 2.3.3` |
| Miaopu | `2.3.3` | `2.3.3` | `Miaopu 2.3.3` |
| Miaopu | `Spring update` | `v1.2.3` | `Miaopu Spring update · v1.2.3` |
| Miaopu | 空 | `2.3.3` | `Miaopu 2.3.3` |
| Miaopu | 空 | 空 | `Miaopu Release` |

Name 最多 250 字符，tag 最多 180 字符；发布说明最多 2400 字符，并受总长度限制。

| action | 标题文字 |
| --- | --- |
| `published` | `New release` |
| `created` / `released` / `prereleased` | 不推送，避免同一次发布重复通知 |
| `edited` | 展示内容发生变化时才发送 `Updated release` |
| `deleted` | `Deleted release` |
| `unpublished` | `Unpublished release` |
| 其他或缺失 | `Updated release` |

`release.draft=true` 时直接跳过，不进入发送队列。非草稿且 `release.prerelease=true` 的发布把 `release` 替换为 `pre-release`，例如 `New pre-release`。

新版本只接受 `published`，它同时覆盖正式发布和预发布，包括从草稿发布；参见 [GitHub 发布事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release)。除投递 ID 去重外，还按仓库、Release ID、`published_at` 原子去重（保留 30 天），避免多个不同 ID 的发布请求重复入队。不同 Release 或不同发布时间独立通知。缺少有效 Release ID / 发布时间的请求保留原投递 ID 去重。

编辑按同一个 Release 的最新内容进行比对：名称、版本号、完整发布说明、预发布状态相同时不再推送，更新时间、操作人、附件下载量等元数据不会触发重复通知。发布时建立基准；没有基准的首次编辑会通知一次。真正变化（包括恢复为旧内容）仍通知，旧于已记录 `updated_at` 的事件不覆盖新内容。内容指纹、事件回执和消息队列在同一事务中保存，仅存 SHA-256 摘要；超过 30 天未见活动的基准会清理。

Emoji 优先级：删除 🗑️ → 编辑 ✏️ → 撤回 📥 → 预发布 🧪 → 其他 🚀。

### 3.5 评论

支持 `issue_comment`、`commit_comment`、`pull_request_review_comment`。

```markdown
💬 *New comment on* [{repo}#{编号} {Issue或PR标题}]({评论链接})
by [@{操作人}]({操作人主页})

{评论正文}
```

Commit 评论的对象链接文字为 `{repo}@{短哈希}`；缺失哈希时仅使用仓库短名。链接直接定位该评论。标题最多 250 字符，评论最多 2000 字符，并受总长度限制。

| action | 标题文字 | emoji |
| --- | --- | --- |
| `created` | `New comment on` | 💬 |
| `edited` | `Updated comment on` | ✏️ |
| `deleted` | `Deleted comment on` | 🗑️ |
| 未映射或缺失 | `Comment updated on` | 💬 |

### 3.6 PR Review

```markdown
✅ *Approved pull request* [{repo}#{编号} {PR标题}]({Review链接})
by [@{操作人}]({操作人主页})

{审查正文}
```

标题最多 250 字符，正文最多 2000 字符，并受总长度限制。

| 条件，按优先级排列 | 标题文字 | emoji |
| --- | --- | --- |
| action `dismissed` | `Dismissed review on` | 🚫 |
| action `edited` | `Updated review on` | ✏️ |
| state `approved` | `Approved pull request` | ✅ |
| state `changes_requested` | `Changes requested on` | 🛠️ |
| state `commented` | `New review on` | 💬 |
| state `dismissed` | `Dismissed review on` | 🚫 |
| 其他或缺失 | `New review on` | 🔍 |

### 3.7 Actions

仅 `workflow_run` 的 action 为 `completed` 时通知。

```markdown
✅ *Workflow succeeded* [{repo}:{分支} · {工作流名称} #{运行编号}]({运行详情链接})
by [@{操作人}]({操作人主页})
```

分支最多 150 字符，工作流名称最多 200 字符，运行编号最多 20 字符。缺失字段及其分隔符省略。

| conclusion | 标题文字 | emoji |
| --- | --- | --- |
| `success` | `Workflow succeeded` | ✅ |
| `failure` | `Workflow failed` | ❌ |
| `startup_failure` | `Workflow failed to start` | ❌ |
| `timed_out` | `Workflow timed out` | ⏱️ |
| `cancelled` | `Workflow cancelled` | ⏹️ |
| `skipped` | `Workflow skipped` | ⏭️ |
| `neutral` | `Workflow completed with neutral result` | ➖ |
| `action_required` | `Workflow requires action` | ⚠️ |
| `stale` | `Workflow became stale` | ⌛ |
| 其他或缺失 | `Workflow completed` | ⚙️ |

### 3.8 Star

```markdown
⭐ *New star on* [{repo}]({仓库stargazers链接})
by [@{操作人}]({操作人主页})
```

取消 Star 时首行改为 `⭐➖ *Star removed from* [{repo}]({仓库stargazers链接})`。

### 3.9 Fork

```markdown
🌿 *New fork of* [{repo}]({原仓库链接})
by [@{操作人}]({操作人主页})

[{Fork的owner/repo}]({Fork仓库链接})
```

Fork 完整名称最多 150 字符；缺失名称或有效链接时省略最后一段。

## 4. 命令回复中的公共字段

以下模板为纯文本，仓库键统一为小写。`{事件列表}` 使用逗号分隔，例如 `issues,pr,commits`。

目标名称 `{目标}`：

```text
个人 · 我的私聊 ({聊天ID})
群聊 · {群名称} ({聊天ID})
群聊 · {群名称} ({聊天ID}) · 话题 {话题ID}
频道 · {频道名称} ({聊天ID})
```

目标名称最多显示 120 字符。只有非零话题 ID 才显示话题后缀。长命令回复按行拆分为多条，单条约 3800 字符，不添加分页编号。

## 5. Bot 命令回复

### 5.1 `/sub`、`/subscribe`

```text
已订阅 {owner/repo}
目标：{目标}
事件：{事件列表}
请确认仓库已配置 GitHub Webhook。
```

### 5.2 `/events`

```text
已更新 {owner/repo}
目标：{目标}
事件：{事件列表}
请确认仓库已配置 GitHub Webhook。
```

### 5.3 `/unsub`、`/unsubscribe`

```text
已取消订阅 {owner/repo}
目标：{目标}
其他目标不受影响。已在发送中的消息可能仍会到达。
```

### 5.4 `/list`

有订阅时，每个仓库占两行：

```text
目标：{目标}

{owner/repo1}
  {事件列表1}
{owner/repo2}
  {事件列表2}
```

无订阅：

```text
目标：{目标}

还没有订阅。使用 /sub owner/repo 添加。
```

### 5.5 `/status`

```text
目标：{目标}
聊天 ID：{聊天ID}
话题 ID：{话题ID}
最近 30 天投递：
{状态}: {数量}
{状态}: {数量}
修复配置后可使用 /retry 重试。
```

每个有记录的状态占一行；状态保留英文 `pending`、`sent`、`failed`、`cancelled`。没有记录时，这些统计行替换为 `暂无记录`。

### 5.6 `/retry`

```text
已重新入队失败消息
目标：{目标}
```

### 5.7 `/targets`

每个目标一行；启用前缀为 `✓`，停用前缀为 `停用`；有用户名时追加 ` @{用户名}`。

```text
✓ {目标1} @{用户名}
✓ {目标2}
停用 {目标3}

使用 /sub owner/repo --to 目标 订阅。频道可用 @用户名，私有频道/群可用数字 ID。
```

### 5.8 `/target add`

```text
已连接：{目标}
使用 {订阅命令} 添加订阅。
```

`{订阅命令}` 的三种形式：

| 当前管理位置 / 目标 | 订阅命令 |
| --- | --- |
| 私聊中连接自己的私聊 | `/sub owner/repo --to me` |
| 私聊中连接群或频道 | `/sub owner/repo --to {聊天ID}` |
| 群内连接当前群 | `/sub owner/repo` |

### 5.9 `/target remove`

```text
已停用：{目标}
已清除该目标所有话题的订阅和待发通知，其他目标不受影响。已在发送中的消息可能仍会到达。
```

### 5.10 `/help`、`/start`、其他未识别的斜杠命令

这些命令均返回同一份帮助文本：

```text
GitHub → Telegram
/sub owner/repo [events] — 订阅/替换事件设置
/unsub owner/repo — 取消该目标的仓库订阅
/list — 查看目标的订阅
/events owner/repo events — 修改事件
/status — 投递状态和聊天 ID
/retry — 重试目标的失败通知

通知目标：
默认发到当前私聊/群聊/话题。
在私聊中添加 --to me、--to @频道名、--to -100群ID 指定目标。
群话题加 --topic 话题ID。
/targets — 私聊查看所有目标
/target add @频道名 — 连接频道
/target add here — 在当前群连接
/target remove 聊天ID — 停用整个目标及其订阅
群/频道连接前，你和 Bot 都需要是管理员，频道还需 Bot 的发布权限。

/sub KiritoXDone/Miaopu --to me
/sub KiritoXDone/Miaopu release --to @your_channel
默认：issues,pr,commits,release
可选：issues,pr,commits,release,comments,reviews,actions,stars,forks，all 表示全部。
目标仓库仍需配置 GitHub Webhook。
```

## 6. Telegram 命令菜单

| 命令 | 菜单中的描述 |
| --- | --- |
| `/sub` | 订阅：/sub owner/repo [events] [--to 目标] |
| `/unsub` | 取消订阅，可使用 --to 指定目标 |
| `/list` | 查看订阅，可使用 --to 指定目标 |
| `/events` | 修改通知类型，可使用 --to 指定目标 |
| `/targets` | 在私聊中查看个人、群聊和频道通知目标 |
| `/target` | 连接或移除目标：/target add 或 remove |
| `/status` | 查看投递状态和聊天 ID |
| `/retry` | 重试目标中的失败通知 |
| `/help` | 查看使用说明 |

## 7. 用户错误提示

以下是当前全部 TargetError 文本，直接作为纯文本回复，不添加统一的错误前缀。动态字段用 `{变量}` 表示。

### 7.1

```text
跨聊天管理请在 Bot 私聊中使用 --to，群内命令只管理当前群。
```

### 7.2

```text
请在 Bot 私聊中发送 /targets 查看所有通知目标。
```

### 7.3

```text
用法：/target add me|here|@频道名|聊天ID，或 /target remove 聊天ID。
```

### 7.4

```text
请在 Bot 私聊中管理其他目标；在群内可使用 /target add here。
```

### 7.5

```text
目标尚未连接。
```

### 7.6

```text
仓库格式错误，请使用 owner/repo。
```

### 7.7

```text
事件类型错误。可选：issues,pr,commits,release,comments,reviews,actions,stars,forks，或 all。
```

### 7.8

```text
多余参数。指定通知目标请使用 --to，指定话题请使用 --topic。
```

### 7.9

```text
请先为该目标订阅 {owner/repo}。
```

### 7.10

```text
每个目标/话题最多订阅 50 个仓库，请先取消部分订阅。
```

### 7.11

```text
--to 后填写 me、here、@频道名或聊天 ID。
```

### 7.12

```text
--topic 后填写正整数话题 ID。
```

### 7.13

```text
话题 ID 无效。
```

### 7.14

```text
未知选项：{未知选项，最多50字符}
```

### 7.15

```text
无法访问目标或查询权限。请检查聊天 ID，并先把机器人加入目标群/频道、设为管理员。
```

### 7.16

```text
目标格式错误：使用 me、here、@频道名或数字聊天 ID。
```

### 7.17

```text
聊天 ID 无效。
```

### 7.18

```text
个人通知只能发到你自己的私聊，其他管理员请用自己的账号订阅。
```

### 7.19

```text
你需要是目标群/频道的管理员才能连接或订阅。
```

### 7.20

```text
请先把机器人设为目标群/频道的管理员；频道还需开启“发布消息”权限。
```

### 7.21

```text
只支持个人私聊、群聊和频道。
```

### 7.22

```text
目标尚未连接。请先 /target add 聊天ID，或 /sub owner/repo --to 聊天ID。
```

### 7.23

```text
只有开启话题的超级群支持 --topic；个人和频道不支持话题。
```

### 7.24

```text
目标未连接或已停用，请先使用 /target add 或 /sub 重新连接。
```

## 8. 不产生 Telegram 文本的情况

- 未授权用户、匿名管理员身份、Bot 发送的消息、频道帖子，以及发给其他 Bot 的命令会被忽略。
- 非命令消息不回复；同一 Telegram update 的重复投递不再次回复。
- 未支持的 GitHub 事件，以及没有匹配订阅的事件不发送通知。
- GitHub ping、Webhook 验签失败、配置不完整、Telegram 临时不可用等属于接口响应，不作为 Telegram 消息模板发送。

## 9. 审阅时可重点调整的当前文案

- 通知使用简洁英文事件描述；所有类型的最终模板与动作分支见第 3 节。
- 管理命令回复使用中文，通知使用 GitHubBot 风格的英文文案。
- `/status` 的投递状态仍显示英文。
- 长正文以 Markdown 可展开引用块展示预览，完整内容通过行内链接查看；Push 展示全部收到的提交，大批提交折叠并按需分页。
