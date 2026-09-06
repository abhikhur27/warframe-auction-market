const DEFAULT_API_BASE = 'https://api.warframe.market/v2';
const DEFAULT_PLATFORM = 'pc';
const DEFAULT_LANGUAGE = 'en';
const DEFAULT_REQUEST_DELAY_MS = 360;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallback;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

function makeApiError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function summarizeResponseError(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  try {
    return JSON.stringify(value).slice(0, 200);
  } catch {
    return String(value).slice(0, 200);
  }
}

function createMarketApiClient(options = {}) {
  const baseUrl = String(options.baseUrl || DEFAULT_API_BASE).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleepImpl = options.sleepImpl || sleep;
  const requestDelayMs = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required.');
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer.');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer.');
  }

  const state = {
    active: 0,
    pending: [],
    requests: 0,
    retries: 0,
    failures: 0,
  };

  async function runLimited(task) {
    if (state.active >= maxConcurrent) {
      await new Promise((resolve) => state.pending.push(resolve));
    }

    state.active += 1;
    try {
      return await task();
    } finally {
      state.active -= 1;
      const next = state.pending.shift();
      if (next) next();
    }
  }

  async function fetchAttempt(pathname, requestOptions, attempt) {
    if (requestDelayMs > 0) await sleepImpl(requestDelayMs);

    const controller = new AbortController();
    const timeout = timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    let response;
    try {
      state.requests += 1;
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        headers: {
          platform: requestOptions.platform || DEFAULT_PLATFORM,
          language: requestOptions.language || DEFAULT_LANGUAGE,
          crossplay: String(toBoolean(requestOptions.crossplay, true)),
        },
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort = error?.name === 'AbortError';
      if (attempt < maxAttempts) {
        state.retries += 1;
        await sleepImpl(Math.min(250 * (2 ** (attempt - 1)), 2_000));
        return fetchAttempt(pathname, requestOptions, attempt + 1);
      }
      state.failures += 1;
      throw makeApiError(
        isAbort ? `Warframe Market request timed out after ${timeoutMs}ms.` : `Warframe Market request failed: ${error.message}`,
        { code: isAbort ? 'MARKET_API_TIMEOUT' : 'MARKET_API_NETWORK', cause: error }
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      if (RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxAttempts) {
        state.retries += 1;
        const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
        await sleepImpl(retryAfter ?? Math.min(250 * (2 ** (attempt - 1)), 2_000));
        return fetchAttempt(pathname, requestOptions, attempt + 1);
      }

      state.failures += 1;
      throw makeApiError(`Warframe Market API ${response.status}: ${text.slice(0, 200)}`, {
        status: response.status,
        code: 'MARKET_API_HTTP',
      });
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      state.failures += 1;
      throw makeApiError('Warframe Market returned invalid JSON.', {
        code: 'MARKET_API_INVALID_JSON',
        cause: error,
      });
    }

    if (body && typeof body === 'object' && body.error) {
      state.failures += 1;
      throw makeApiError(`Warframe Market API error: ${summarizeResponseError(body.error)}`, {
        code: 'MARKET_API_RESPONSE_ERROR',
      });
    }

    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'data')) {
      state.failures += 1;
      throw makeApiError('Warframe Market response is missing the data envelope.', {
        code: 'MARKET_API_INVALID_ENVELOPE',
      });
    }

    return body.data;
  }

  const get = (pathname, requestOptions = {}) => runLimited(
    () => fetchAttempt(pathname, requestOptions, 1)
  );

  const getCollection = async (pathname, requestOptions = {}) => {
    const data = await get(pathname, requestOptions);
    if (!Array.isArray(data)) {
      state.failures += 1;
      throw makeApiError(`Warframe Market response for ${pathname} did not contain a data array.`, {
        code: 'MARKET_API_INVALID_DATA',
      });
    }
    return data;
  };

  const getTelemetry = () => ({
    activeRequests: state.active,
    queueDepth: state.pending.length,
    requests: state.requests,
    retries: state.retries,
    failures: state.failures,
  });

  return { get, getCollection, getTelemetry };
}

module.exports = {
  DEFAULT_API_BASE,
  DEFAULT_PLATFORM,
  DEFAULT_LANGUAGE,
  createMarketApiClient,
  parseRetryAfter,
};
