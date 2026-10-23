const encoder = new TextEncoder();

export function ids(value = '') {
  return value.split(',').map((id) => id.trim()).filter(Boolean);
}

export function configured(env) {
  return Boolean(env.DB && env.TELEGRAM_BOT_TOKEN && env.GITHUB_WEBHOOK_SECRET &&
    /^[A-Za-z0-9_-]{1,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || '') &&
    /^[A-Za-z0-9_]+$/.test(env.BOT_USERNAME || '') &&
    ids(env.ALLOWED_USER_IDS).length && ids(env.ALLOWED_USER_IDS).every((id) => /^[1-9]\d*$/.test(id)) &&
    ids(env.ALLOWED_CHAT_IDS).every((id) => /^-?[1-9]\d*$/.test(id)));
}

export function allowedChat(env, chatId) {
  const chats = ids(env.ALLOWED_CHAT_IDS);
  return (chats.length ? chats : ids(env.ALLOWED_USER_IDS)).includes(String(chatId));
}

export function allowedUser(env, userId) {
  return ids(env.ALLOWED_USER_IDS).includes(String(userId));
}

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

export async function validGitHubSignature(secret, body, signature) {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature || '')) return false;
  const bytes = Uint8Array.from(signature.slice(7).match(/../g), (hex) => parseInt(hex, 16));
  return crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), bytes, body);
}

export async function equalSecret(expected, actual) {
  if (!expected || !actual || actual.length > 256) return false;
  // Web Crypto performs signature verification without a JS string equality check.
  const key = await hmacKey('github-tg-bot/secret-comparison', ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(expected));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(actual));
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'Payload too large');
  if (!request.body) throw new HttpError(400, 'Missing body');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, 'Payload too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function parseBody(body) {
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload;
  } catch { throw new HttpError(400, 'Invalid JSON'); }
}
