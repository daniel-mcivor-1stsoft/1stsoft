/**
 * Cloudflare Pages Function — POST /api/contact
 *
 * Environment variables (set as Cloudflare Worker secrets, NEVER committed):
 *   SES_ACCESS_KEY_ID      — AWS access key with ses:SendEmail permission
 *   SES_SECRET_ACCESS_KEY  — corresponding secret key
 *   SES_REGION             — AWS region, e.g. "eu-west-1"
 *   SES_FROM               — verified SES sender address, e.g. "noreply@1stsoft.co.uk"
 *   CONTACT_TO             — destination inbox, e.g. "hello@1stsoft.co.uk"
 */

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 3;            // max submissions per IP per window

// In-memory store — resets on Worker restart; good enough for basic rate limiting
const rateLimitMap = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.ts > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { ts: now, count: 1 });
    return false; // not limited
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function sendViaSES(env, { name, email, phone, message }) {
  const to = env.CONTACT_TO;
  const from = env.SES_FROM;
  const region = env.SES_REGION;

  const subject = `Website enquiry from ${name}`;
  const body = [
    `Name:    ${name}`,
    `Email:   ${email}`,
    phone ? `Phone:   ${phone}` : '',
    '',
    `Message:`,
    message,
  ].filter(l => l !== undefined).join('\n');

  // AWS SES v2 — SendEmail via REST (no SDK needed in Workers)
  const endpoint = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;

  const payload = {
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: [email],
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: body, Charset: 'UTF-8' } }
      }
    }
  };

  // AWS Signature v4
  const bodyStr = JSON.stringify(payload);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'; // YYYYMMDDTHHmmssZ
  const dateStamp = amzDate.slice(0, 8);
  const service = 'ses';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const headers = {
    'Content-Type': 'application/json',
    'X-Amz-Date': amzDate,
    'Host': `email.${region}.amazonaws.com`,
  };

  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k]}\n`).join('');
  const signedHeaders = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');

  const bodyHash = await sha256hex(bodyStr);

  const canonicalRequest = [
    'POST',
    '/v2/email/outbound-emails',
    '',
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256hex(canonicalRequest),
  ].join('\n');

  const signingKey = await getSigningKey(env.SES_SECRET_ACCESS_KEY, dateStamp, region, service);
  const signature = await hmacHex(signingKey, stringToSign);

  const authHeader = `AWS4-HMAC-SHA256 Credential=${env.SES_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, Authorization: authHeader },
    body: bodyStr,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SES error ${response.status}: ${text}`);
  }
}

async function sha256hex(message) {
  const enc = new TextEncoder();
  const data = enc.encode(message);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(key, data) {
  const enc = new TextEncoder();
  const keyMaterial = typeof key === 'string' ? enc.encode(key) : key;
  const importedKey = await crypto.subtle.importKey(
    'raw', keyMaterial instanceof Uint8Array ? keyMaterial : new Uint8Array(keyMaterial),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', importedKey, enc.encode(data));
  return new Uint8Array(sig);
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  const enc = new TextEncoder();
  const kDate = await hmacKey(enc.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmacKey(kDate, region);
  const kService = await hmacKey(kRegion, service);
  const kSigning = await hmacKey(kService, 'aws4_request');
  return await crypto.subtle.importKey(
    'raw', kSigning,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  if (getRateLimit(ip)) {
    return json({ error: 'Too many requests. Please wait a minute and try again.' }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // Honeypot check
  if (body.hp) {
    // Silently accept — bots don't notice the failure
    return json({ ok: true });
  }

  const name = (body.name ?? '').trim();
  const email = (body.email ?? '').trim();
  const phone = (body.phone ?? '').trim();
  const message = (body.message ?? '').trim();

  if (!name || !email || !message) {
    return json({ error: 'Missing required fields.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: 'Invalid email address.' }, 400);
  }

  try {
    await sendViaSES(env, { name, email, phone, message });
    return json({ ok: true });
  } catch (err) {
    console.error('SES send failed:', err.message);
    return json({ error: 'Failed to send message.' }, 500);
  }
}
