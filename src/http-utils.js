import { assertSafeHttpUrl } from './url-security.js';

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

function contentLength(response) {
  const value = response.headers.get('content-length');
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function assertContentLengthWithinLimit(response, maxBytes) {
  if (!maxBytes) return;
  const length = contentLength(response);
  if (length !== null && length > maxBytes) {
    throw new Error(`Response body too large: ${length} bytes exceeds ${maxBytes}`);
  }
}

export async function responseArrayBufferWithLimit(response, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  assertContentLengthWithinLimit(response, maxBytes);

  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    if (maxBytes && buffer.byteLength > maxBytes) {
      throw new Error(`Response body too large: ${buffer.byteLength} bytes exceeds ${maxBytes}`);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes && total > maxBytes) {
        throw new Error(`Response body too large: ${total} bytes exceeds ${maxBytes}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

export async function responseTextWithLimit(response, options = {}) {
  const buffer = await responseArrayBufferWithLimit(response, options);
  return new TextDecoder().decode(buffer);
}

export async function fetchWithTimeout(url, options = {}) {
  const {
    timeoutMs = 5000,
    timeoutMessage,
    validateUrl = true,
    allowHttp = true,
    maxRedirects = 3,
    ...fetchOptions
  } = options;
  let currentUrl = String(url);
  const method = String(fetchOptions.method || 'GET').toUpperCase();

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    if (validateUrl) {
      await assertSafeHttpUrl(currentUrl, { allowHttp });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        ...fetchOptions,
        signal: controller.signal,
        headers: {
          'user-agent': 'SignalRSS/0.1 (+https://localhost)',
          ...(fetchOptions.headers || {}),
        },
      });

      if (
        [301, 302, 303, 307, 308].includes(response.status)
        && response.headers.get('location')
        && ['GET', 'HEAD'].includes(method)
      ) {
        if (redirectCount >= maxRedirects) {
          throw new Error(`Too many redirects for ${currentUrl}`);
        }
        currentUrl = new URL(response.headers.get('location'), currentUrl).toString();
        continue;
      }

      return response;
    } catch (error) {
      if (error.name === 'AbortError' && timeoutMessage) {
        throw new Error(timeoutMessage);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`Too many redirects for ${currentUrl}`);
}
