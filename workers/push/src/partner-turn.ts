/** One reply for a run of messages, independent of the account's role. */
export type TurnLine = { id: string; at: number; spoken: boolean };
export type TurnTimer = { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };

/**
 * A newer line supersedes an outstanding answer, but keeps its source ids in
 * the next turn. Originals remain in chat history. A model failure releases
 * the batch too; retrying the model belongs to the existing billing path.
 */
export class PartnerTurn<P> {
  private turns = new Map<
    string,
    {
      generation: number;
      lines: TurnLine[];
      page: P;
      timer?: unknown;
      started: number;
    }
  >();
  private generation = 0;

  constructor(
    private deps: {
      timer: TurnTimer;
      delayMs: number;
      maxWaitMs: number;
      now(): number;
      maxLines: number;
      reply(
        thread: string,
        lines: readonly TurnLine[],
        page: P,
        current: () => boolean,
      ): Promise<void>;
      failed(): void;
    },
  ) {}

  /** Only the open pause window accepts unnamed follow-up speech. */
  pendingSpeech(thread: string): boolean {
    const turn = this.turns.get(thread);
    return turn?.timer !== undefined && turn.lines.at(-1)?.spoken === true;
  }

  add(
    thread: string,
    line: TurnLine,
    page: P,
    delayMs = this.deps.delayMs,
    maxWaitMs = this.deps.maxWaitMs,
  ) {
    const old = this.turns.get(thread);
    if (old?.lines.some((x) => x.id === line.id)) return;
    if (old?.timer !== undefined) this.deps.timer.clear(old.timer);
    const turn = {
      generation: ++this.generation,
      lines: [...(old?.lines ?? []), line].slice(-this.deps.maxLines),
      page,
      started: old?.started ?? this.deps.now(),
      timer: undefined as unknown,
    };
    this.turns.set(thread, turn);
    const current = () => this.turns.get(thread) === turn;
    const run = async () => {
      if (!current()) return;
      turn.timer = undefined;
      try {
        await this.deps.reply(thread, turn.lines, turn.page, current);
      } catch {
        this.deps.failed();
      } finally {
        if (current()) this.turns.delete(thread);
      }
    };
    // Typing is already a complete message. Speech waits for a pause; a
    // bounded run flushes even when speech never pauses.
    if (!line.spoken || turn.lines.length >= this.deps.maxLines) return run();
    else
      turn.timer = this.deps.timer.set(
        () => void run(),
        Math.min(delayMs, Math.max(0, maxWaitMs - (this.deps.now() - turn.started))),
      );
  }

  cancel(thread: string) {
    const turn = this.turns.get(thread);
    if (turn?.timer !== undefined) this.deps.timer.clear(turn.timer);
    this.turns.delete(thread);
  }
}
