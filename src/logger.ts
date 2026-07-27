import { inspect } from 'node:util';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  silent: 99,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, colors: false, breakLength: 120 })))
    .join(' ');
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, args: unknown[]): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${fmt(args)}\n`;
  process.stderr.write(line);
}

export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    trace: (...a) => emit('trace', scope, a),
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub: string) => createLogger(`${scope}:${sub}`),
  };
}

export const log = createLogger('tinyclaw');

/** Baileys expects a pino-shaped logger. This adapts ours to that interface. */
export function baileysLogger(level: LogLevel): Record<string, unknown> {
  const l = createLogger('wa');
  const make = (lvl: LogLevel): Record<string, unknown> => ({
    level,
    // Baileys calls these as (obj, msg) or (msg)
    trace: (o: unknown, m?: string) => lvl === 'silent' || l.trace(m ?? '', o),
    debug: (o: unknown, m?: string) => lvl === 'silent' || l.debug(m ?? '', o),
    info: (o: unknown, m?: string) => lvl === 'silent' || l.info(m ?? '', o),
    warn: (o: unknown, m?: string) => lvl === 'silent' || l.warn(m ?? '', o),
    error: (o: unknown, m?: string) => lvl === 'silent' || l.error(m ?? '', o),
    fatal: (o: unknown, m?: string) => lvl === 'silent' || l.error(m ?? '', o),
    child: () => make(lvl),
  });
  return make(level);
}
