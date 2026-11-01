// One action at a time (invariant I7). A second request while one runs is refused, not queued,
// so the user never has a stale click applied later without seeing it.

export class ActionLock {
  #busy = false;

  get busy(): boolean {
    return this.#busy;
  }

  /** Runs `fn` if free; returns `{ ran: false }` immediately if another action is running. */
  async tryRun<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.#busy) return { ran: false };
    this.#busy = true;
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.#busy = false;
    }
  }
}
