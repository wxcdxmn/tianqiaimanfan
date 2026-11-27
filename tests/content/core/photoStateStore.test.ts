import { describe, expect, it, vi } from 'vitest';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import { LayerEditingState } from '../../../apps/extension/src/content/core/editing/layerEditingState';

describe('PhotoStateStore', () => {
  it('retains the layer session while the image is reused and disposes it when removed', () => {
    const store = new PhotoStateStore();
    const state = store.ensure('image-1', 'blob:original');
    const session = new LayerEditingState({ width: 1, height: 1, targetLang: 'zh-CN', layers: [] }, new Blob(['source']));
    state.layerEditing = session;
    session.active = true;
    const disposed = vi.fn(); session.subscribe(disposed);
    expect(store.ensure('image-1', 'blob:remounted').layerEditing).toBe(session);
    store.delete('image-1');
    expect(session.disposed).toBe(true);
    expect(session.active).toBe(false);
    expect(state.layerEditing).toBeUndefined();
    expect(disposed).toHaveBeenCalledOnce();
  });
  it('reuses state for the same key and keeps the original state identity', () => {
    const store = new PhotoStateStore();
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    const second = store.ensure('image-1', 'https://example.com/changed.jpg');

    expect(second).toBe(first);
    expect(second.originalUrl).toBe('https://example.com/one.jpg');
  });

  it('evicts the oldest state and revokes every owned object URL', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const oldest = store.ensure('image-1', 'https://example.com/one.jpg');
    oldest.translatedUrl = 'blob:translated-1';
    oldest.debugOriginalUrl = 'blob:debug-1';
    store.ensure('image-2', 'https://example.com/two.jpg');

    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('image-1')).toBeUndefined();
    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:translated-1'],
      ['blob:debug-1'],
    ]);
  });

  it('releases URLs exactly once when deleting and disposing states', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(200, { revokeObjectURL });
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    first.translatedUrl = 'blob:translated-1';
    const second = store.ensure('image-2', 'https://example.com/two.jpg');
    second.debugOriginalUrl = 'blob:debug-2';

    store.delete('image-1');
    store.delete('image-1');
    store.dispose();

    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:translated-1'],
      ['blob:debug-2'],
    ]);
    expect(store.get('image-2')).toBeUndefined();
  });

  it('does not evict protected active states until they are released', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const active = store.ensure('active', 'https://example.com/active.jpg');
    active.translatedUrl = 'blob:active';
    const release = store.protect('active');
    store.ensure('image-2', 'https://example.com/two.jpg');

    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('active')).toBe(active);
    expect(store.get('image-2')).toBeUndefined();
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:active');

    release();
    store.ensure('image-4', 'https://example.com/four.jpg');

    expect(store.get('active')).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:active');
  });

  it('refreshes LRU order on ensure so a displayed state outlives newer inserts', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const displayed = store.ensure('displayed', 'https://example.com/displayed.jpg');
    displayed.translatedUrl = 'blob:displayed';
    store.ensure('image-2', 'https://example.com/two.jpg');
    // sync 在新条目挂载后会对所有 mounted key 再 ensure;刷新插入序后 displayed 应排到最新。
    store.ensure('displayed', 'https://example.com/displayed.jpg');

    // 插入第三个条目时,应逐出未被刷新的 image-2,而不是显示中的 displayed。
    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('displayed')).toBe(displayed);
    expect(store.get('image-2')).toBeUndefined();
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:displayed');
  });
});
