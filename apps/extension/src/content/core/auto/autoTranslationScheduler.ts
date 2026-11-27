import type { ImageTarget } from '../types';
import { currentViewport, viewportPriority } from './viewportPriority';

/**
 * RuneManga-style Auto mode.
 *
 * Instead of submitting every image on the page at once, Auto keeps a small
 * window of the pages nearest the viewport and feeds them to the translation
 * pipeline with a bounded concurrency. The window is re-planned on every
 * layout/scroll sync, so the work follows the reader down the chapter:
 *
 *  - the page being read gets its result first,
 *  - the queue stays bounded (no chapter-wide burst),
 *  - pages scrolled far away drop out before they are ever started.
 */

export type AutoTaskState = 'idle' | 'working' | 'done';

export type AutoTranslationSchedulerOptions = {
  translate: (target: ImageTarget) => Promise<void>;
  /** `idle` = not started yet, `working` = in flight, `done` = translated or failed. */
  getTaskState: (target: ImageTarget) => AutoTaskState;
  /** Viewport distance for a target; injected in tests. */
  measure?: (target: ImageTarget) => number;
  /** Max simultaneous translations. */
  concurrency?: number;
  /** How many of the nearest unfinished pages stay eligible. */
  windowSize?: number;
};

export const defaultAutoConcurrency = 2;
export const defaultAutoWindowSize = 4;

function defaultMeasure(target: ImageTarget): number {
  const element = target.element;
  if (typeof element?.getBoundingClientRect !== 'function') return 0;
  try {
    return viewportPriority(element.getBoundingClientRect(), currentViewport());
  } catch {
    // A detached or replaced element still deserves a slot.
    return 0;
  }
}

export class AutoTranslationScheduler {
  private readonly queue: string[] = [];
  private readonly targets = new Map<string, ImageTarget>();
  private readonly inFlight = new Set<string>();
  private active = false;
  private disposed = false;

  constructor(private readonly options: AutoTranslationSchedulerOptions) {}

  get isActive(): boolean {
    return this.active;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get queuedKeys(): readonly string[] {
    return this.queue;
  }

  /** 当前滞留在 targets 表里的条目数;plan 按窗口重建后应 ≤ 窗口 + in-flight。 */
  get targetCount(): number {
    return this.targets.size;
  }

  /**
   * Re-plan from the adapter's current target list. Cheap enough to run on
   * every viewport sync; callers pass the targets already mounted on the page.
   */
  plan(targets: readonly ImageTarget[]): void {
    if (this.disposed) return;
    this.active = true;

    const measure = this.options.measure ?? defaultMeasure;
    const windowSize = this.options.windowSize ?? defaultAutoWindowSize;

    const stateByKey = new Map<string, AutoTaskState>();
    for (const target of targets) {
      stateByKey.set(target.key, this.options.getTaskState(target));
    }

    const ranked = targets
      .filter((target) => stateByKey.get(target.key) !== 'done')
      .map((target) => ({ target, priority: measure(target) }))
      .sort((left, right) => left.priority - right.priority)
      .slice(0, windowSize);

    // The queue is fully derived from the current window, so pages that left the
    // viewport are dropped and the remaining ones are re-ordered by priority.
    // targets 同样按窗口重建:旧实现只增不减,working 中或被挤出窗口的条目
    // 会永久滞留(条目持有 ImageTarget.element,即已脱离 DOM 的图片节点),
    // 长章滚动会话持续累积。in-flight 的条目必须保留(pump 释放时要查)。
    const nextTargets = new Map<string, ImageTarget>();
    for (const { target } of ranked) {
      nextTargets.set(target.key, target);
    }
    for (const key of this.inFlight) {
      const retained = this.targets.get(key) ?? nextTargets.get(key);
      if (retained) nextTargets.set(key, retained);
    }
    this.targets.clear();
    for (const [key, target] of nextTargets) {
      this.targets.set(key, target);
    }

    const nextQueue: string[] = [];
    for (const { target } of ranked) {
      if (this.inFlight.has(target.key)) continue;
      if (stateByKey.get(target.key) !== 'idle') continue;
      nextQueue.push(target.key);
    }
    this.queue.length = 0;
    this.queue.push(...nextQueue);

    this.pump();
  }

  /** Stop handing out new work and drop the queue; in-flight tasks still finish. */
  reset(): void {
    this.active = false;
    this.queue.length = 0;
    this.targets.clear();
  }

  dispose(): void {
    this.reset();
    this.disposed = true;
    this.inFlight.clear();
  }

  private pump(): void {
    if (this.disposed || !this.active) return;
    const concurrency = this.options.concurrency ?? defaultAutoConcurrency;

    while (this.inFlight.size < concurrency && this.queue.length > 0) {
      const key = this.queue.shift();
      if (key === undefined) return;
      const target = this.targets.get(key);
      this.targets.delete(key);
      if (!target || this.inFlight.has(key)) continue;
      if (this.options.getTaskState(target) !== 'idle') continue;

      this.inFlight.add(key);
      let task: Promise<void>;
      try {
        // Start synchronously so the progress UI reflects the work immediately.
        task = Promise.resolve(this.options.translate(target));
      } catch {
        this.inFlight.delete(key);
        continue;
      }
      void task
        .catch(() => {
          // The PhotoState projection already surfaces the actionable error.
        })
        .finally(() => {
          this.inFlight.delete(key);
          if (!this.disposed && this.active) this.pump();
        });
    }
  }
}
