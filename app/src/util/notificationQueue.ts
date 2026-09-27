export interface Notification { id: number; text: string; exiting: boolean; fast: boolean }

/** How many notices share the stack at once. The rest wait their turn. */
export const MAX_VISIBLE = 4;
/** Each notice below the first leaves this much later, so a stack peels off top-down. */
const STAGGER_MS = 120;

type Waiting = { id: number; text: string; duration: number };

/**
 * A stack of short notices under the header.
 *
 * Up to {@link MAX_VISIBLE} are on screen together, newest underneath; each one
 * keeps its own clock and slides off when it runs out, and the ones below move
 * up. Past that they wait in order. New messages never replace old ones, and a
 * backlog shortens everyone's hold so the queue drains rather than piling up.
 */
export class NotificationQueue {
  private sequence = 0;
  private waiting: Waiting[] = [];
  private visible: Notification[] = [];
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private deadlines = new Map<number, number>();
  private reduced = false;
  private listeners = new Set<() => void>();
  snapshot = () => this.visible;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  setReducedMotion(value: boolean) { this.reduced = value; }
  private holdCap() { return this.waiting.length >= 5 ? 450 : this.waiting.length >= 2 ? 900 : Infinity; }
  private arm(id: number, ms: number, callback: () => void) {
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(callback, Math.max(0, ms)));
  }
  private live() { return this.visible.filter((entry) => !entry.exiting); }

  show(text: string, duration = 2200): number {
    const id = ++this.sequence;
    const item = { id, text, duration: Math.max(1400, duration) };
    if (this.waiting.length === 0 && this.live().length < MAX_VISIBLE) {
      this.present(item);
    } else {
      this.waiting.push(item);
      this.hurry();
    }
    return id;
  }

  dismiss(id?: number) {
    if (this.waiting.some((item) => item.id === id)) {
      this.waiting = this.waiting.filter((item) => item.id !== id);
      return;
    }
    const current = this.visible.find((entry) => entry.id === id);
    if (!current || current.exiting) return;
    const fast = this.waiting.length >= 5;
    this.deadlines.delete(current.id);
    this.visible = this.visible.map((entry) => (entry.id === id ? { ...entry, exiting: true, fast } : entry));
    this.emit();
    this.arm(current.id, this.reduced ? 0 : fast ? 120 : 220, () => this.remove(current.id));
  }

  private present(item: Waiting) {
    this.visible = [...this.visible, { id: item.id, text: item.text, exiting: false, fast: this.waiting.length >= 5 }];
    const hold = Math.min(item.duration, this.holdCap());
    this.deadlines.set(item.id, Date.now() + hold);
    this.arm(item.id, hold, () => this.dismiss(item.id));
    this.emit();
  }

  /** A backlog pulls every on-screen deadline in, oldest first. */
  private hurry() {
    const cap = this.holdCap();
    if (cap === Infinity) return;
    const now = Date.now();
    this.live().forEach((entry, index) => {
      const due = Math.min(this.deadlines.get(entry.id) ?? Infinity, now + cap + index * STAGGER_MS);
      this.deadlines.set(entry.id, due);
      this.arm(entry.id, due - now, () => this.dismiss(entry.id));
    });
  }

  private remove(id: number) {
    this.timers.delete(id);
    this.visible = this.visible.filter((entry) => entry.id !== id);
    while (this.waiting.length > 0 && this.live().length < MAX_VISIBLE) {
      this.present(this.waiting.shift()!);
    }
    this.hurry();
    this.emit();
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.deadlines.clear();
    this.waiting = [];
    this.visible = [];
    this.listeners.clear();
  }
}
