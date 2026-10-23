import { COMMANDS } from '../src/bot.js';

const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, WORKER_URL: base } = process.env;
if (!token || !/^[A-Za-z0-9_-]{1,256}$/.test(secret || '') || !base) {
  console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and WORKER_URL in .dev.vars.');
  process.exit(1);
}
const url = new URL(base);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  console.error('WORKER_URL must be an HTTPS origin, without a path, query or credentials.');
  process.exit(1);
}

async function call(method, body) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error();
    return result.result;
  } catch {
    console.error(`${method} failed; check the bot token, network and Worker URL.`);
    process.exit(1);
  }
}

const me = await call('getMe', {});
if (process.env.BOT_USERNAME?.toLowerCase() !== me.username?.toLowerCase()) {
  console.error(`Set BOT_USERNAME to ${me.username} in .dev.vars and Worker secrets before running setup.`);
  process.exit(1);
}
await call('setWebhook', { url: `${url.origin}/webhooks/telegram`, secret_token: secret, allowed_updates: ['message'], max_connections: 1 });
await call('setMyCommands', { commands: COMMANDS });
console.log(`Webhook and commands configured for @${me.username}. Pending updates were preserved.`);
