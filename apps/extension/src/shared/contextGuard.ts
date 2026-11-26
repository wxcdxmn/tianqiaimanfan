/**
 * 扩展重载后，页面里残留的旧 content script 仍会调用已销毁的
 * `chrome.*` API，浏览器因此抛出 "Extension context invalidated"。
 * 这些守卫让旧脚本自检 context、失效时安静退出，只提示刷新页面。
 */

type ChromeRuntimeLike = {
  id?: unknown;
  connect?: (name: string) => unknown;
};

/** 事件回调签名放宽为 any[]：chrome 的监听器签名各家不一，守卫只负责透传。 */
type Listener = (...args: any[]) => unknown;

export function isExtensionContextAlive(): boolean {
  try {
    const runtime = (globalThis as { chrome?: { runtime?: ChromeRuntimeLike } })
      .chrome?.runtime;
    return !!runtime
      && typeof runtime.id === 'string'
      && (runtime.id as string).length > 0;
  } catch {
    return false;
  }
}

/**
 * 包一层事件回调：context 失效时不再执行、也不再向浏览器抛
 * "Extension context invalidated"，改为输出一条可读的刷新提示。
 */
export function guardListener<T extends Listener>(listener: T, label = ''): T {
  const guarded = (...args: any[]): unknown => {
    if (!isExtensionContextAlive()) {
      console.info(
        `[tianqiaimanfan] 扩展已重新加载，本页脚本停止工作，请刷新页面${label ? `（${label}）` : ''}`,
      );
      return undefined;
    }
    try {
      return listener(...args);
    } catch (error) {
      if (!isExtensionContextAlive()) {
        console.info('[tianqiaimanfan] 扩展已重新加载，请刷新页面');
        return undefined;
      }
      throw error;
    }
  };
  return guarded as T;
}

/**
 * `chrome.runtime.connect` 在 context 失效时会直接抛错，这里返回 null
 * 让调用方走「扩展已失效」分支，而不是炸出未捕获异常。
 */
export function tryConnect(
  runtime: ChromeRuntimeLike | undefined,
  name: string,
): unknown | null {
  if (!runtime?.connect || !isExtensionContextAlive()) {
    console.info('[tianqiaimanfan] 扩展已重新加载，请刷新页面');
    return null;
  }
  try {
    return runtime.connect(name);
  } catch (error) {
    console.info(
      '[tianqiaimanfan] 扩展连接失败（多为扩展刚被重新加载，请刷新页面）:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
