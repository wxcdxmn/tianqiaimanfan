import { createIcon } from './icons';
import { observeContentBooleanPreference } from '../contentPreference';
import { getExtensionRuntime } from '../../../shared/extensionRuntime';
import { sendExtensionControlCommand } from '../../../shared/extensionControlTransport';

const HUB_STYLE_ID = 'mt-hub-style';
const HUB_HOST_ID = 'mt-floating-hub';

export type FloatingHubCallbacks = {
  translateAll: () => void;
  startScreenshot: () => void;
  toggleModes: () => void;
};

export type FloatingHub = {
  setVisible: (visible: boolean) => void;
  setStatus: (running: number, total: number) => void;
  setBusy: (busy: boolean) => void;
  destroy: () => void;
};

const HUB_CSS = `
  .mt-x-hub {
    position: fixed;
    right: 18px;
    top: 96px;
    z-index: 2147483646;
    font-family: "MTX-SourceHanSans-CN", system-ui, sans-serif;
    pointer-events: none;
    opacity: 0;
    transform: translateY(-6px);
    transition: opacity 220ms ease, transform 220ms ease;
  }
  .mt-x-hub[data-visible='true'] { opacity: 1; transform: none; pointer-events: auto; }

  /* 收起态：HUD 光球 */
  .mt-x-hub-orb {
    width: 34px;
    height: 34px;
    border-radius: 12px;
    border: 1px solid oklch(0.8 0.14 205 / 0.45);
    background: linear-gradient(150deg, oklch(0.24 0.07 262 / 0.9), oklch(0.17 0.04 220 / 0.88));
    backdrop-filter: blur(14px) saturate(1.4);
    box-shadow: 0 0 12px oklch(0.75 0.13 205 / 0.35), 0 4px 18px oklch(0 0 0 / 0.4);
    cursor: pointer;
    display: grid;
    place-items: center;
    color: oklch(0.9 0.08 205);
    padding: 0;
  }
  .mt-x-hub-orb::after {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: oklch(0.85 0.14 205);
    box-shadow: 0 0 8px oklch(0.85 0.14 205 / 0.9);
    animation: mt-hub-pulse 2.4s ease-in-out infinite;
  }
  .mt-x-hub-orb[data-busy='true']::after {
    background: oklch(0.88 0.15 90);
    box-shadow: 0 0 10px oklch(0.88 0.15 90 / 0.9);
    animation-duration: 0.9s;
  }
  @keyframes mt-hub-pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 1; }
  }

  /* 展开态：HUD 面板 */
  .mt-x-hub-panel {
    display: none;
    width: 216px;
    border-radius: 14px;
    border: 1px solid oklch(0.78 0.12 205 / 0.42);
    background:
      repeating-linear-gradient(0deg, oklch(0.92 0.06 205 / 0.028) 0 1px, transparent 1px 4px),
      linear-gradient(165deg, oklch(0.2 0.055 262 / 0.88), oklch(0.14 0.03 220 / 0.86));
    backdrop-filter: blur(18px) saturate(1.5);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    box-shadow:
      0 0 0 1px oklch(0.8 0.12 205 / 0.1),
      0 10px 34px oklch(0 0 0 / 0.5),
      inset 0 0 26px oklch(0.72 0.12 205 / 0.07);
    color: oklch(0.94 0.02 220);
    overflow: hidden;
  }
  .mt-x-hub[data-collapsed='false'] .mt-x-hub-panel { display: block; animation: mt-hub-in 200ms cubic-bezier(.2,.9,.3,1); }
  .mt-x-hub[data-collapsed='false'] .mt-x-hub-orb { display: none; }
  @keyframes mt-hub-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.98); }
    to { opacity: 1; transform: none; }
  }

  /* HUD 四角括号 */
  .mt-x-hub-corner {
    position: absolute;
    width: 12px;
    height: 12px;
    border-color: oklch(0.85 0.14 205 / 0.85);
    border-style: solid;
    border-width: 0;
    pointer-events: none;
    z-index: 2;
  }
  .mt-x-hub-corner[data-c='nw'] { left: 4px; top: 4px; border-left-width: 1.6px; border-top-width: 1.6px; border-top-left-radius: 6px; }
  .mt-x-hub-corner[data-c='ne'] { right: 4px; top: 4px; border-right-width: 1.6px; border-top-width: 1.6px; border-top-right-radius: 6px; }
  .mt-x-hub-corner[data-c='sw'] { left: 4px; bottom: 4px; border-left-width: 1.6px; border-bottom-width: 1.6px; border-bottom-left-radius: 6px; }
  .mt-x-hub-corner[data-c='se'] { right: 4px; bottom: 4px; border-right-width: 1.6px; border-bottom-width: 1.6px; border-bottom-right-radius: 6px; }

  .mt-x-hub-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px 8px;
    cursor: grab;
    user-select: none;
    border-bottom: 1px solid oklch(0.75 0.08 205 / 0.18);
  }
  .mt-x-hub-head:active { cursor: grabbing; }
  .mt-x-hub-title {
    font-size: 12.5px;
    font-weight: 700;
    letter-spacing: 0.14em;
    background: linear-gradient(90deg, oklch(0.9 0.09 205), oklch(0.82 0.1 262));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .mt-x-hub-status {
    margin-left: auto;
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 9.5px;
    letter-spacing: 0.08em;
    color: oklch(0.78 0.1 205 / 0.85);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .mt-x-hub-status::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: oklch(0.85 0.14 205);
    box-shadow: 0 0 6px oklch(0.85 0.14 205 / 0.8);
  }
  .mt-x-hub[data-busy='true'] .mt-x-hub-status::before {
    background: oklch(0.88 0.15 90);
    box-shadow: 0 0 6px oklch(0.88 0.15 90 / 0.85);
    animation: mt-hub-pulse 0.9s ease-in-out infinite;
  }

  .mt-x-hub-body { display: flex; flex-direction: column; padding: 6px; gap: 2px; }
  .mt-x-hub-action {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12.5px;
    padding: 8px 10px;
    cursor: pointer;
    text-align: left;
    transition: background 140ms ease, border-color 140ms ease, box-shadow 140ms ease;
  }
  .mt-x-hub-action:hover:not(:disabled) {
    background: oklch(0.85 0.09 205 / 0.09);
    border-color: oklch(0.8 0.12 205 / 0.4);
    box-shadow: 0 0 10px oklch(0.8 0.13 205 / 0.16);
  }
  .mt-x-hub-action:active:not(:disabled) { transform: translateY(1px); }
  .mt-x-hub-action:disabled { opacity: 0.45; cursor: default; }
  .mt-x-hub-action .mt-x-icon { width: 15px; height: 15px; flex: 0 0 15px; color: oklch(0.85 0.11 205); display: inline-flex; }
  .mt-x-hub-action .mt-x-icon svg { width: 15px; height: 15px; }
  .mt-x-hub-action[data-hotkey]::after {
    content: attr(data-hotkey);
    margin-left: auto;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 9px;
    color: oklch(0.8 0.08 205 / 0.6);
    border: 1px solid oklch(0.8 0.08 205 / 0.3);
    border-radius: 4px;
    padding: 1px 4px;
  }

  /* 简洁模式开关行 */
  .mt-x-hub-switch-row { display: flex; align-items: center; gap: 9px; padding: 7px 10px; font-size: 12.5px; cursor: pointer; border-radius: 9px; transition: background 140ms ease; }
  .mt-x-hub-switch-row:hover { background: oklch(0.85 0.09 205 / 0.09); }
  .mt-x-hub-switch-row .mt-x-icon { width: 15px; height: 15px; flex: 0 0 15px; color: oklch(0.85 0.11 205); display: inline-flex; }
  .mt-x-hub-switch-row .mt-x-icon svg { width: 15px; height: 15px; }
  .mt-x-hub-switch {
    margin-left: auto;
    width: 28px;
    height: 15px;
    border-radius: 999px;
    border: 1px solid oklch(0.75 0.08 205 / 0.4);
    background: oklch(0.3 0.03 220 / 0.7);
    position: relative;
    transition: background 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
    flex: 0 0 28px;
  }
  .mt-x-hub-switch::after {
    content: '';
    position: absolute;
    left: 2px;
    top: 1.5px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: oklch(0.85 0.04 220);
    transition: transform 160ms cubic-bezier(.3,.9,.4,1), background 160ms ease;
  }
  .mt-x-hub-switch[data-on='true'] {
    background: oklch(0.62 0.11 205 / 0.55);
    border-color: oklch(0.85 0.13 205 / 0.7);
    box-shadow: 0 0 8px oklch(0.82 0.13 205 / 0.3);
  }
  .mt-x-hub-switch[data-on='true']::after { transform: translateX(12px); background: oklch(0.94 0.08 205); }

  .mt-x-hub-foot {
    padding: 5px 12px 7px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 8.5px;
    letter-spacing: 0.18em;
    color: oklch(0.72 0.06 205 / 0.45);
    border-top: 1px solid oklch(0.75 0.08 205 / 0.14);
    user-select: none;
  }
`;

function ensureHubStyles(): void {
  if (document.getElementById(HUB_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HUB_STYLE_ID;
  style.textContent = HUB_CSS;
  (document.head ?? document.documentElement).appendChild(style);
}

function actionButton(iconKey: Parameters<typeof createIcon>[0], label: string, hotkey: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mt-x-hub-action';
  const icon = document.createElement('span');
  icon.className = 'mt-x-icon';
  icon.appendChild(createIcon(iconKey));
  button.appendChild(icon);
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  button.setAttribute('data-hotkey', hotkey);
  return button;
}

export function createFloatingHub(callbacks: FloatingHubCallbacks): FloatingHub {
  ensureHubStyles();

  const host = document.createElement('div');
  host.id = HUB_HOST_ID;
  host.className = 'mt-x-hub';
  host.dataset.visible = 'false';
  host.dataset.collapsed = 'true';
  host.dataset.busy = 'false';

  const orb = document.createElement('button');
  orb.type = 'button';
  orb.className = 'mt-x-hub-orb';
  orb.title = '天恰漫翻 · 控制台';

  const panel = document.createElement('div');
  panel.className = 'mt-x-hub-panel';
  for (const corner of ['nw', 'ne', 'sw', 'se'] as const) {
    const span = document.createElement('span');
    span.className = 'mt-x-hub-corner';
    span.dataset.c = corner;
    panel.appendChild(span);
  }

  const head = document.createElement('div');
  head.className = 'mt-x-hub-head';
  const title = document.createElement('span');
  title.className = 'mt-x-hub-title';
  title.textContent = '天恰漫翻';
  const status = document.createElement('span');
  status.className = 'mt-x-hub-status';
  status.textContent = 'READY 0/0';
  head.appendChild(title);
  head.appendChild(status);

  const body = document.createElement('div');
  body.className = 'mt-x-hub-body';

  const translateButton = actionButton('translate', '翻译本页图片', 'GO');
  const screenshotButton = actionButton('original', '截图选区翻译', 'CAP');
  const toggleButton = actionButton('translated', '切换 原文/译文', 'SWAP');

  const simpleRow = document.createElement('div');
  simpleRow.className = 'mt-x-hub-switch-row';
  const simpleIcon = document.createElement('span');
  simpleIcon.className = 'mt-x-icon';
  simpleIcon.appendChild(createIcon('confirm'));
  const simpleLabel = document.createElement('span');
  simpleLabel.textContent = '简洁按钮模式';
  const simpleSwitch = document.createElement('span');
  simpleSwitch.className = 'mt-x-hub-switch';
  simpleSwitch.dataset.on = 'false';
  simpleRow.appendChild(simpleIcon);
  simpleRow.appendChild(simpleLabel);
  simpleRow.appendChild(simpleSwitch);

  body.appendChild(translateButton);
  body.appendChild(screenshotButton);
  body.appendChild(toggleButton);
  body.appendChild(simpleRow);

  const foot = document.createElement('div');
  foot.className = 'mt-x-hub-foot';
  foot.textContent = 'TIANQIAIMANFAN · LOCAL ENGINE';

  panel.appendChild(head);
  panel.appendChild(body);
  panel.appendChild(foot);
  host.appendChild(orb);
  host.appendChild(panel);
  (document.body ?? document.documentElement).appendChild(host);

  // 展开 / 收起
  const setCollapsed = (collapsed: boolean): void => {
    host.dataset.collapsed = String(collapsed);
  };
  orb.addEventListener('click', (event) => {
    event.stopPropagation();
    setCollapsed(false);
  });

  // 拖动（头部按住移动整个悬浮窗）
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let originLeft = 0;
  let originTop = 0;
  head.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    dragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    const rect = host.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    host.style.left = `${rect.left}px`;
    host.style.top = `${rect.top}px`;
    host.style.right = 'auto';
    head.setPointerCapture(event.pointerId);
  });
  head.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const nextLeft = Math.max(0, Math.min(originLeft + event.clientX - dragStartX, window.innerWidth - 60));
    const nextTop = Math.max(0, Math.min(originTop + event.clientY - dragStartY, window.innerHeight - 40));
    host.style.left = `${nextLeft}px`;
    host.style.top = `${nextTop}px`;
  });
  head.addEventListener('pointerup', () => { dragging = false; });
  head.addEventListener('pointercancel', () => { dragging = false; });

  // 点击页面空白处收起
  const onDocClick = (event: Event): void => {
    if (host.dataset.collapsed === 'false' && !host.contains(event.target as Node)) setCollapsed(true);
  };
  document.addEventListener('click', onDocClick, true);

  // 功能回调
  const withFeedback = (fn: () => void): (() => void) => () => {
    try { fn(); } catch (error) { console.warn('[tianqiaimanfan] 悬浮窗操作失败', error); }
  };
  translateButton.addEventListener('click', withFeedback(callbacks.translateAll));
  screenshotButton.addEventListener('click', withFeedback(callbacks.startScreenshot));
  toggleButton.addEventListener('click', withFeedback(callbacks.toggleModes));

  // 简洁模式：读取 + 写入设置
  const stopSimpleObserver = observeContentBooleanPreference('simpleButtons', (enabled) => {
    simpleSwitch.dataset.on = String(enabled);
  });
  simpleRow.addEventListener('click', () => {
    const runtime = getExtensionRuntime();
    if (!runtime) return;
    const next = simpleSwitch.dataset.on !== 'true';
    void sendExtensionControlCommand(
      { kind: 'update-interface-preferences', preferences: { simpleButtons: next } },
      runtime,
    ).catch(() => {});
  });

  return {
    setVisible(visible) {
      host.dataset.visible = String(visible);
    },
    setStatus(running, total) {
      status.textContent = `${running > 0 ? 'WORK' : 'READY'} ${total - running}/${total}`;
      host.dataset.busy = running > 0 ? 'true' : 'false';
      orb.dataset.busy = running > 0 ? 'true' : 'false';
    },
    setBusy(busy) {
      translateButton.disabled = busy;
      screenshotButton.disabled = busy;
    },
    destroy() {
      document.removeEventListener('click', onDocClick, true);
      stopSimpleObserver();
      host.remove();
    },
  };
}
