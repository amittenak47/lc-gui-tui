export interface Notification { id: number; text: string; exiting: boolean; fast: boolean }
/** One presenter, ordered waiting list. New messages never replace old ones. */
export class NotificationQueue {
  private sequence = 0;
  private waiting: Array<{ id: number; text: string; duration: number }> = [];
  private visible: Notification[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline = 0;
  private reduced = false;
  private listeners = new Set<() => void>();
  snapshot = () => this.visible;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  setReducedMotion(value: boolean) { this.reduced = value; }
  private holdCap() { return this.waiting.length >= 5 ? 450 : this.waiting.length >= 2 ? 900 : Infinity; }
  private arm(duration: number, callback: () => void) { clearTimeout(this.timer); this.timer = setTimeout(callback, duration); }
  show(text: string, duration = 2200): number {
    const id = ++this.sequence;
    this.waiting.push({ id, text, duration: Math.max(1400, duration) });
    if (!this.visible.length) this.next();
    else if (!this.visible[0].exiting) {
      this.deadline = Math.min(this.deadline, Date.now() + this.holdCap());
      this.arm(Math.max(0, this.deadline - Date.now()), () => this.dismiss(this.visible[0]?.id));
    }
    return id;
  }
  dismiss(id?: number) {
    const current = this.visible[0];
    if (!current || current.id !== id) { this.waiting = this.waiting.filter(item => item.id !== id); return; }
    if (current.exiting) return;
    const fast = this.waiting.length >= 5;
    this.visible = [{ ...current, exiting: true, fast }]; this.emit();
    this.arm(this.reduced ? 0 : fast ? 120 : 220, () => this.next());
  }
  private next() {
    const item = this.waiting.shift();
    this.visible = item ? [{ id: item.id, text: item.text, exiting: false, fast: this.waiting.length >= 5 }] : [];
    this.emit();
    if (item) {
      const hold = Math.min(item.duration, this.holdCap()); this.deadline = Date.now() + hold;
      this.arm(hold, () => this.dismiss(item.id));
    }
  }
  dispose() { clearTimeout(this.timer); this.waiting = []; this.visible = []; this.listeners.clear(); }
}
