/**
 * How something Deckhand depends on — a helper process, a watch — comes back
 * when it goes away. One quick retry, because most losses are a restart that is
 * already over. If that fails too, nothing more happens until the 60-second scan
 * calls retry(), or something else asks for it, so a dependency that stays gone
 * adds nothing at rest (ARCHITECTURE.md, "Cost scales with what is on screen").
 * Staying up for a while earns the quick retry back. Timestamps, not a timer:
 * the only timer here is the one-shot quick retry.
 */
export class Recovery {
  private lostNow = false;
  private quickRetryLeft = true;
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly restart: () => void,
    private readonly quickRetryMs = 2000,
    private readonly stayedUpMs = 10_000,
  ) {}

  /** Call on every start. */
  started(): void {
    this.cancel();
    this.lostNow = false;
    this.startedAt = Date.now();
  }

  /** Call when it has gone away. */
  lost(): void {
    if (this.lostNow) return;
    this.lostNow = true;
    if (Date.now() - this.startedAt >= this.stayedUpMs) this.quickRetryLeft = true;
    if (!this.quickRetryLeft) return;
    this.quickRetryLeft = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.restart();
    }, this.quickRetryMs);
  }

  /** The 60-second scan: does nothing unless it is gone and no quick retry is pending. */
  retry(): void {
    if (this.lostNow && !this.timer) this.restart();
  }

  /** It is being stopped on purpose. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
