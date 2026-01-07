import { parsePositiveInt } from './config.js';

function truncateString(value, limit) {
  if (value.length <= limit) {
    return value;
  }

  if (limit === 1) {
    return '…';
  }

  return `${value.slice(0, limit - 1)}…`;
}

export function truncateUnityLogHistoryPayload(payload, { maxMessageChars, maxStackTraceChars } = {}) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const logs = Array.isArray(payload.logs) ? payload.logs : null;
  if (!logs) {
    return payload;
  }

  const messageLimit = parsePositiveInt(maxMessageChars, null);
  const stackTraceLimit = parsePositiveInt(maxStackTraceChars, null);
  if (!Number.isFinite(messageLimit) && !Number.isFinite(stackTraceLimit)) {
    return payload;
  }

  let changed = false;
  const nextLogs = logs.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const nextEntry = { ...entry };

    if (Number.isFinite(messageLimit) && typeof nextEntry.message === 'string') {
      const truncated = truncateString(nextEntry.message, messageLimit);
      if (truncated !== nextEntry.message) {
        nextEntry.message = truncated;
        changed = true;
      }
    }

    if (Number.isFinite(stackTraceLimit) && typeof nextEntry.stackTrace === 'string') {
      const truncated = truncateString(nextEntry.stackTrace, stackTraceLimit);
      if (truncated !== nextEntry.stackTrace) {
        nextEntry.stackTrace = truncated;
        changed = true;
      }
    }

    return nextEntry;
  });

  if (!changed) {
    return payload;
  }

  return { ...payload, logs: nextLogs };
}
