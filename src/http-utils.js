export async function fetchWithTimeout(url, options = {}) {
  const {
    timeoutMs = 5000,
    timeoutMessage,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'user-agent': 'SignalRSS/0.1 (+https://localhost)',
        ...(fetchOptions.headers || {}),
      },
    });
  } catch (error) {
    if (error.name === 'AbortError' && timeoutMessage) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
