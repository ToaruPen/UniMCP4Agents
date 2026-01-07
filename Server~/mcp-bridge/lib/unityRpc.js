import { httpPost } from './http.js';

export async function tryCallUnityTool(unityHttpUrl, name, args, timeoutMs) {
  const response = await httpPost(
    `${unityHttpUrl}/api/mcp`,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: args || {},
      },
      id: 2,
    },
    timeoutMs
  );

  if (response?.error) {
    return { ok: false, error: response.error };
  }

  return { ok: true, result: response?.result ?? null };
}

export function stringifyToolCallResult(result) {
  const parts = [];
  for (const item of result?.content ?? []) {
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else {
      parts.push(JSON.stringify(item, null, 2));
    }
  }
  if (parts.length === 0) {
    return JSON.stringify(result, null, 2);
  }
  return parts.join('\n');
}

export function parseInvokeStaticMethodBase64Payload(invokeCall, label) {
  const outerMessage = invokeCall?.result?.message;
  if (typeof outerMessage !== 'string' || outerMessage.trim().length === 0) {
    throw new Error(`Missing message in unity.editor.invokeStaticMethod response (${label})`);
  }

  const outerJson = JSON.parse(outerMessage);
  const base64 = outerJson?.result;
  if (typeof base64 !== 'string' || base64.trim().length === 0) {
    throw new Error(`Missing base64 result from invokeStaticMethod response (${label})`);
  }

  const decoded = Buffer.from(base64, 'base64').toString('utf8');
  const payload = JSON.parse(decoded);
  const isError = payload?.status === 'error';

  return { payload, isError };
}
