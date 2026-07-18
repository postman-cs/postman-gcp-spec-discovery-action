import { describe, expect, it } from 'vitest';

import { formatUserSafeError, sanitizeJsonValue, sanitizeLogMessage } from '../src/lib/logging/sanitize.js';

const PROJECT_NUMBER = '123456789012';
const RESOURCE_NAME = 'projects/sample-project-123/locations/global/apis/payments/configs/payments-config';
const ENDPOINTS_CONFIG = 'services/payments.endpoints.sample-project-123.cloud.goog/configs/2026-01-01r0';
const SERVICE_ACCOUNT = 'spec-discovery@sample-project-123.iam.gserviceaccount.com';
const BEARER = 'Bearer ya29.a0AfB-SecretAccessTokenValue1234567890abcdef';
const SIGNED_URL = 'https://storage.googleapis.com/exports/payments.json?X-Goog-Signature=SECRETSIGVALUE123&X-Goog-Expires=3600';

describe('gcp log sanitization', () => {
  it('GCP-CLIENT-005: redacts project numbers, resource names, service accounts, bearer tokens, and signed-URL queries', () => {
    const message = [
      `project ${PROJECT_NUMBER} rejected request`,
      `resource ${RESOURCE_NAME} not found`,
      `config ${ENDPOINTS_CONFIG} unavailable`,
      `caller ${SERVICE_ACCOUNT} denied`,
      `auth header ${BEARER}`,
      `download ${SIGNED_URL}`
      , 'object gs://private-bucket/private/object.yaml'
    ].join('; ');

    const sanitized = sanitizeLogMessage(message);

    expect(sanitized).not.toContain(PROJECT_NUMBER);
    expect(sanitized).not.toContain('sample-project-123');
    expect(sanitized).not.toContain('ya29.');
    expect(sanitized).not.toContain('SECRETSIGVALUE123');
    expect(sanitized).not.toContain('X-Goog-Signature=');
    expect(sanitized).toContain('[redacted-gcp-resource]');
    expect(sanitized).toContain('[redacted-service-account]');
    expect(sanitized).toContain('[redacted-project-number]');
    expect(sanitized).toContain('[redacted-token]');
    expect(sanitized).toContain('[gs-object]');
    expect(sanitized).not.toContain('gs://');
    // Query-free HTTPS origin/path survives so operators can identify the endpoint.
    expect(sanitized).toContain('https://storage.googleapis.com/exports/payments.json');
  });

  it('GCP-CLIENT-006: redacts Apigee organizations/... resource names', () => {
    const message = 'selected organizations/sample-org-1/apis/payments/revisions/3 and organizations/sample-org-1/sites/dev/apidocs/12';
    const sanitized = sanitizeLogMessage(message);
    expect(sanitized).not.toContain('organizations/sample-org-1');
    expect(sanitized).toContain('[redacted-gcp-resource]');
  });

  it('GCP-CLIENT-005: redacts inline private key material', () => {
    const message = 'credential blob -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY----- leaked';
    const sanitized = sanitizeLogMessage(message);
    expect(sanitized).not.toContain('MIIEvQIBADANBg');
    expect(sanitized).toContain('[redacted-credential]');
  });

  it('GCP-CLIENT-005: sanitizeJsonValue reaches nested string leaves', () => {
    const value = sanitizeJsonValue({
      evidence: [`selected ${RESOURCE_NAME}`],
      nested: { link: SIGNED_URL, caller: SERVICE_ACCOUNT }
    });
    expect(JSON.stringify(value)).not.toContain('sample-project-123');
    expect(JSON.stringify(value)).not.toContain('SECRETSIGVALUE123');
  });

  it('GCP-CLIENT-005: formatUserSafeError always sanitizes, including under step debug', () => {
    const error = new Error(`export failed for ${RESOURCE_NAME}`);
    expect(formatUserSafeError(error)).not.toContain('sample-project-123');
    // ACTIONS_STEP_DEBUG must not widen error output: same sanitized result.
    process.env.ACTIONS_STEP_DEBUG = 'true';
    try {
      expect(formatUserSafeError(error)).not.toContain('sample-project-123');
    } finally {
      delete process.env.ACTIONS_STEP_DEBUG;
    }
  });
});
