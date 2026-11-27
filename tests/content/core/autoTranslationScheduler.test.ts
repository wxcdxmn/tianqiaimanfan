import { describe, expect, it } from 'vitest';
import {
  AutoTranslationScheduler,
  type AutoTaskState,
} from '../../../apps/extension/src/content/core/auto/autoTranslationScheduler';
import type { ImageTarget } from '../../../apps/extension/src/content/core/types';

function createTarget(key: string): ImageTarget {
  return {
    key,
    element: {} as HTMLImageElement,
    originalUrl: `https://cdn.test/${key}.jpg`,
  };
}

/** Let the scheduler's internal microtasks run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function createHarness(priorities: Record<string, number>, options: {
  concurrency?: number;
  windowSize?: number;
} = {}) {
  const states = new Map<string, AutoTaskState>();
  const started: string[] = [];
  const finishHandlers = new Map<string, () => void>();
  const measureValues = new Map(Object.entries(priorities));

  const scheduler = new AutoTranslationScheduler({
    concurrency: options.concurrency ?? 2,
    windowSize: options.windowSize ?? 4,
    measure: (target) => measureValues.get(target.key) ?? Number.POSITIVE_INFINITY,
    getTaskState: (target) => states.get(target.key) ?? 'idle',
    translate: (target) => {
      started.push(target.key);
      states.set(target.key, 'working');
      return new Promise<void>((resolve) => {
        finishHandlers.set(target.key, () => {
          states.set(target.key, 'done');
          resolve();
        });
      });
    },
  });

  async function finish(key: string): Promise<void> {
    finishHandlers.get(key)?.();
    await flush();
  }

  function scrollTo(next: Record<string, number>): void {
    for (const [key, value] of Object.entries(next)) measureValues.set(key, value);
  }

  return { scheduler, states, started, finish, scrollTo };
}

describe('AutoTranslationScheduler', () => {
  it('only starts the nearest window, with bounded concurrency', async () => {
    const targets = ['a', 'b', 'c', 'd', 'e', 'f'].map(createTarget);
    const harness = createHarness(
      { a: 0, b: 10, c: 20, d: 30, e: 40, f: 50 },
      { concurrency: 2, windowSize: 3 },
    );

    harness.scheduler.plan(targets);
    await flush();
    expect(harness.started).toEqual(['a', 'b']);

    await harness.finish('a');
    expect(harness.started).toEqual(['a', 'b', 'c']);

    await harness.finish('b');
    await harness.finish('c');
    // Nothing beyond the window was submitted while the reader stands still.
    expect(harness.started).toEqual(['a', 'b', 'c']);
    expect(harness.scheduler.inFlightCount).toBe(0);
  });

  it('moves the window when the reader scrolls', async () => {
    const targets = ['a', 'b', 'c'].map(createTarget);
    const harness = createHarness({ a: 0, b: 20, c: 90 }, { concurrency: 1, windowSize: 2 });

    harness.scheduler.plan(targets);
    await flush();
    expect(harness.started).toEqual(['a']);
    expect(harness.scheduler.queuedKeys).toEqual(['b']);

    // The reader scrolls past the first pages: c is now what they see.
    harness.scrollTo({ a: 200, b: 120, c: 0 });
    harness.scheduler.plan(targets);
    expect(harness.scheduler.queuedKeys).toEqual(['c', 'b']);

    await harness.finish('a');
    expect(harness.started).toEqual(['a', 'c']);
  });

  it('never re-submits finished pages', async () => {
    const targets = [createTarget('a'), createTarget('b')];
    const harness = createHarness({ a: 0, b: 10 }, { concurrency: 1, windowSize: 2 });

    harness.scheduler.plan(targets);
    await flush();
    await harness.finish('a');
    expect(harness.started).toEqual(['a', 'b']);

    harness.scheduler.plan(targets);
    await flush();
    expect(harness.started).toEqual(['a', 'b']);
    expect(harness.scheduler.queuedKeys).toEqual([]);
  });

  it('stops handing out work after reset but lets in-flight pages finish', async () => {
    const targets = ['a', 'b', 'c'].map(createTarget);
    const harness = createHarness({ a: 0, b: 10, c: 20 }, { concurrency: 1, windowSize: 3 });

    harness.scheduler.plan(targets);
    await flush();
    expect(harness.started).toEqual(['a']);

    harness.scheduler.reset();
    expect(harness.scheduler.isActive).toBe(false);
    expect(harness.scheduler.queuedKeys).toEqual([]);

    await harness.finish('a');
    expect(harness.started).toEqual(['a']);
    expect(harness.states.get('a')).toBe('done');
  });

  it('counts a failed page as done so it is not retried on every sync', async () => {
    const states = new Map<string, AutoTaskState>();
    const started: string[] = [];
    const scheduler = new AutoTranslationScheduler({
      concurrency: 1,
      windowSize: 2,
      measure: () => 0,
      getTaskState: (target) => states.get(target.key) ?? 'idle',
      translate: (target) => {
        started.push(target.key);
        states.set(target.key, 'working');
        return Promise.reject(new Error('pipeline failed'));
      },
    });
    const targets = [createTarget('a')];

    scheduler.plan(targets);
    await flush();
    states.set('a', 'done');
    scheduler.plan(targets);
    await flush();

    expect(started).toEqual(['a']);
  });

  it('drops queued targets that left the window so long sessions do not retain DOM nodes', async () => {
    const harness = createHarness({ a: 0, b: 1, c: 2 }, { concurrency: 1, windowSize: 2 });
    const targets = [createTarget('a'), createTarget('b'), createTarget('c')];

    harness.scheduler.plan(targets);
    expect(harness.started).toEqual(['a']);
    // B 已入队但未启动;窗口滚到 C 后 B 出窗,不应滞留在 targets 里持有节点。
    harness.scrollTo({ c: 0 });
    harness.scheduler.plan([targets[2]]);
    expect(harness.scheduler.queuedKeys).toEqual(['c']);
    expect(harness.scheduler.targetCount).toBe(1);

    await harness.finish('a');
    harness.scheduler.plan([targets[2]]);
    expect(harness.scheduler.targetCount).toBe(1);
  });
});
