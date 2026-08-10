#!/usr/bin/env node
'use strict';
/**
 * auth-outlook.js — ONE-TIME SETUP
 *
 * Authorizes grant-ops to read your Outlook inbox via Microsoft Graph API.
 * Uses OAuth2 Authorization Code + PKCE flow — opens your browser, captures
 * the redirect on localhost:3000, saves the token automatically.
 *
 * Run once:  node scripts/auth-outlook.js
 *
 * Requires http://localhost:3000/callback added as a redirect URI in Azure
 * under Authentication → Mobile and desktop applications.
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { exec } = require('child_process');

const TOKEN_PATH   = path.join(process.cwd(), 'tokens', 'outlook-token.json');
const REDIRECT_URI = 'http://localhost:3000/callback';
const PORT         = 3000;
const SCOPE        = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'offline_access',
].join(' ');

// ── .env loader ───────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]])
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function generatePKCE() {
  const verifier  = crypto.randomBytes(64).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── HTTPS POST (no axios needed) ──────────────────────────────────────────────
function httpsPost(url, params) {
  return new Promise((resolve, reject) => {
    const body    = new URLSearchParams(params).toString();
    const parsed  = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error_description || json.error));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Open browser (Windows / Mac / Linux) ─────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === 'win32'  ? `start "" "${url}"` :
              process.platform === 'darwin' ? `open "${url}"`     :
              `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ── Local callback server ─────────────────────────────────────────────────────
function waitForCallback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url   = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/callback') { res.end(); return; }

      const code  = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ Autorización completada</h2>
        <p>Puedes cerrar esta ventana y volver a la terminal.</p>
        </body></html>
      `);
      server.close();

      if (error) reject(new Error(url.searchParams.get('error_description') || error));
      else if (!code) reject(new Error('No authorization code received'));
      else resolve(code);
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE')
        reject(new Error(`Port ${PORT} is already in use. Close other processes and try again.`));
      else reject(err);
    });

    server.listen(PORT);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();

  const clientId = process.env.GRAPH_CLIENT_ID;
  const tenantId = process.env.GRAPH_TENANT_ID || 'common';

  if (!clientId) {
    console.error('\n❌  GRAPH_CLIENT_ID is not set in your .env file.\n');
    process.exit(1);
  }

  const { verifier, challenge } = generatePKCE();

  const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id',             clientId);
  authUrl.searchParams.set('response_type',         'code');
  authUrl.searchParams.set('redirect_uri',          REDIRECT_URI);
  authUrl.searchParams.set('scope',                 SCOPE);
  authUrl.searchParams.set('code_challenge',        challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('response_mode',         'query');

  console.log('\n🔐  Outlook Authorization for grant-ops\n');
  console.log('    Opening your browser to sign in...');
  console.log('    (If it does not open automatically, copy the URL below)\n');
  console.log(`    ${authUrl.toString()}\n`);

  openBrowser(authUrl.toString());

  console.log('    Waiting for you to sign in...');

  let code;
  try {
    code = await waitForCallback();
  } catch (err) {
    console.error('\n❌  Browser authorization failed:', err.message);
    process.exit(1);
  }

  console.log('    ✓ Received authorization code — exchanging for token...');

  let tokenData;
  try {
    tokenData = await httpsPost(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        client_id:     clientId,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  REDIRECT_URI,
        code_verifier: verifier,
        scope:         SCOPE,
      }
    );
  } catch (err) {
    console.error('\n❌  Token exchange failed:', err.message);
    process.exit(1);
  }

  const token = {
    access_token:  tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at:    Date.now() + tokenData.expires_in * 1000,
    client_id:     clientId,
    tenant_id:     tenantId,
  };

  const dir = path.dirname(TOKEN_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2));

  console.log('\n✅  Authorization successful!');
  console.log('    Token saved to: tokens/outlook-token.json');
  console.log('    grant-ops will now scan your Outlook inbox on every run.\n');
}

main().catch(err => {
  console.error('❌  Unexpected error:', err.message);
  process.exit(1);
});
