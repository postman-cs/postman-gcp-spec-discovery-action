/**
 * Hermetic googleapis fixture for the GCP emulator lane.
 *
 * The product hardcodes `https://*.googleapis.com` control-plane hosts (no
 * endpoint-override input exists, deliberately), so the transport seam is the
 * runtime's own env contracts instead: an HTTP CONNECT proxy (`HTTPS_PROXY`
 * for gaxios/google-auth-library, `NODE_USE_ENV_PROXY=1` for the undici fetch
 * that downloads GCS signed URLs) terminating TLS with a run-scoped throwaway
 * CA (`NODE_EXTRA_CA_CERTS`). The proxy tunnels *.googleapis.com to the local
 * TLS fixture and refuses every other host, so a passing run is proof of zero
 * live Google traffic.
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

export interface FixtureRequest {
  host: string;
  method: string;
  path: string;
}

export interface GcpFixture {
  /** `http://127.0.0.1:<port>` for HTTPS_PROXY / HTTP_PROXY. */
  proxyUrl: string;
  /** PEM path for NODE_EXTRA_CA_CERTS. */
  caPath: string;
  /** Service-account JSON path for GOOGLE_APPLICATION_CREDENTIALS. */
  serviceAccountPath: string;
  /** Hosts the proxy tunneled (allowlisted googleapis hosts only). */
  connectedHosts: string[];
  /** CONNECT targets the proxy refused. */
  deniedHosts: string[];
  /** Every request served by the TLS fixture. */
  requests: FixtureRequest[];
  close(): Promise<void>;
}

export const FIXTURE_PROJECT_ID = 'emu-project-123';
export const INACTIVE_PROJECT_ID = 'emu-inactive-123';
export const PROXY_NAME = 'payments';
export const PROXY_REVISION = '2';
export const ARCHIVE_ENVIRONMENT = 'prod';
export const GOOD_ARCHIVE_ID = 'dep-good';
export const EVIL_ARCHIVE_ID = 'dep-evil';

const OPENAPI_YAML = [
  'openapi: 3.0.3',
  'info:',
  '  title: WS10 GCP Emulator Petstore',
  '  version: "1.0.0"',
  'paths:',
  '  /pets:',
  '    get:',
  '      responses:',
  '        "200":',
  '          description: ok',
  ''
].join('\n');

/** Minimal deflated zip matching the layout Apigee bundles use. */
function buildZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

const PROXY_BUNDLE = buildZip({ [`apiproxy/resources/oas/${PROXY_NAME}.yaml`]: OPENAPI_YAML });
const ARCHIVE_BUNDLE = buildZip({ 'src/main/openapi/spec.yaml': OPENAPI_YAML });

function isAllowedHost(host: string): boolean {
  return host === 'googleapis.com' || host.endsWith('.googleapis.com');
}

/** Throwaway CA + `*.googleapis.com` leaf, minted per run via openssl. */
function mintCertificates(dir: string): { caPath: string; serverKey: string; serverCert: string } {
  const caKey = path.join(dir, 'ca.key');
  const caPem = path.join(dir, 'ca.pem');
  const serverKey = path.join(dir, 'server.key');
  const serverCsr = path.join(dir, 'server.csr');
  const serverPem = path.join(dir, 'server.pem');
  const extFile = path.join(dir, 'san.cnf');
  writeFileSync(extFile, 'subjectAltName=DNS:*.googleapis.com,DNS:googleapis.com\n');
  const openssl = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-nodes', '-keyout', caKey, '-out', caPem, '-subj', '/CN=ws10-gcp-emulator-ca']);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', serverKey, '-out', serverCsr, '-subj', '/CN=*.googleapis.com']);
  openssl(['x509', '-req', '-in', serverCsr, '-CA', caPem, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-sha256', '-extfile', extFile, '-out', serverPem]);
  return { caPath: caPem, serverKey, serverCert: serverPem };
}

/** Run-scoped service account whose token_uri also rides the fixture. */
function mintServiceAccount(dir: string): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  const saPath = path.join(dir, 'service-account.json');
  writeFileSync(
    saPath,
    JSON.stringify({
      type: 'service_account',
      project_id: FIXTURE_PROJECT_ID,
      private_key_id: 'ws10-emulator-key',
      private_key: privateKey,
      client_email: `ws10-emulator@${FIXTURE_PROJECT_ID}.iam.gserviceaccount.com`,
      client_id: '000000000000000000000',
      token_uri: 'https://oauth2.googleapis.com/token'
    })
  );
  return saPath;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startGcpFixture(): Promise<GcpFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws10-gcp-fixture-'));
  const { caPath, serverKey, serverCert } = mintCertificates(dir);
  const serviceAccountPath = mintServiceAccount(dir);
  const connectedHosts: string[] = [];
  const deniedHosts: string[] = [];
  const requests: FixtureRequest[] = [];

  const org = FIXTURE_PROJECT_ID;
  const tls = https.createServer(
    { key: readFileSync(serverKey), cert: readFileSync(serverCert) },
    (req, res) => {
      const host = (req.headers.host ?? '').replace(/:443$/, '');
      const url = new URL(req.url ?? '/', `https://${host}`);
      requests.push({ host, method: req.method ?? '', path: url.pathname });

      if (host === 'oauth2.googleapis.com' && req.method === 'POST' && url.pathname === '/token') {
        json(res, 200, { access_token: 'ws10-emulator-token', expires_in: 3600, token_type: 'Bearer' });
        return;
      }
      if (host === 'cloudresourcemanager.googleapis.com' && url.pathname.startsWith('/v3/projects/')) {
        const projectId = decodeURIComponent(url.pathname.slice('/v3/projects/'.length));
        json(res, 200, { projectId, state: projectId === INACTIVE_PROJECT_ID ? 'DELETE_REQUESTED' : 'ACTIVE' });
        return;
      }
      if (host === 'apigee.googleapis.com') {
        if (url.pathname === `/v1/organizations/${org}/apis`) {
          json(res, 200, { proxies: [{ name: PROXY_NAME }] });
          return;
        }
        if (url.pathname === `/v1/organizations/${org}/apis/${PROXY_NAME}/revisions`) {
          json(res, 200, ['1', PROXY_REVISION]);
          return;
        }
        if (url.pathname === `/v1/organizations/${org}/apis/${PROXY_NAME}/revisions/${PROXY_REVISION}` && url.searchParams.get('format') === 'bundle') {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': PROXY_BUNDLE.length });
          res.end(PROXY_BUNDLE);
          return;
        }
        const download = new RegExp(`^/v1/organizations/${org}/environments/${ARCHIVE_ENVIRONMENT}/archiveDeployments/([^/:]+):generateDownloadUrl$`).exec(url.pathname);
        if (download && req.method === 'POST') {
          json(res, 200, {
            downloadUri:
              download[1] === EVIL_ARCHIVE_ID
                ? 'https://evil.example/ws10-bucket/archive.zip'
                : 'https://storage.googleapis.com/ws10-bucket/archive.zip'
          });
          return;
        }
      }
      if (host === 'storage.googleapis.com' && url.pathname === '/ws10-bucket/archive.zip') {
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': ARCHIVE_BUNDLE.length });
        res.end(ARCHIVE_BUNDLE);
        return;
      }
      // Every other googleapis surface (provider probes included) is IAM-denied,
      // matching a locked-down service account.
      json(res, 403, { error: { code: 403, status: 'PERMISSION_DENIED', message: `PERMISSION_DENIED (emulator default) for ${host}${url.pathname}` } });
    }
  );
  const openSockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  };
  tls.on('connection', track);
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const tlsPort = (tls.address() as net.AddressInfo).port;

  const proxy = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const head = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const text = head.toString('latin1');
      const line = text.split('\r\n')[0] ?? '';
      const match = /^CONNECT ([^ :]+):(\d+) /.exec(line);
      if (!match || !isAllowedHost(match[1]!)) {
        deniedHosts.push(match?.[1] ?? line);
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      connectedHosts.push(match[1]!);
      // Bytes past the CONNECT header (a TLS ClientHello often rides the same
      // packet) must reach the upstream or the handshake stalls forever.
      const headerEnd = text.indexOf('\r\n\r\n');
      const remainder = headerEnd >= 0 ? head.subarray(headerEnd + 4) : Buffer.alloc(0);
      const upstream = net.connect(tlsPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (remainder.length > 0) upstream.write(remainder);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
    socket.on('error', () => socket.destroy());
  });
  proxy.on('connection', track);
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as net.AddressInfo).port;

  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    caPath,
    serviceAccountPath,
    connectedHosts,
    deniedHosts,
    requests,
    close: async () => {
      // Keep-alive sockets would hold close() open past the hook timeout.
      for (const socket of openSockets) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => tls.close(() => resolve()))
      ]);
    }
  };
}