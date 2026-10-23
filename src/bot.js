import { DEFAULT_EVENTS, EVENTS, clip, repoName } from './format.js';
import { allowedChat, allowedUser, HttpError } from './security.js';
import { receiptStatements } from './storage.js';

export const COMMANDS = [
  { command: 'sub', description: '订阅仓库：/sub owner/repo [events]' },
  { command: 'unsub', description: '取消当前聊天/话题中的仓库订阅' },
  { command: 'list', description: '查看当前聊天/话题的订阅' },
  { command: 'events', description: '修改通知类型：/events owner/repo events' },
  { command: 'status', description: '查看当前聊天/话题的投递状态' },
  { command: 'retry', description: '重试当前聊天/话题的失败通知' },
  { command: 'help', description: '查看使用说明' },
];

const HELP = `GitHub → Telegram
/sub owner/repo [events] — 订阅或替换事件设置
/unsub owner/repo — 取消订阅并取消待发通知
/list — 当前聊天/话题的订阅
/events owner/repo events — 修改已订阅仓库的事件
/status — 投递状态和聊天 ID
/retry — 重试本聊天/话题内失败的通知

默认：issues,pr,commits,release
可选：${EVENTS.join(',')}
all 表示所有支持的类型。多个类型以逗号或空格分隔。

例如：/sub KiritoXDone/Github-TG-Bot issues,pr,commits,release
还需在仓库 Settings → Webhooks 配置 Worker 的 /webhooks/github 地址和 Secret。
订阅只作用于发送命令的聊天/群话题。`;

function parseEvents(args) {
  if (args.length === 1 && args[0] === 'all') return EVENTS;
  const values = [...new Set(args.join(',').toLowerCase().split(',').filter(Boolean))];
  return values.length && values.every((v) => EVENTS.includes(v)) ? values : null;
}

export async function handleTelegram(env, update, now) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new HttpError(400, 'Invalid update ID');
  const msg = update.message;
  // Ignore edited messages, channel posts, bots and anonymous group senders.
  if (!msg || msg.from?.is_bot || msg.sender_chat || !allowedUser(env, msg.from?.id) ||
      !Number.isSafeInteger(msg.chat?.id) || !allowedChat(env, msg.chat.id) || typeof msg.text !== 'string') return;
  const parts = msg.text.trim().split(/\s+/);
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?$/i.exec(parts.shift());
  if (!match || (match[2] && match[2].toLowerCase() !== env.BOT_USERNAME.toLowerCase())) return;
  const command = match[1].toLowerCase();
  const chat = String(msg.chat.id);
  const thread = msg.message_thread_id ?? 0;
  if (!Number.isSafeInteger(thread) || thread < 0) throw new HttpError(400, 'Invalid thread ID');
  const id = `tg:${update.update_id}`;
  if (await env.DB.prepare('SELECT id FROM receipts WHERE id = ?').bind(id).first()) return;
  const token = crypto.randomUUID();
  const statements = receiptStatements(env.DB, id, token, now);
  const ownReceipt = 'EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?)';
  let text;

  if (['sub', 'subscribe', 'unsub', 'unsubscribe', 'events'].includes(command)) {
    const repo = repoName(parts.shift());
    if (!repo) text = '仓库格式错误，请使用 owner/repo。';
    else if (command === 'unsub' || command === 'unsubscribe') {
      statements.push(env.DB.prepare(`DELETE FROM subscriptions WHERE repo = ? AND chat_id = ? AND thread_id = ? AND ${ownReceipt}`)
        .bind(repo, chat, thread, id, token));
      statements.push(env.DB.prepare(`UPDATE outbox SET status = 'cancelled', finished_at = ?, text = ''
        WHERE repo = ? AND chat_id = ? AND thread_id = ? AND status IN ('pending', 'failed') AND ${ownReceipt}`)
        .bind(now, repo, chat, thread, id, token));
      text = `已取消订阅 ${repo}。已在发送中的消息可能仍会到达。`;
    } else {
      const events = parts.length ? parseEvents(parts) : command === 'events' ? null : DEFAULT_EVENTS;
      const exists = await env.DB.prepare('SELECT repo FROM subscriptions WHERE repo = ? AND chat_id = ? AND thread_id = ?')
        .bind(repo, chat, thread).first();
      const count = await env.DB.prepare('SELECT count(*) AS n FROM subscriptions WHERE chat_id = ? AND thread_id = ?').bind(chat, thread).first();
      if (!events) text = `事件类型错误。可选：${EVENTS.join(',')}，或 all。`;
      else if (command === 'events' && !exists) text = `请先 /sub ${repo}。`;
      else if (!exists && count.n >= 50) text = '当前聊天/话题最多订阅 50 个仓库，请先取消部分订阅。';
      else {
        statements.push(env.DB.prepare(`INSERT INTO subscriptions (repo, chat_id, thread_id, events)
          SELECT ?, ?, ?, ? WHERE ${ownReceipt}
          ON CONFLICT(repo, chat_id, thread_id) DO UPDATE SET events = excluded.events`)
          .bind(repo, chat, thread, JSON.stringify(events), id, token));
        text = `已${command === 'events' ? '更新' : '订阅'} ${repo}\n事件：${events.join(',')}\n请确认仓库已配置 GitHub Webhook。`;
      }
    }
  } else if (command === 'list') {
    const rows = await env.DB.prepare('SELECT repo, events FROM subscriptions WHERE chat_id = ? AND thread_id = ? ORDER BY repo').bind(chat, thread).all();
    text = rows.results.length ? rows.results.map((s) => `${s.repo}\n  ${JSON.parse(s.events).join(',')}`).join('\n') : '当前聊天/话题还没有订阅。使用 /sub owner/repo 添加。';
  } else if (command === 'status') {
    const rows = await env.DB.prepare('SELECT status, count(*) AS n FROM outbox WHERE chat_id = ? AND thread_id = ? GROUP BY status').bind(chat, thread).all();
    text = `聊天 ID：${chat}\n话题 ID：${thread}\n最近 30 天投递：\n${rows.results.map((r) => `${r.status}: ${r.n}`).join('\n') || '暂无记录'}\n失败通知可在修复配置后使用 /retry 重试。`;
  } else if (command === 'retry') {
    statements.push(env.DB.prepare(`UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ?,
      lease_until = 0, lease_token = NULL, finished_at = NULL, last_error = NULL
      WHERE chat_id = ? AND thread_id = ? AND status = 'failed' AND ${ownReceipt}`)
      .bind(now, chat, thread, id, token));
    text = '已将当前聊天/话题内失败的消息重新加入发送队列。';
  } else text = HELP;

  // /list can exceed Telegram's single-message limit. Queue separate pages.
  const pages = [];
  let page = '';
  for (const line of text.split('\n')) {
    if (page.length + line.length + 1 > 3800) { pages.push(page); page = ''; }
    page += `${clip(line, 3700)}\n`;
  }
  if (page) pages.push(page.trimEnd());
  for (let i = 0; i < pages.length; i++) {
    // A page suffix belongs to the outbox ID, while all pages share one receipt.
    const statement = env.DB.prepare(`INSERT OR IGNORE INTO outbox (id, chat_id, thread_id, text, next_attempt_at, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${ownReceipt}`)
      .bind(`${id}:${chat}:${thread}:${i}`, chat, thread, pages[i], now, now, id, token);
    statements.push(statement);
  }
  await env.DB.batch(statements);
}
