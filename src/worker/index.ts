import { api } from './api';
import { followUpSweep, runOnReceive } from './assistant';
import { receive, sweepUnindexed } from './ingest';
import { runBulk } from './bulk';
import { serveMedia } from './media';
import { pollServers } from './servers';
import { applyRules } from './rules';
import { purgeActivity, purgeOld } from './purge';
import { deliverDue } from './send';
import type { Env } from './util';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api.fetch(request, env, ctx);
    if (url.pathname.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD')) return serveMedia(env, url.pathname);
    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      // Who may put Sadi Mail inside a frame: nobody, unless a host origin was allowed on purpose.
      const allowed = env.EMBED_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', `frame-ancestors 'self'${allowed.length ? ' ' + allowed.join(' ') : ''}`);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return new Response('Not found', { status: 404 });
  },

  /**
   * Cloudflare Email Routing calls this for each inbound message.
   *
   * If the raw message cannot be written to R2 this throws, so the message is not reported as
   * accepted. Cloudflare does not document whether the sender then retries, so that behaviour
   * must be confirmed on a real domain before it is relied on.
   */
  async email(message, env, ctx) {
    const bytes = await new Response(message.raw).arrayBuffer();
    const result = await receive(env, { bytes, envelopeFrom: message.from, envelopeTo: message.to });
    if (result.outcome === 'rejected') message.setReject(result.reason);
    // Agents run after the mail is safely stored, and a failing agent never affects delivery.
    else if (result.threadId) {
      // Rules first, so a message a rule files away is already filed when the agents look at it.
      await applyRules(env, result.threadId).catch((err) => console.error(JSON.stringify({ at: 'rules.apply', error: String(err) })));
      ctx.waitUntil(runOnReceive(env, result.threadId).catch((err) => console.error(JSON.stringify({ at: 'agents.onReceive', error: String(err) }))));
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await deliverDue(env);
        } catch (err) {
          console.error(JSON.stringify({ at: 'cron.deliverDue', error: String(err) }));
        }
        try {
          await runBulk(env);
        } catch (err) {
          console.error(JSON.stringify({ at: 'cron.runBulk', error: String(err) }));
        }
        try {
          await pollServers(env);
        } catch (err) {
          console.error(JSON.stringify({ at: 'cron.pollServers', error: String(err) }));
        }
        try {
          if (new Date().getUTCMinutes() % 15 === 0) await followUpSweep(env);
          if (new Date().getUTCMinutes() === 7) { await purgeOld(env); await purgeActivity(env); }
        } catch (err) {
          console.error(JSON.stringify({ at: 'cron.followUp', error: String(err) }));
        }
        try {
          const repaired = await sweepUnindexed(env);
          if (repaired) console.warn(JSON.stringify({ at: 'cron.sweep', repaired }));
        } catch (err) {
          console.error(JSON.stringify({ at: 'cron.sweep', error: String(err) }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
