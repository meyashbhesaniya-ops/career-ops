#!/usr/bin/env node
/**
 * agents/oci-capacity-watch.mjs — Oracle A1 ARM capacity watcher
 *
 * Pings OCI API every hour for ARM Ampere A1 availability
 * in all Frankfurt availability domains.
 * Sends Telegram alert the moment A1 capacity appears.
 *
 * pm2 start agents/oci-capacity-watch.mjs --name oci-watch
 */

import 'dotenv/config';
import cron from 'node-cron';
import { createSign } from 'crypto';
import { readFileSync } from 'fs';
import { sendAlert } from '../bridge/lib/notify.mjs';

const OCI_TENANCY = process.env.OCI_TENANCY_OCID;
const OCI_USER = process.env.OCI_USER_OCID;
const OCI_FINGERPRINT = process.env.OCI_FINGERPRINT;
const OCI_KEY_PATH = process.env.OCI_PRIVATE_KEY_PATH;
const OCI_REGION = process.env.OCI_REGION || 'eu-frankfurt-1';

// Frankfurt availability domains to check
const ADS = [
  'uXaa:EU-FRANKFURT-1-AD-1',
  'uXaa:EU-FRANKFURT-1-AD-2',
  'uXaa:EU-FRANKFURT-1-AD-3',
];

const SHAPE = 'VM.Standard.A1.Flex';
const TARGET_OCPUS = 4;
const TARGET_RAM = 24;

// Track if we already notified to avoid spam
let alerted = false;

/**
 * Sign OCI REST request using RSA-SHA256 + OCI signature scheme.
 * Required for OCI API authentication.
 */
function signRequest({ method, host, path, date, body = '' }) {
  if (!OCI_KEY_PATH) throw new Error('OCI_PRIVATE_KEY_PATH not set');
  const privateKey = readFileSync(OCI_KEY_PATH, 'utf-8');
  const contentLength = Buffer.byteLength(body);
  const contentHash = body
    ? createHash('sha256').update(body).digest('base64')
    : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256('')

  const headers = {
    date,
    '(request-target)': `${method.toLowerCase()} ${path}`,
    host,
  };

  const signingString = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const sign = createSign('RSA-SHA256');
  sign.update(signingString);
  const signature = sign.sign(privateKey, 'base64');

  const keyId = `${OCI_TENANCY}/${OCI_USER}/${OCI_FINGERPRINT}`;
  return (
    `Signature version="1",headers="${Object.keys(headers).join(' ')}",` +
    `keyId="${keyId}",algorithm="rsa-sha256",signature="${signature}"`
  );
}

async function checkA1Availability() {
  if (!OCI_TENANCY || !OCI_USER || !OCI_FINGERPRINT || !OCI_KEY_PATH) {
    // OCI API keys not configured — fall back to a no-op ping
    console.log('[oci-watch] OCI API credentials not configured. Skipping API check.');
    return false;
  }

  const host = `iaas.${OCI_REGION}.oraclecloud.com`;
  const compartmentId = OCI_TENANCY; // root compartment

  for (const ad of ADS) {
    const path = `/20160918/shapes?compartmentId=${encodeURIComponent(compartmentId)}&availabilityDomain=${encodeURIComponent(ad)}&limit=500`;
    const date = new Date().toUTCString();

    try {
      const auth = signRequest({ method: 'GET', host, path, date });
      const resp = await fetch(`https://${host}${path}`, {
        headers: { Date: date, Authorization: auth, host },
      });

      if (!resp.ok) {
        console.warn(`[oci-watch] OCI API returned ${resp.status} for AD ${ad}`);
        continue;
      }

      const { items } = await resp.json();
      const a1 = items?.find(s => s.shape === SHAPE);

      if (a1) {
        const maxOcpus = a1.ocpuOptions?.max ?? 0;
        const maxRam = a1.memoryOptions?.maxInGBs ?? 0;
        if (maxOcpus >= TARGET_OCPUS && maxRam >= TARGET_RAM) {
          return { ad, maxOcpus, maxRam };
        }
      }
    } catch (err) {
      console.warn(`[oci-watch] Error checking ${ad}: ${err.message}`);
    }
  }

  return false;
}

async function runCheck() {
  if (alerted) {
    console.log('[oci-watch] Already alerted — skipping check until next restart');
    return;
  }

  console.log(`[oci-watch] Checking A1 capacity in Frankfurt... ${new Date().toISOString()}`);

  try {
    const available = await checkA1Availability();
    if (available) {
      alerted = true;
      const msg =
        `🎉 Oracle A1 ARM capacity available!\n\n` +
        `Availability Domain: ${available.ad}\n` +
        `Max OCPUs: ${available.maxOcpus} | Max RAM: ${available.maxRam}GB\n\n` +
        `Go to OCI Console → Compute → Create Instance → VM.Standard.A1.Flex\n` +
        `Choose 4 OCPU + 24GB RAM, Ubuntu 22.04 ARM64, AD: ${available.ad}\n\n` +
        `Once created, run: ssh ubuntu@<new-ip> 'bash -s' < deploy/bootstrap-vm.sh\n` +
        `Then migrate Playwright filler from GitHub Actions to the new VM.`;
      await sendAlert(msg);
      console.log('[oci-watch] A1 capacity found! Alert sent.');
    } else {
      console.log('[oci-watch] No A1 capacity available yet.');
    }
  } catch (err) {
    console.error('[oci-watch] Check error:', err.message);
  }
}

// Run every hour
cron.schedule('0 * * * *', runCheck);

// Also run immediately on startup
runCheck();

console.log('[oci-watch] Started. Checking OCI A1 capacity every hour.');
