#!/usr/bin/env node
import path from 'node:path';
import { AgentRegistry } from './agents/registry.js';
import { loadConfig, loadDotEnv, projectRoot } from './config.js';
import { createLogger, setLogLevel } from './logger.js';
import { Router } from './router.js';
import { Access } from './security.js';
import type { Principal } from './security.js';
import { StateStore } from './state.js';
import type { InboundMessage } from './transport.js';
import { WhatsAppTransport } from './whatsapp.js';

const log = createLogger('main');

async function main(): Promise<void> {
  await loadDotEnv(path.join(projectRoot(), '.env'));
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  log.info('tinyclaw starting');
  log.info(`  auth dir      ${cfg.authDir}`);
  log.info(`  state file    ${cfg.stateFile}`);
  log.info(`  default cwd   ${cfg.defaultCwd}`);
  log.info(`  permission    ${cfg.defaultPermission}`);

  const store = new StateStore(cfg);
  await store.load();

  const persisted = store.persistedAllowed();
  const access = new Access(persisted ? { ...cfg, allowed: persisted } : cfg);
  const allowed = access.list();
  if (allowed.length) log.info(`  allowlist     ${allowed.join(', ')}`);
  else if (cfg.selfChat) log.warn('  allowlist     empty — only the linked account\'s own chat can drive this');
  else log.error('  allowlist     empty and self-chat disabled — nothing will be accepted');

  const registry = new AgentRegistry(cfg);
  for (const adapter of registry.all()) {
    const av = await adapter.checkAvailable();
    log.info(`  ${adapter.id.padEnd(8)}      ${av.ok ? `ok — ${av.version ?? 'ready'}` : `unavailable — ${av.detail}`}`);
  }

  let router: Router | null = null;

  const transport = new WhatsAppTransport(cfg, {
    allowedNumbers: () => access.list(),
    onConnected: async (selfJid) => {
      log.info(`ready — message this account from ${allowed.length ? 'an allowed number' : 'its own chat'} to begin`);
      log.debug(`self jid ${selfJid}`);
    },
    onMessage: async (msg: InboundMessage) => {
      if (!router) return;
      const principal: Principal = {
        number: msg.senderNumber,
        jid: msg.senderJid,
        chatJid: msg.chatJid,
        isGroup: msg.isGroup,
        isSelf: msg.isSelf,
      };
      const decision = access.check(principal);
      if (!decision.ok) {
        if (!decision.silent) {
          log.warn(`rejected message from ${principal.number}: ${decision.reason}`);
          log.warn(`  to allow: add ${principal.number} to TINYCLAW_ALLOWED, or send "/allow ${principal.number}" from the owner`);
          await transport.sendText(msg.chatJid, "🚫 This bridge isn't open to you.");
        } else {
          log.debug(`ignored message from ${principal.number}: ${decision.reason}`);
        }
        return;
      }
      await transport.markRead(msg.chatJid, msg.ref).catch(() => undefined);
      await router.handle(msg, principal);
    },
  });

  router = new Router(cfg, store, registry, access, transport);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} — shutting down`);
    await router?.shutdown().catch(() => undefined);
    await store.flush().catch(() => undefined);
    await transport.stop().catch(() => undefined);
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
  process.on('uncaughtException', (err) => log.error('uncaught exception:', err));

  await transport.start();
}

main().catch((err: unknown) => {
  log.error('fatal:', err);
  process.exit(1);
});
