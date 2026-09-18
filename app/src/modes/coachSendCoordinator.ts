export type SendState = "preparing" | "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface SendTicket<T> {
  id: string;
  state: SendState;
  value?: T;
  error?: string;
  controller: AbortController;
}

/** Preparation reserves FIFO position. Cancellation never releases a running
 * transport until its executor has settled (including native invoke fallback). */
export class CoachSendCoordinator<T> {
  readonly tickets = new Map<string, SendTicket<T>>();
  private queue: SendTicket<T>[] = [];
  private active: SendTicket<T> | null = null;
  private edit: string | null = null;
  constructor(private execute: (value: T, signal: AbortSignal) => Promise<void>,
    private changed: (ticket: SendTicket<T>) => void) {}
  reserve(id: string): SendTicket<T> {
    const ticket: SendTicket<T> = { id, state: "preparing", controller: new AbortController() };
    this.tickets.set(id, ticket);
    this.queue.push(ticket);
    this.changed(ticket);
    return ticket;
  }
  ready(id: string, value: T): void {
    const t = this.tickets.get(id);
    if (!t || t.state !== "preparing") return;
    t.value = value; t.state = "queued"; this.changed(t); this.drain();
  }
  fail(id: string, error: unknown): void {
    const t = this.tickets.get(id);
    if (!t || t.state === "cancelled") return;
    t.state = "failed"; t.error = String(error); this.changed(t); this.drain();
  }
  abort(id: string): void {
    const t = this.tickets.get(id);
    if (!t || !["preparing", "queued", "running"].includes(t.state)) return;
    t.state = "cancelled"; t.controller.abort();
    if (this.edit === id) this.edit = null;
    this.changed(t); this.drain();
  }
  beginEdit(id: string): boolean {
    if (this.edit || this.tickets.get(id)?.state !== "queued") return false;
    this.edit = id; return true;
  }
  endEdit(id: string, value?: T): void {
    if (this.edit !== id) return;
    const t = this.tickets.get(id);
    if (t && value !== undefined) t.value = value;
    this.edit = null; this.drain();
  }
  get runningId(): string | null { return this.active?.id ?? null; }
  get busy(): boolean { return Boolean(this.active || this.queue.length); }
  dispose(): void { for (const t of this.tickets.values()) this.abort(t.id); }
  drain(): void {
    if (this.active || this.edit) return;
    while (this.queue.length && ["cancelled", "failed"].includes(this.queue[0].state)) this.queue.shift();
    const t = this.queue[0];
    if (!t || t.state !== "queued" || t.value === undefined) return;
    this.queue.shift(); this.active = t; t.state = "running"; this.changed(t);
    void (async () => {
      try {
        await this.execute(t.value!, t.controller.signal);
        if (!t.controller.signal.aborted) t.state = "completed";
      } catch (error) {
        if (!t.controller.signal.aborted) { t.state = "failed"; t.error = String(error); }
      } finally {
        this.active = null; this.changed(t); this.drain();
      }
    })();
  }
}
