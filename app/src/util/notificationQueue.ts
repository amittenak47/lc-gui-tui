export interface Notification { id: number; text: string; exiting: boolean; fast: boolean }

export const MAX_VISIBLE = 4;
type Waiting = { id: number; text: string; duration: number };

/** Notices leave as a deck. Unfolding pauses its clock until it folds again. */
export class NotificationQueue {
  private sequence = 0;
  private waiting: Waiting[] = [];
  private visible: Notification[] = [];
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private deckTimer: ReturnType<typeof setTimeout> | undefined;
  private hold = 2200;
  private expanded = false;
  private reduced = false;
  private listeners = new Set<() => void>();
  snapshot = () => this.visible;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  setReducedMotion(value: boolean) { this.reduced = value; }
  setExpanded(value: boolean) {
    this.expanded = value;
    this.armDeck();
  }
  private live() { return this.visible.filter(entry => !entry.exiting); }
  private armDeck() {
    clearTimeout(this.deckTimer);
    if (this.expanded || this.live().length === 0) return;
    const cap = this.waiting.length >= 5 ? 450 : this.waiting.length >= 2 ? 900 : Infinity;
    this.deckTimer = setTimeout(() => this.dismissDeck(), Math.min(this.hold, cap));
  }

  /** The text is on screen (not leaving) or waiting its turn. */
  has(text: string): boolean {
    return this.live().some(entry => entry.text === text) || this.waiting.some(entry => entry.text === text);
  }

  show(text: string, duration = 2200): number {
    const item = { id: ++this.sequence, text, duration: Math.max(1400, duration) };
    if (this.waiting.length === 0 && this.visible.length < MAX_VISIBLE && !this.visible.some(entry => entry.exiting)) {
      this.present(item);
    } else {
      this.waiting.push(item);
    }
    this.armDeck();
    return item.id;
  }

  dismiss(id?: number) {
    if (this.waiting.some(item => item.id === id)) {
      this.waiting = this.waiting.filter(item => item.id !== id);
      return;
    }
    const current = this.visible.find(entry => entry.id === id);
    if (!current || current.exiting) return;
    this.exit([current.id]);
    this.armDeck();
  }

  /** Swiping a folded deck or letting its clock expire dismisses the batch. */
  dismissDeck() {
    clearTimeout(this.deckTimer);
    this.exit(this.live().map(entry => entry.id));
  }

  private exit(ids: number[]) {
    const fast = this.waiting.length >= 5;
    this.visible = this.visible.map(entry => ids.includes(entry.id) ? { ...entry, exiting: true, fast } : entry);
    for (const id of ids) {
      this.timers.set(id, setTimeout(() => this.remove(id), this.reduced ? 0 : fast ? 120 : 220));
    }
    this.emit();
  }

  private present(item: Waiting) {
    this.visible = [...this.visible, { id: item.id, text: item.text, exiting: false, fast: false }];
    this.hold = item.duration;
    this.emit();
  }

  private remove(id: number) {
    this.timers.delete(id);
    this.visible = this.visible.filter(entry => entry.id !== id);
    // A departing deck must clear the screen before the next batch comes in.
    if (!this.visible.some(entry => entry.exiting)) {
      while (this.waiting.length > 0 && this.visible.length < MAX_VISIBLE) this.present(this.waiting.shift()!);
      this.armDeck();
    }
    this.emit();
  }

  dispose() {
    clearTimeout(this.deckTimer);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.waiting = [];
    this.visible = [];
    this.listeners.clear();
  }
}
