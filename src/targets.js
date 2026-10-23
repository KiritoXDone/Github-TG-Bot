import { allowedChat, HttpError } from './security.js';
import { clip } from './format.js';

export class TargetError extends Error {}

export function targetLabel(target, thread = 0) {
  const kind = { private: '个人', group: '群聊', supergroup: '群聊', channel: '频道' }[target.type];
  return `${kind} · ${clip(target.title, 120)} (${target.chat_id})${thread ? ` · 话题 ${thread}` : ''}`;
}

export function parseOptions(parts) {
  const args = [];
  let to;
  let topic;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '--to') {
      if (to !== undefined || !parts[i + 1] || parts[i + 1].startsWith('--')) throw new TargetError('--to 后填写 me、here、@频道名或聊天 ID。');
      to = parts[++i];
    } else if (parts[i] === '--topic') {
      if (topic !== undefined || !/^[1-9]\d*$/.test(parts[i + 1] || '')) throw new TargetError('--topic 后填写正整数话题 ID。');
      topic = Number(parts[++i]);
      if (!Number.isSafeInteger(topic)) throw new TargetError('话题 ID 无效。');
    } else if (parts[i].startsWith('--')) throw new TargetError(`未知选项：${clip(parts[i], 50)}`);
    else args.push(parts[i]);
  }
  return { args, to, topic };
}

async function telegram(env, method, body) {
  let response;
  let data;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    data = await response.json();
  } catch { throw new HttpError(503, 'Telegram temporarily unavailable'); }
  if (response.ok && data.ok) return data.result;
  const code = Number(data.error_code) || response.status;
  if (code === 429 || code >= 500) throw new HttpError(503, 'Telegram temporarily unavailable');
  throw new TargetError('无法访问目标或查询权限。请检查聊天 ID，并先把机器人加入目标群/频道、设为管理员。');
}

export async function resolveTarget(env, msg, selector = 'here', verify = false) {
  let chatId = selector === 'me' ? String(msg.from.id) : selector === 'here' ? String(msg.chat.id) : selector;
  if (!/^(@[A-Za-z0-9_]{5,32}|-?[1-9]\d*)$/.test(chatId)) throw new TargetError('目标格式错误：使用 me、here、@频道名或数字聊天 ID。');
  let info;
  if (chatId.startsWith('@')) {
    info = await telegram(env, 'getChat', { chat_id: chatId });
    chatId = String(info.id);
  }
  if (!Number.isSafeInteger(Number(chatId))) throw new TargetError('聊天 ID 无效。');
  if (Number(chatId) > 0) {
    if (chatId !== String(msg.from.id)) throw new TargetError('个人通知只能发到你自己的私聊，其他管理员请用自己的账号订阅。');
    const stored = await env.DB.prepare('SELECT * FROM destinations WHERE chat_id = ?').bind(chatId).first();
    return { chat_id: chatId, type: 'private', title: '我的私聊', username: null, is_forum: 0,
      enabled: stored?.enabled ?? 1, known: true };
  }
  const stored = await env.DB.prepare('SELECT * FROM destinations WHERE chat_id = ?').bind(chatId).first();
  if (verify) {
    info ??= await telegram(env, 'getChat', { chat_id: chatId });
    const botId = Number(env.TELEGRAM_BOT_TOKEN.split(':')[0]);
    const [bot, user] = await Promise.all([
      telegram(env, 'getChatMember', { chat_id: chatId, user_id: botId }),
      telegram(env, 'getChatMember', { chat_id: chatId, user_id: msg.from.id }),
    ]);
    if (!['creator', 'administrator'].includes(user.status)) throw new TargetError('你需要是目标群/频道的管理员才能连接或订阅。');
    if (!['creator', 'administrator'].includes(bot.status) ||
        (info.type === 'channel' && bot.status !== 'creator' && bot.can_post_messages !== true)) {
      throw new TargetError('请先把机器人设为目标群/频道的管理员；频道还需开启“发布消息”权限。');
    }
  }
  if (info && !['group', 'supergroup', 'channel'].includes(info.type)) throw new TargetError('只支持个人私聊、群聊和频道。');
  if (info) return { chat_id: chatId, type: info.type, title: clip(info.title || chatId, 200),
    username: info.username || null, is_forum: info.is_forum ? 1 : 0,
    enabled: stored?.enabled ?? 1, known: Boolean(stored || allowedChat(env, chatId)) };
  if (stored) return { ...stored, known: true };
  if (allowedChat(env, chatId)) return { chat_id: chatId, type: 'supergroup', title: chatId,
    username: null, is_forum: 1, enabled: 1, known: true };
  throw new TargetError('目标尚未连接。请先 /target add 聊天ID，或 /sub owner/repo --to 聊天ID。');
}

export function threadFor(target, msg, options) {
  const thread = options.topic ?? (options.to === undefined || options.to === 'here' ? msg.message_thread_id ?? 0 : 0);
  if (!Number.isSafeInteger(thread) || thread < 0) throw new TargetError('话题 ID 无效。');
  if (thread && (target.type !== 'supergroup' || !target.is_forum)) throw new TargetError('只有开启话题的超级群支持 --topic；个人和频道不支持话题。');
  return thread;
}

export function requireConnected(target) {
  if (!target.known || !target.enabled) throw new TargetError('目标未连接或已停用，请先使用 /target add 或 /sub 重新连接。');
}

export function registerTarget(db, target, user, receipt, token, now) {
  return db.prepare(`INSERT INTO destinations (chat_id, type, title, username, is_forum, enabled, registered_by, updated_at)
    SELECT ?, ?, ?, ?, ?, 1, ?, ? WHERE EXISTS (SELECT 1 FROM receipts WHERE id = ? AND token = ?)
    ON CONFLICT(chat_id) DO UPDATE SET type = excluded.type, title = excluded.title, username = excluded.username,
      is_forum = excluded.is_forum, enabled = 1, registered_by = excluded.registered_by, updated_at = excluded.updated_at`)
    .bind(target.chat_id, target.type, target.title, target.username, target.is_forum, String(user), now, receipt, token);
}

export async function replyDestination(env, msg, newlyConnected, removed) {
  const chat = String(msg.chat.id);
  const thread = msg.message_thread_id ?? 0;
  if (chat === String(msg.from.id) || newlyConnected === chat) return { chat, thread };
  if (removed !== chat) {
    const stored = await env.DB.prepare('SELECT enabled FROM destinations WHERE chat_id = ?').bind(chat).first();
    if (stored ? stored.enabled : allowedChat(env, chat)) return { chat, thread };
  }
  return { chat: String(msg.from.id), thread: 0 };
}
