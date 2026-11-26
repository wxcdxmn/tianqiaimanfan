/**
 * Chrome on Windows ignores WebGPU `powerPreference` and logs a warning on
 * every `requestAdapter()` call (crbug.com/369219127). Passing the hint there
 * only spams the console, so we skip it on Windows and keep it elsewhere.
 */
export function shouldHintHighPerformanceGpu(): boolean {
  try {
    const nav = (globalThis as {
      navigator?: {
        userAgentData?: { platform?: string };
        platform?: string;
        userAgent?: string;
      };
    }).navigator;
    if (!nav) return true;
    const platform = nav.userAgentData?.platform || nav.platform || '';
    if (/windows|win32/i.test(platform)) return false;
    if (!platform && /windows/i.test(nav.userAgent ?? '')) return false;
    return true;
  } catch {
    return true;
  }
}
