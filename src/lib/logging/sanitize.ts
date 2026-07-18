const BEARER_TOKEN_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_QUERY_RE = /(https:\/\/[^\s'"?]+)\?[^\s'"]*/gi;
const GOOGLE_RESOURCE_RE = /\b(?:projects\/[a-z0-9-]+\/locations\/[^\s'"]+|services\/[a-z0-9.-]+\/configs\/[^\s'"]+)/gi;
const SERVICE_ACCOUNT_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.iam\.gserviceaccount\.com\b/gi;
const PROJECT_NUMBER_RE = /\b\d{10,15}\b/g;
const PRIVATE_KEY_RE = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g;
const ABS_PATH_RE = /(?:^|(?<=[\s'"=([{,]))(?:[A-Za-z]:\\|\/)[^\s'"]+/g;
const GS_URI_RE = /\bgs:\/\/[^\s'"]+/gi;

/**
 * Redact GCP-sensitive material from a log line:
 *  - query strings are stripped from HTTPS URLs (origin + path survive);
 *  - full Google resource names, project numbers, and service-account emails are redacted;
 *  - bearer tokens become [redacted-token];
 *  - project numbers and service-account identities receive dedicated markers;
 *  - other absolute filesystem paths become [redacted-path].
 */
export function sanitizeLogMessage(message: string): string {
  return message
    .replace(URL_QUERY_RE, '$1')
    .replace(GS_URI_RE, '[gs-object]')
    .replace(PRIVATE_KEY_RE, '[redacted-credential]')
    .replace(BEARER_TOKEN_RE, '[redacted-token]')
    .replace(GOOGLE_RESOURCE_RE, '[redacted-gcp-resource]')
    .replace(SERVICE_ACCOUNT_RE, '[redacted-service-account]')
    .replace(PROJECT_NUMBER_RE, '[redacted-project-number]')
    .replace(ABS_PATH_RE, (match) => (match.startsWith('https://') ? match : '[redacted-path]'));
}

/** Recursively sanitize every string leaf of a JSON-safe value. */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeLogMessage(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeJsonValue(item);
    }
    return out as unknown as T;
  }
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * External errors are ALWAYS sanitized, including under ACTIONS_STEP_DEBUG:
 * debug mode may add more log lines elsewhere, but it must never widen what an
 * error can leak (resource names, project numbers, service accounts, URL queries, tokens).
 */
export function formatUserSafeError(error: unknown): string {
  return sanitizeLogMessage(errorMessage(error));
}
