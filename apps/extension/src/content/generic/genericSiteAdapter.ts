import type { ImageTarget, SiteAdapter } from '../core/types';
import {
  genericAnchorAttr,
  genericImageKeyAttr,
  genericOriginalSrcAttr,
  scanGenericImages,
} from './genericImageScanner';
import {
  isGenericSiteAutoEnabled,
  isGenericSiteEnabled,
  primeGenericSiteState,
  subscribeGenericSiteState,
  toggleGenericSite,
} from './genericSiteRegistry';

const UI_TEXT_KEY = 'data-mt-generic';

/** Restore every image the adapter has rewritten back to its source URL. */
export function restoreGenericImages(root: ParentNode = document): void {
  for (const image of root.querySelectorAll<HTMLImageElement>(`img[${genericOriginalSrcAttr}]`)) {
    const original = image.getAttribute(genericOriginalSrcAttr);
    if (original && image.src !== original) image.src = original;
    image.removeAttribute(genericOriginalSrcAttr);
  }
}

function findAnchorIn(host: HTMLElement, key: string): HTMLElement | null {
  for (const child of host.children) {
    if (child instanceof HTMLElement && child.getAttribute(genericAnchorAttr) === key) return child;
  }
  return null;
}

/**
 * RuneManga-style fallback adapter: works on any page that shows manga pages as
 * plain <img> elements, but only after the user enables it for that host.
 */
export function createGenericSiteAdapter(): SiteAdapter {
  const host = location.hostname;
  void primeGenericSiteState(host);

  function createUiAnchor(target: ImageTarget): HTMLElement {
    const image = target.element;
    const container = image.parentElement ?? document.body;
    const existing = findAnchorIn(container, target.key);
    if (existing) return existing;

    if (window.getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const anchor = document.createElement('div');
    anchor.setAttribute(genericAnchorAttr, target.key);
    anchor.setAttribute(UI_TEXT_KEY, '');
    anchor.dataset.theme = 'light';

    const containerRect = container.getBoundingClientRect();
    const imageRect = image.getBoundingClientRect();
    anchor.style.cssText = [
      'position:absolute',
      `left:${Math.max(0, imageRect.right - containerRect.left - 40)}px`,
      `top:${Math.max(0, imageRect.top - containerRect.top + 8)}px`,
      'z-index:20',
    ].join(';');

    container.appendChild(anchor);
    return anchor;
  }

  return {
    match() {
      return isGenericSiteEnabled();
    },

    /** Auto mode is per site here, so it can follow the reader's viewport. */
    isAutoTranslateEnabled() {
      return isGenericSiteAutoEnabled();
    },

    findImages() {
      if (!isGenericSiteEnabled()) return [];
      return scanGenericImages().map((candidate) => ({
        element: candidate.element,
        key: candidate.key,
        originalUrl: candidate.url,
      }));
    },

    createUiAnchor,

    applyImage(target: ImageTarget, url: string): void {
      const image = target.element;
      if (!image.hasAttribute(genericImageKeyAttr)) {
        image.setAttribute(genericImageKeyAttr, target.key);
      }
      if (!image.hasAttribute(genericOriginalSrcAttr)) {
        image.setAttribute(genericOriginalSrcAttr, target.originalUrl);
      }
      if (image.src !== url) image.src = url;
    },

    observe(onChange: () => void) {
      let scheduled = false;
      const schedule = (): void => {
        if (scheduled) return;
        scheduled = true;
        window.setTimeout(() => {
          scheduled = false;
          onChange();
        }, 120);
      };

      const observer = new MutationObserver((mutations) => {
        const relevant = mutations.some((mutation) => !(mutation.target instanceof Element
          && mutation.target.closest(`[${genericAnchorAttr}]`)));
        if (relevant) schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      window.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule);

      const onLoad = (event: Event): void => {
        if (event.target instanceof HTMLImageElement) schedule();
      };
      document.addEventListener('load', onLoad, true);

      const unsubscribe = subscribeGenericSiteState(() => {
        if (!isGenericSiteEnabled()) restoreGenericImages();
        schedule();
      });

      // primeGenericSiteState may have resolved before this subscription existed.
      if (isGenericSiteEnabled()) schedule();

      return () => {
        observer.disconnect();
        window.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        document.removeEventListener('load', onLoad, true);
        unsubscribe();
      };
    },
  };
}

export async function toggleGenericSiteForCurrentHost(): Promise<boolean> {
  const state = await toggleGenericSite(location.hostname);
  return state.enabled;
}
