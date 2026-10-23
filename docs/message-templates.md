# 当前消息文本模板

更新日期：2026-10-23。

这是面向 Telegram 的文本审阅清单，包含全部 9 类事件通知、命令回复、命令菜单和用户错误提示。模板实际由 `src/format.js`、`src/bot.js`、`src/targets.js` 生成；修改本文件不会直接改变 Bot。

已纳入本次调整：第一行使用完整的 `owner/repo`；Release 标题与版本号去重；Release 状态使用中文。其他事件的动作、Review 状态和 Actions 结论目前仍保留 GitHub 英文值，下文按现状列出。

## 1. Release 显示效果

以 Miaopu 2.3.3 为例：

**[KiritoXDone/Miaopu](https://github.com/KiritoXDone/Miaopu)**  
🚀 **Release** · 已发布 · [KiritoXDone](https://github.com/KiritoXDone)

**[Miaopu 2.3.3](https://github.com/KiritoXDone/Miaopu/releases/tag/2.3.3)**

> \- 修复比赛详情中切换队伍时色块跳动的问题。

## 2. 所有通知共用的规则

- 第一行：加粗、可点击的完整仓库名 `owner/repo`，保留 GitHub 提供的大小写。
- 第二行：事件 emoji、事件名称、动作或状态、操作人。
- 操作人是符合用户名格式的 GitHub 账号时可点击；否则作为普通文字展示。没有操作人时使用 `GitHub`。
- 标题、版本、Issue/PR 编号、提交哈希直接作为超链接文本，不再另外附加一行原文 URL。
- 正文使用引用块。正文原有的 Markdown 符号按文字转义，不直接当成 Telegram 格式执行。
- 没有正文或标题的部分自动省略；没有动作时也省略该动作及其分隔符。
- 长字段和非 Push 长正文以 `…` 截断，完整链接保留。Push 提交列表超长时自动分页，不省略提交条目。每条通知的 Markdown 源文本控制在 3900 字符内。
- 下方代码块使用 Telegram MarkdownV2 的形式：`*文字*` 表示加粗，`[文字](链接)` 表示行内链接，`>` 表示引用。`{变量}` 是占位符；实际发送时由程序代入并转义。
- 为便于审阅，示例省略了运行时为特殊字符添加的转义反斜线，不能直接当作 Telegram API 请求体发送。
- Bot 命令回复是纯文本，见第 5 节。

### 通用动作 emoji

以下动作适用于 Issue、PR 和评论；具体事件的特殊规则优先。

| GitHub action | emoji | 含义 |
| --- | --- | --- |
| `edited` | ✏️ | 编辑 |
| `deleted` | 🗑️ | 删除 |
| `reopened` | 🔄 | 重新打开 |
| `assigned` / `unassigned` | 👤 | 指派 / 取消指派 |
| `labeled` / `unlabeled` | 🏷️ | 添加 / 移除标签 |
| `locked` | 🔒 | 锁定 |
| `unlocked` | 🔓 | 解锁 |
| `pinned` / `unpinned` | 📌 | 置顶 / 取消置顶 |
| `milestoned` / `demilestoned` | 🎯 | 设置 / 移除里程碑 |
| `transferred` | 📦 | 转移 |

## 3. 事件通知模板

### 3.1 Commit / Push

普通推送：

```markdown
*[{owner}/{repo}]({仓库链接})*
📤 *Push* · [{分支名}]({比较链接}) · [{操作人}]({操作人主页})

• [{短哈希1}]({提交链接1}) {提交摘要1}
• [{短哈希2}]({提交链接2}) {提交摘要2}
```

同一次 Push 收到的所有提交都会展示，不设 Bot 端的提交条数上限。内容能放入一条时只发一条；超长时按完整提交行分页，每页重复仓库和事件标题，并增加页码与提交总数：

```markdown
*[{owner}/{repo}]({仓库链接})*
📤 *Push* · [{分支名}]({比较链接}) · [{操作人}]({操作人主页})
第 {当前页}/{总页数} 页 · 共 {提交总数} 个提交

• [{短哈希}]({提交链接}) {提交摘要}
```

短哈希取前 7 个字符，摘要取提交说明第一行，最多 180 字符。不会再用“另有 N 个提交”隐藏剩余条目。同一次 Push 的分页依次发送；限流或失败时保留尚未发送的页，恢复后接着发送。分页是 Telegram 消息长度限制下的拆分，不是按一分钟聚合。

不同 Push 分开发送。分支名去掉 `refs/heads/` 或 `refs/tags/` 前缀。比较链接优先使用 GitHub 的 compare URL，没有时跳转仓库。

第二行的其他形式：

| 场景 | 事件部分（后面仍接引用名链接和操作人） |
| --- | --- |
| 强制推送 | `⚠️ *Force push*` |
| 新建分支 | `🌱 *Push*` |
| 标签推送 | `🏷️ *Push*` |
| 删除分支 | `🗑️ *删除分支*` |
| 删除标签 | `🗑️ *删除标签*` |

emoji 优先级：删除 → 强推 → 标签 → 新分支 → 普通推送。

### 3.2 Issue

```markdown
*[{owner}/{repo}]({仓库链接})*
{emoji} *[Issue #{编号}]({Issue链接})* · {action} · [{操作人}]({操作人主页})

*{Issue标题}*

>{正文第一行}
>{正文第二行}
```

标题最多 250 字符，正文最多 1200 字符，并受总长度限制。`action` 目前原样显示，例如 `opened`、`closed`、`reopened`、`edited`。

| 场景 | emoji | 显示的 action |
| --- | --- | --- |
| 新建或未单独映射的动作 | 🎫 | 原始 action |
| 关闭，原因是 `completed` | ✅ | `closed` |
| 关闭，原因是 `not_planned` | 🚫 | `closed` |
| 其他关闭或没有关闭原因 | 🔴 | `closed` |
| 编辑、重开、指派、标签等 | 通用动作 emoji | 原始 action |

### 3.3 Pull Request

```markdown
*[{owner}/{repo}]({仓库链接})*
{emoji} *[PR #{编号}]({PR链接})* · {action或merged} · [{操作人}]({操作人主页})

*{PR标题}*
{来源分支} → {目标分支}

>{正文第一行}
>{正文第二行}
```

标题最多 250 字符，两个分支各最多 100 字符，正文最多 1200 字符。只有两个分支名都存在时才显示箭头行。

| 场景 | emoji | 显示的状态 |
| --- | --- | --- |
| 普通新建或其他未映射动作 | 🔃 | 原始 action，例如 `opened` |
| 新建草稿 | 📝 | `opened` |
| 转为草稿 | 📝 | `converted_to_draft` |
| 同步提交 | 🔄 | `synchronize` |
| 准备审查 | 🔍 | `ready_for_review` |
| 请求审查 | 🔍 | `review_requested` |
| 关闭且已合并 | 🔀 | `merged` |
| 关闭且未合并 | 🚫 | `closed` |
| 编辑、重开、标签等 | 通用动作 emoji | 原始 action |

### 3.4 Release

```markdown
*[{owner}/{repo}]({仓库链接})*
{emoji} *Release* · {中文状态} · [{操作人}]({操作人主页})

*[{发布标题}]({Release链接})*

>{发布说明第一行}
>{发布说明第二行}
```

预发布时第二行为：

```markdown
{emoji} *Release* · {中文状态} · 预发布 · [{操作人}]({操作人主页})
```

标题与版本号的合并规则：

| Release name | Tag | 最终可点击文本 |
| --- | --- | --- |
| `Miaopu 2.3.3` | `2.3.3` | `Miaopu 2.3.3` |
| `2.3.3` | `2.3.3` | `2.3.3` |
| `Spring update` | `v1.2.3` | `Spring update · v1.2.3` |
| 空 | `2.3.3` | `2.3.3` |
| `Spring update` | 空 | `Spring update` |
| 空 | 空 | `Release` |

Release name 最多 250 字符，Tag 最多 180 字符；name 已包含 Tag 文本时不再追加。发布说明最多 2400 字符，并受总长度限制。

| GitHub action | 显示的状态 |
| --- | --- |
| `published` | 已发布 |
| `released` | 已发布 |
| `prereleased` | 已发布，另加 `预发布` 标记 |
| `created` | 已创建 |
| `edited` | 已更新 |
| `deleted` | 已删除 |
| `unpublished` | 已撤回 |
| 其他 action | 原样显示 |

Release emoji 按以下顺序判定：

| 条件 | emoji |
| --- | --- |
| action 为 `deleted` | 🗑️ |
| action 为 `edited` | ✏️ |
| action 为 `unpublished` | 📥 |
| 是草稿 | 📝 |
| 是预发布，或 action 为 `prereleased` | 🧪 |
| action 为 `created` | 📦 |
| 其他发布动作 | 🚀 |

### 3.5 评论

支持 `issue_comment`、`commit_comment`、`pull_request_review_comment`。

```markdown
*[{owner}/{repo}]({仓库链接})*
{emoji} *[{对象类型} 评论]({评论链接})* · {action} · [{操作人}]({操作人主页})

*{所属Issue或PR标题}*

>{评论第一行}
>{评论第二行}
```

- 对象类型为 `Issue`、`PR` 或 `Commit`；标题不存在时省略标题块。
- 所属标题最多 250 字符，评论最多 2000 字符，并受总长度限制。
- 默认 💬，编辑 ✏️，删除 🗑️；动作仍显示 `created`、`edited`、`deleted` 等英文值。

### 3.6 PR Review

```markdown
*[{owner}/{repo}]({仓库链接})*
{emoji} *[PR #{编号} Review]({Review链接})* · {review状态} · {action} · [{操作人}]({操作人主页})

*{PR标题}*

>{审查正文第一行}
>{审查正文第二行}
```

PR 标题最多 250 字符，审查正文最多 2000 字符，并受总长度限制。Review 状态和 action 目前原样显示，例如 `approved · submitted`。

| 条件，按优先级排列 | emoji |
| --- | --- |
| action 为 `dismissed` | 🚫 |
| action 为 `edited` | ✏️ |
| review 状态为 `approved` | ✅ |
| review 状态为 `changes_requested` | 🛠️ |
| review 状态为 `commented` | 💬 |
| review 状态为 `dismissed` | 🚫 |
| 其他状态 | 🔍 |

### 3.7 Actions

只在 `workflow_run` 的 action 为 `completed` 时通知。

```markdown
*[{owner}/{repo}]({仓库链接})*
{emoji} *[Actions]({运行详情链接})* · {conclusion} · [{操作人}]({操作人主页})

*{工作流名称}* · {分支名}
```

工作流名称最多 200 字符，分支名最多 150 字符；缺失字段及多余分隔符省略。结论目前保留英文。

| conclusion | emoji |
| --- | --- |
| `success` | ✅ |
| `failure` / `startup_failure` | ❌ |
| `timed_out` | ⏱️ |
| `cancelled` | ⏹️ |
| `skipped` | ⏭️ |
| `neutral` | ➖ |
| `action_required` | ⚠️ |
| `stale` | ⌛ |
| 其他或缺失 | ⚙️ |

### 3.8 Star

新增：

```markdown
*[{owner}/{repo}]({仓库链接})*
⭐ *[Star]({仓库stargazers链接})* · created · [{操作人}]({操作人主页})
```

取消：

```markdown
*[{owner}/{repo}]({仓库链接})*
⭐➖ *[Star]({仓库stargazers链接})* · deleted · [{操作人}]({操作人主页})
```

其他 action 原样显示，使用 ⭐。

### 3.9 Fork

```markdown
*[{owner}/{repo}]({原仓库链接})*
🌿 *[Fork]({新Fork仓库链接})* · [{操作人}]({操作人主页})
```

没有额外正文，也不显示 action。

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

- 事件名称目前仍是 `Push`、`Force push`、`Issue`、`PR`、`Release`、`Review`、`Actions`、`Star`、`Fork`。
- Release 的动作已中文化；其他事件的动作、Review 状态、Actions 结论仍显示英文。
- `/status` 的投递状态仍显示英文。
- 同一条通知只保留正文摘要；完整内容通过行内链接查看。
