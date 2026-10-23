import { DEFAULT_EVENTS, EVENTS, clip, repoName } from './format.js';
import { allowedUser, HttpError } from './security.js';
import { receiptStatements } from './storage.js';
import { parseOptions, registerTarget, replyDestination, requireConnected, resolveTarget, targetLabel, TargetError, threadFor } from './targets.js';

export const COMMANDS = [
  { command: 'sub', description: '订阅：/sub owner/repo [events] [--to 目标]' },
  { command: 'unsub', description: '取消订阅，可使用 --to 指定目标' },
  { command: 'list', description: '查看订阅，可使用 --to 指定目标' },
  { command: 'events', description: '修改通知类型，可使用 --to 指定目标' },
  { command: 'targets', description: '在私聊中查看个人、群聊和频道通知目标' },
  { command: 'target', description: '连接或移除目标：/target add 或 remove' },
  { command: 'status', description: '查看投递状态和聊天 ID' },
  { command: 'retry', description: '重试目标中的失败通知' },
  { command: 'help', description: '查看使用说明' },
];

const HELP = `GitHub → Telegram
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
可选：${EVENTS.join(',')}，all 表示全部。
目标仓库仍需配置 GitHub Webhook。`;

function parseEvents(args) {
  if (args.length === 1 && args[0].toLowerCase() === 'all') return EVENTS;
  const values = [...new Set(args.join(',').toLowerCase().split(',').filter(Boolean))];
  return values.length && values.every((v) => EVENTS.includes(v)) ? values : null;
}

export async function handleTelegram(env, update, now) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new HttpError(400, 'Invalid update ID');
  const msg = update.message;
  // Channel posts and anonymous admins lack a verified actor. Manage channels from private chat.
  if (!msg || msg.from?.is_bot || msg.sender_chat || !allowedUser(env, msg.from?.id) ||
      !Number.isSafeInteger(msg.chat?.id) || typeof msg.text !== 'string' ||
      !['private', 'group', 'supergroup'].includes(msg.chat.type)) return;
  if (msg.chat.type === 'private' && msg.chat.id !== msg.from.id) return;
  if (!Number.isSafeInteger(msg.message_thread_id ?? 0) || (msg.message_thread_id ?? 0) < 0) throw new HttpError(400, 'Invalid thread ID');
  const parts = msg.text.trim().split(/\s+/);
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?$/i.exec(parts.shift());
  if (!match || (match[2] && match[2].toLowerCase() !== env.BOT_USERNAME.toLowerCase())) return;
  const command = match[1].toLowerCase();
  const id = `tg:${update.update_id}`;
  if (await env.DB.prepare('SELECT id FROM receipts WHERE id = ?').bind(id).first()) return;
  const token = crypto.randomUUID();
  const ownReceipt = 'EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?)';
  let mutations = [];
  let connected;
  let removed;
  let text;
  try {
    const options = parseOptions(parts);
    const args = options.args;
    const privateChat = msg.chat.type === 'private';
    if (!privateChat && options.to !== undefined && options.to !== 'here') throw new TargetError('跨聊天管理请在 Bot 私聊中使用 --to，群内命令只管理当前群。');
    if (command === 'targets') {
      if (!privateChat) throw new TargetError('请在 Bot 私聊中发送 /targets 查看所有通知目标。');
      const rows = await env.DB.prepare('SELECT * FROM destinations ORDER BY type, title, chat_id').all();
      const own = String(msg.from.id);
      const targets = rows.results.filter((t) => t.type !== 'private' || t.chat_id === own);
      if (!targets.some((t) => t.chat_id === own)) targets.unshift({ chat_id: own, type: 'private', title: '我的私聊', enabled: 1 });
      text = targets.map((t) => `${t.enabled ? '✓' : '停用'} ${targetLabel(t)}${t.username ? ` @${t.username}` : ''}`).join('\n');
      text += '\n\n使用 /sub owner/repo --to 目标 订阅。频道可用 @用户名，私有频道/群可用数字 ID。';
    } else if (command === 'target') {
      const [action, selector] = args;
      if (!['add', 'remove'].includes(action) || !selector || args.length !== 2 || options.to !== undefined || options.topic !== undefined) {
        throw new TargetError('用法：/target add me|here|@频道名|聊天ID，或 /target remove 聊天ID。');
      }
      if (!privateChat && selector !== 'here') throw new TargetError('请在 Bot 私聊中管理其他目标；在群内可使用 /target add here。');
      const target = await resolveTarget(env, msg, selector, action === 'add');
      if (action === 'add') {
        mutations.push(registerTarget(env.DB, target, msg.from.id, id, token, now));
        connected = target.chat_id;
        const usage = privateChat ? `/sub owner/repo --to ${target.type === 'private' ? 'me' : target.chat_id}` : '/sub owner/repo';
        text = `已连接：${targetLabel(target)}\n使用 ${usage} 添加订阅。`;
      } else {
        if (!target.known) throw new TargetError('目标尚未连接。');
        mutations.push(registerTarget(env.DB, target, msg.from.id, id, token, now));
        mutations.push(env.DB.prepare(`UPDATE destinations SET enabled = 0 WHERE chat_id = ? AND ${ownReceipt}`).bind(target.chat_id, id, token));
        mutations.push(env.DB.prepare(`DELETE FROM subscriptions WHERE chat_id = ? AND ${ownReceipt}`).bind(target.chat_id, id, token));
        mutations.push(env.DB.prepare(`UPDATE outbox SET status = 'cancelled', finished_at = ?, text = ''
          WHERE chat_id = ? AND status IN ('pending', 'failed') AND ${ownReceipt}`).bind(now, target.chat_id, id, token));
        removed = target.chat_id;
        text = `已停用：${targetLabel(target)}\n已清除该目标所有话题的订阅和待发通知，其他目标不受影响。已在发送中的消息可能仍会到达。`;
      }
    } else if (['sub', 'subscribe', 'unsub', 'unsubscribe', 'events', 'list', 'status', 'retry'].includes(command)) {
      const isSub = command === 'sub' || command === 'subscribe';
      const isUnsub = command === 'unsub' || command === 'unsubscribe';
      const needsRepo = isSub || isUnsub || command === 'events';
      const repo = needsRepo ? repoName(args.shift()) : null;
      if (needsRepo && !repo) throw new TargetError('仓库格式错误，请使用 owner/repo。');
      const events = isSub || command === 'events' ? (args.length ? parseEvents(args) : isSub ? DEFAULT_EVENTS : null) : null;
      if ((isSub || command === 'events') && !events) throw new TargetError(`事件类型错误。可选：${EVENTS.join(',')}，或 all。`);
      if (!(isSub || command === 'events') && args.length) throw new TargetError('多余参数。指定通知目标请使用 --to，指定话题请使用 --topic。');
      const target = await resolveTarget(env, msg, options.to, isSub);
      const thread = threadFor(target, msg, options);
      const chat = target.chat_id;
      const label = targetLabel(target, thread);
      if (!isSub) requireConnected(target);
      if (isSub || command === 'events') {
        const exists = await env.DB.prepare('SELECT repo FROM subscriptions WHERE repo = ? AND chat_id = ? AND thread_id = ?').bind(repo, chat, thread).first();
        const count = await env.DB.prepare('SELECT count(*) AS n FROM subscriptions WHERE chat_id = ? AND thread_id = ?').bind(chat, thread).first();
        if (command === 'events' && !exists) throw new TargetError(`请先为该目标订阅 ${repo}。`);
        if (!exists && count.n >= 50) throw new TargetError('每个目标/话题最多订阅 50 个仓库，请先取消部分订阅。');
        if (isSub) {
          mutations.push(registerTarget(env.DB, target, msg.from.id, id, token, now));
          connected = chat;
        }
        mutations.push(env.DB.prepare(`INSERT INTO subscriptions (repo, chat_id, thread_id, events)
          SELECT ?, ?, ?, ? WHERE ${ownReceipt}
          ON CONFLICT(repo, chat_id, thread_id) DO UPDATE SET events = excluded.events`)
          .bind(repo, chat, thread, JSON.stringify(events), id, token));
        text = `已${isSub ? '订阅' : '更新'} ${repo}\n目标：${label}\n事件：${events.join(',')}\n请确认仓库已配置 GitHub Webhook。`;
      } else if (isUnsub) {
        mutations.push(env.DB.prepare(`DELETE FROM subscriptions WHERE repo = ? AND chat_id = ? AND thread_id = ? AND ${ownReceipt}`).bind(repo, chat, thread, id, token));
        mutations.push(env.DB.prepare(`UPDATE outbox SET status = 'cancelled', finished_at = ?, text = ''
          WHERE repo = ? AND chat_id = ? AND thread_id = ? AND status IN ('pending', 'failed') AND ${ownReceipt}`).bind(now, repo, chat, thread, id, token));
        text = `已取消订阅 ${repo}\n目标：${label}\n其他目标不受影响。已在发送中的消息可能仍会到达。`;
      } else if (command === 'list') {
        const rows = await env.DB.prepare('SELECT repo, events FROM subscriptions WHERE chat_id = ? AND thread_id = ? ORDER BY repo').bind(chat, thread).all();
        text = `目标：${label}\n\n${rows.results.length ? rows.results.map((s) => `${s.repo}\n  ${JSON.parse(s.events).join(',')}`).join('\n') : '还没有订阅。使用 /sub owner/repo 添加。'}`;
      } else if (command === 'status') {
        const rows = await env.DB.prepare('SELECT status, count(*) AS n FROM outbox WHERE chat_id = ? AND thread_id = ? GROUP BY status').bind(chat, thread).all();
        text = `目标：${label}\n聊天 ID：${chat}\n话题 ID：${thread}\n最近 30 天投递：\n${rows.results.map((r) => `${r.status}: ${r.n}`).join('\n') || '暂无记录'}\n修复配置后可使用 /retry 重试。`;
      } else {
        mutations.push(env.DB.prepare(`UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ?,
          lease_until = 0, lease_token = NULL, finished_at = NULL, last_error = NULL
          WHERE chat_id = ? AND thread_id = ? AND status = 'failed' AND ${ownReceipt}`).bind(now, chat, thread, id, token));
        text = `已重新入队失败消息\n目标：${label}`;
      }
    } else text = HELP;
  } catch (error) {
    if (!(error instanceof TargetError)) throw error;
    mutations = []; connected = undefined; removed = undefined;
    text = error.message;
  }

  const reply = await replyDestination(env, msg, connected, removed);
  const statements = [...receiptStatements(env.DB, id, token, now), ...mutations];
  const pages = [];
  let page = '';
  for (const line of text.split('\n')) {
    if (page.length + line.length + 1 > 3800) { pages.push(page); page = ''; }
    page += `${clip(line, 3700)}\n`;
  }
  if (page) pages.push(page.trimEnd());
  for (let i = 0; i < pages.length; i++) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO outbox (id, chat_id, thread_id, text, next_attempt_at, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${ownReceipt}`)
      .bind(`${id}:${reply.chat}:${reply.thread}:${i}`, reply.chat, reply.thread, pages[i], now, now, id, token));
  }
  await env.DB.batch(statements);
}
