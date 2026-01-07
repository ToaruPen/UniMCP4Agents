export function getToolTimeoutMs(toolName, config) {
  // Conservative: retrying tool calls can cause duplicate side effects, so prefer a longer timeout
  // for operations that are expected to take time.
  const heavyPatterns = [
    /build/i,
    /import/i,
    /export/i,
    /pack/i,
    /compile/i,
    /test/i,
    /bake/i,
    /lighting/i,
    /optimi[sz]e/i,
  ];

  const isHeavy = heavyPatterns.some((pattern) => pattern.test(toolName));
  return isHeavy ? config.heavyToolTimeoutMs : config.defaultToolTimeoutMs;
}

export function clampTimeoutMs(timeoutMs, config) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return config.defaultToolTimeoutMs;
  }
  return Math.min(timeoutMs, config.maxToolTimeoutMs);
}
