/**
 * A push-based async queue that can be consumed with `for await`.
 * Producers call push()/close(); the consumer drains in order and stops at close().
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) {
      this.waiters.shift()!({ value: undefined as never, done: true });
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** Splits a byte stream into complete lines, buffering partial trailing data. */
export class LineSplitter {
  private buf = '';

  push(chunk: string | Buffer): string[] {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (!this.buf.includes('\n')) return [];
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  }

  flush(): string[] {
    if (!this.buf) return [];
    const rest = this.buf;
    this.buf = '';
    return [rest.endsWith('\r') ? rest.slice(0, -1) : rest];
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Runs tasks strictly one at a time, in submission order. */
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;

  get pending(): number {
    return this.depth;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.depth++;
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined).finally(() => {
      this.depth--;
    });
    return next;
  }
}
