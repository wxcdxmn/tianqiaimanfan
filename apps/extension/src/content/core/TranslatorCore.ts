import type {
  ImageTarget,
  PhotoState,
  SiteAdapter,
} from './types';
import {
  createUiElements,
  injectStyles,
  renderUi,
} from './ui';
import type { UiElements } from './ui';
import { destroyTranslationButton, refreshTranslationButton } from './ui/translationButton';
import type { ScreenshotRect, ScreenshotSelection } from './screenshot';
import { createImageTranslationExecutionModule } from './translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from './translation/imageTranslationExecutionArbiter';
import { ImageTranslationController } from './translation/imageTranslationController';
import { PhotoStateStore } from './state/photoStateStore';
import { ReadingModeController } from './reading/readingModeController';
import { CardStateController } from './ui/cardState';
import { ScreenshotController } from './screenshot/screenshotController';
import { createDefaultReaderEngineReadingModeModule } from './reading/defaultReaderEngineReadingModeModule';
import type { ReaderEngineReadingModeModulePort } from './reading/readerEngineReadingModeModule';
import { createSiteReadingModeAdapter } from './reading/siteReadingModeAdapter';
import { ImageLayerEditor } from './editing/imageLayerEditor';
import { observeContentBooleanPreference } from './contentPreference';
import { createFloatingHub, type FloatingHub } from './ui/floatingHub';
import { AutoTranslationScheduler, type AutoTaskState } from './auto/autoTranslationScheduler';

type MountedImage = {
  key: string;
  target: ImageTarget;
  ui: UiElements;
  editor: ImageLayerEditor;
};

export class TranslatorCore {
  private adapter: SiteAdapter;
  private readonly stateStore = new PhotoStateStore();
  private readonly imageTranslationExecution = createImageTranslationExecutionModule();
  private readonly imageTranslationExecutionArbiter = createImageTranslationExecutionArbiter(
    this.imageTranslationExecution,
  );
  private readonly cardStateController = new CardStateController();
  private readonly screenshotController = new ScreenshotController(
    this.stateStore,
    this.imageTranslationExecutionArbiter,
    this.cardStateController,
  );
  private readonly imageTranslationController: ImageTranslationController;
  private readonly readingModeController: ReadingModeController;
  private readonly readerEngineReadingModeModule: ReaderEngineReadingModeModulePort | null;
  private readonly autoScheduler: AutoTranslationScheduler;
  private mounted = new Map<string, MountedImage>();
  private disposeObserver: (() => void) | null = null;
  private syncTimer: number | null = null;
  private stopped = false;
  private autoTranslate = false;
  private stopAutoTranslatePreference: (() => void) | null = null;
  private floatingHub: FloatingHub | null = null;

  constructor(adapter: SiteAdapter, contentSessionId?: string) {
    this.adapter = adapter;
    this.imageTranslationController = new ImageTranslationController(
      this.stateStore,
      this.imageTranslationExecutionArbiter,
      {
        resolveTarget: (key) => this.mounted.get(key)?.target,
        resolveTranslationContext: (target) => this.adapter.getTranslationContext?.(target) ?? {
          status: 'empty',
        },
        applyImage: (target, state) => this.applyMountedStateImage(target.key, state),
        render: (key) => this.renderForKey(key),
      },
    );
    this.readingModeController = new ReadingModeController(
      createSiteReadingModeAdapter(adapter),
      this.stateStore,
      this.imageTranslationExecutionArbiter,
      () => this.scheduleSync(),
      () => this.cancelScheduledSync(),
    );
    this.readerEngineReadingModeModule = contentSessionId
      ? createDefaultReaderEngineReadingModeModule(
          this.stateStore,
          this.imageTranslationExecutionArbiter,
        )
      : null;
    this.autoScheduler = new AutoTranslationScheduler({
      translate: (target) => this.imageTranslationController.handleTranslateClick(target),
      getTaskState: (target) => this.resolveAutoTaskState(target.key),
    });
  }

  private resolveAutoTaskState(key: string): AutoTaskState {
    const state = this.stateStore.get(key);
    if (!state) return 'idle';
    if (state.status === 'running') return 'working';
    if (state.translatedUrl || state.status !== 'idle') return 'done';
    return 'idle';
  }

  /**
   * Auto keeps a viewport-sized window of work instead of submitting the whole
   * chapter: the page under the reader's eyes lands first and the queue stays
   * bounded while scrolling.
   */
  private syncAutoTranslate(targets: readonly ImageTarget[]): void {
    if (!this.adapter.match()) {
      this.autoScheduler.reset();
      return;
    }
    const enabled = this.autoTranslate || this.adapter.isAutoTranslateEnabled?.() === true;
    if (!enabled) {
      this.autoScheduler.reset();
      return;
    }
    this.autoScheduler.plan(targets);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopAutoTranslatePreference?.();
    this.stopAutoTranslatePreference = null;
    if (this.disposeObserver) {
      this.disposeObserver();
      this.disposeObserver = null;
    }
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.readingModeController.teardown();
    this.autoScheduler.dispose();
    this.readerEngineReadingModeModule?.dispose();
    this.floatingHub?.destroy();
    this.floatingHub = null;
    this.screenshotController.dispose();
    this.imageTranslationController.dispose();
    this.imageTranslationExecutionArbiter.dispose('翻译核心已停止');
    for (const mounted of this.mounted.values()) {
      mounted.editor.dispose();
      destroyTranslationButton(mounted.ui.button);
      destroyTranslationButton(mounted.ui.debugDownloadButton);
    }
    this.stateStore.dispose();
  }

  start(): void {
    if (this.stopped) return;
    injectStyles();
    this.readerEngineReadingModeModule?.start();
    this.stopAutoTranslatePreference = observeContentBooleanPreference('autoTranslate', (enabled) => {
      if (this.stopped || this.autoTranslate === enabled) return;
      this.autoTranslate = enabled;
      this.readingModeController.setAutoTranslate(enabled);
      this.readerEngineReadingModeModule?.setAutoTranslate(enabled);
      this.scheduleSync();
    });
    this.disposeObserver = this.adapter.observe(() => this.scheduleSync());
    this.floatingHub = createFloatingHub({
      translateAll: () => this.translateAllImages(),
      startScreenshot: () => void this.startScreenshotTranslate(),
      toggleModes: () => this.toggleAllDisplayModes(),
    });
    this.sync();
  }

  async startScreenshotTranslate(): Promise<void> {
    await this.screenshotController.startScreenshotTranslate();
  }

  async translateImageInFloatingOverlay(
    originalUrl: string,
    imageElement: HTMLImageElement,
    fallbackDocumentRect: ScreenshotRect,
  ): Promise<void> {
    await this.screenshotController.translateImageInFloatingOverlay(
      originalUrl,
      imageElement,
      fallbackDocumentRect,
    );
  }

  async translateScreenshotSelection(selection: ScreenshotSelection): Promise<void> {
    await this.screenshotController.translateScreenshotSelection(selection);
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 100);
  }

  private cancelScheduledSync(): void {
    if (this.syncTimer === null) return;
    window.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private sync(): void {
    if (this.adapter.isReadingMode?.()) {
      this.readingModeController.sync();
      return;
    }

    // Reading DOM can disappear during SPA transitions. Detach its UI without
    // cancelling already-submitted work; stop() owns final cancellation.
    this.readingModeController.suspend();

    const targets = this.adapter.findImages();
    const currentKeys = new Set(targets.map((t) => t.key));

    for (const [key, mounted] of this.mounted) {
      if (!currentKeys.has(key)) {
        mounted.editor.dispose();
        destroyTranslationButton(mounted.ui.button);
        destroyTranslationButton(mounted.ui.debugDownloadButton);
        mounted.ui.host.remove();
        this.mounted.delete(key);
      }
    }

    for (const target of targets) {
      const mounted = this.mounted.get(target.key);
      if (mounted?.ui.host.isConnected) {
        refreshTranslationButton(mounted.ui.button);
        mounted.target = target;
        const state = this.stateStore.ensure(target.key, target.originalUrl);
        this.applyStateImage(target, state);
        mounted.editor.sync();
        continue;
      }
      if (mounted) {
        mounted.editor.dispose();
        destroyTranslationButton(mounted.ui.button);
        destroyTranslationButton(mounted.ui.debugDownloadButton);
        this.mounted.delete(target.key);
      }

      const key = target.key;
      const anchor = this.adapter.createUiAnchor(target);
      const ui = createUiElements();
      anchor.appendChild(ui.host);

      const editor = new ImageLayerEditor({
        ui,
        getState: () => this.stateStore.get(key),
        getImage: () => this.mounted.get(key)?.target.element,
        onChange: () => {
          const state = this.stateStore.get(key);
          if (state) this.applyMountedStateImage(key, state);
          this.renderForKey(key);
        },
        protect: () => this.stateStore.protect(key),
      });
      ui.button.addEventListener('click', async () => {
        if (this.stateStore.get(key)?.layerEditing?.active && !(await editor.finish())) return;
        const currentTarget = this.mounted.get(key)?.target ?? target;
        void this.imageTranslationController.handleTranslateClick(currentTarget);
      });
      ui.stageTimingCardToggleButton.addEventListener('click', () => {
        const state = this.stateStore.get(key);
        if (state) this.cardStateController.toggleStageTimingCard(state, () => this.renderForKey(key));
      });
      ui.errorDetailCardToggleButton.addEventListener('click', () => {
        const state = this.stateStore.get(key);
        if (state) this.cardStateController.toggleErrorDetailCard(state, () => this.renderForKey(key));
      });

      this.mounted.set(key, { key, target, ui, editor });
      const state = this.stateStore.ensure(key, target.originalUrl);
      this.applyStateImage(target, state);
      renderUi(ui, state);
      editor.sync();
    }

    this.syncFloatingHub();
    this.syncAutoTranslate(targets);
  }

  /** 悬浮窗可见性与状态行：有可翻译图片时显示，运行中显示进度。 */
  private syncFloatingHub(): void {
    if (!this.floatingHub) return;
    const states = [...this.mounted.values()]
      .map((mounted) => this.stateStore.get(mounted.key))
      .filter((state): state is PhotoState => !!state);
    const running = states.filter((state) => state.status === 'running').length;
    const total = this.mounted.size;
    this.floatingHub.setVisible(total > 0);
    this.floatingHub.setStatus(running, total);
    this.floatingHub.setBusy(running > 0);
  }

  /** 悬浮窗「翻译本页图片」：翻译所有空闲图片；若全部已完成则整页重翻。 */
  private translateAllImages(): void {
    const idle: ImageTarget[] = [];
    const all: ImageTarget[] = [];
    for (const mounted of this.mounted.values()) {
      all.push(mounted.target);
      const taskState = this.resolveAutoTaskState(mounted.key);
      if (taskState === 'idle') idle.push(mounted.target);
    }
    const targets = idle.length > 0 ? idle : all;
    for (const target of targets) {
      void this.imageTranslationController.handleTranslateClick(target);
    }
  }

  /** 悬浮窗「原文/译文」：对已有译图的条目整体切换显示模式。 */
  private toggleAllDisplayModes(): void {
    for (const mounted of this.mounted.values()) {
      const state = this.stateStore.get(mounted.key);
      if (!state?.translatedUrl) continue;
      if (state.mode === 'translated') {
        state.mode = 'original';
        state.status = 'showingOriginal';
      } else {
        state.mode = 'translated';
        state.status = 'translated';
      }
      this.applyStateImage(mounted.target, state);
      this.renderForKey(mounted.key);
    }
  }

  private renderForKey(key: string): void {
    const mounted = this.mounted.get(key);
    if (!mounted?.ui.host.isConnected) return;
    const state = this.stateStore.get(key) ?? null;
    renderUi(mounted.ui, state);
    mounted.editor.sync();
  }

  private applyMountedStateImage(key: string, state: PhotoState): void {
    const mounted = this.mounted.get(key);
    if (!mounted?.ui.host.isConnected) return;
    this.applyStateImage(mounted.target, state);
  }

  private applyStateImage(target: ImageTarget, state: PhotoState): void {
    if (!state.translatedUrl) return;
    const imageUrl = state.mode === 'translated' && !state.layerEditing?.active ? state.translatedUrl : state.originalUrl;
    this.adapter.applyImage(target, imageUrl);
  }

}
