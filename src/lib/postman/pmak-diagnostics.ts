export type PmakDiagnosticKind = 'personal' | 'service-account' | 'invalid' | 'inconclusive';

export interface PmakDiagnosticResult {
  kind: PmakDiagnosticKind;
  status?: number;
  payload?: Record<string, unknown>;
}

export interface InspectPmakIdentityOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: 'diagnostic' | 'preflight';
}

const memo = new Map<string, Promise<PmakDiagnosticResult>>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  return new URL(apiBaseUrl.trim()).toString().replace(/\/+$/, '');
}

function diagnosticSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function inspect(options: InspectPmakIdentityOptions, normalizedApiBase: string): Promise<PmakDiagnosticResult> {
  try {
    const response = await (options.fetchImpl ?? fetch)(`${normalizedApiBase}/me`, {
      headers: { 'x-api-key': options.apiKey },
      signal: diagnosticSignal(options.signal, options.timeoutMs ?? 2000)
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: 'invalid', status: response.status };
    }
    if (!response.ok) {
      return { kind: 'inconclusive', status: response.status };
    }
    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(await response.json());
    } catch {
      return { kind: 'inconclusive', status: response.status };
    }
    const user = asRecord(payload?.user);
    if (!user) {
      return { kind: 'inconclusive', status: response.status };
    }
    const username = user.username;
    const email = user.email;
    if ((typeof username === 'string' && username.trim()) || (typeof email === 'string' && email.trim())) {
      return { kind: 'personal', status: response.status };
    }
    if (
      Object.hasOwn(user, 'username') &&
      Object.hasOwn(user, 'email') &&
      (username === null || username === '') &&
      (email === null || email === '')
    ) {
      return { kind: 'service-account', status: response.status };
    }
    return { kind: 'inconclusive', status: response.status };
  } catch {
    return { kind: 'inconclusive' };
  }
}

export function inspectPmakIdentity(options: InspectPmakIdentityOptions): Promise<PmakDiagnosticResult> {
  const normalizedApiBase = normalizeApiBaseUrl(options.apiBaseUrl);
  const key = `${normalizedApiBase}\u0000${options.apiKey}`;
  let result = memo.get(key);
  if (!result) {
    result = inspect(options, normalizedApiBase);
    memo.set(key, result);
    if (options.mode === 'preflight') {
      void result.then((value) => {
        if (value.kind === 'inconclusive') memo.delete(key);
      });
    }
  }
  return result;
}

export function maskPmakDiagnostic(message: string, secrets: readonly (string | undefined)[]): string {
  let masked = message;
  for (const secret of secrets) {
    if (secret) masked = masked.split(secret).join('***');
  }
  const controls = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
    'g'
  );
  return masked.replace(controls, ' ').replace(/\s+/g, ' ').trim();
}

export function formatRejectedMint(originalMintError: string, result: PmakDiagnosticResult): string {
  switch (result.kind) {
    case 'personal':
      return `${originalMintError} Personal API key detected, cannot mint a service-account access token.`;
    case 'service-account':
      return `${originalMintError} postman-api-key authenticates (GET /me OK) but was rejected by POST /service-account-tokens and lacks permission to mint access tokens.`;
    case 'invalid':
      return `${originalMintError} postman-api-key is invalid, disabled, or expired.`;
    default:
      return originalMintError;
  }
}

export function __resetPmakDiagnosticMemo(): void {
  memo.clear();
}
