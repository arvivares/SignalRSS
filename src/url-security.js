import dns from 'node:dns/promises';
import net from 'node:net';

const PRIVATE_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

function ipv4ToInt(value) {
  return value.split('.').reduce((total, part) => ((total << 8) + Number(part)) >>> 0, 0);
}

function ipv4InCidr(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(address) & mask) === (ipv4ToInt(base) & mask);
}

function isBlockedIPv4(address) {
  return PRIVATE_IPV4_RANGES.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

function isBlockedIPv6(address) {
  const normalized = address.toLowerCase();
  return (
    normalized === '::'
    || normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe80:')
    || normalized.startsWith('ff')
  );
}

export function isBlockedIp(address = '') {
  const version = net.isIP(address);
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(address);
  return false;
}

export function parseSafeHttpUrl(value, { allowHttp = true } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Blocked URL protocol: ${parsed.protocol}`);
  }
  if (!allowHttp && parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new Error(`Blocked hostname: ${hostname || '(empty)'}`);
  }
  if (net.isIP(hostname) && isBlockedIp(hostname)) {
    throw new Error(`Blocked private IP URL: ${hostname}`);
  }

  return parsed;
}

export async function assertSafeHttpUrl(value, options = {}) {
  const parsed = parseSafeHttpUrl(value, options);
  const hostname = parsed.hostname;

  if (!net.isIP(hostname)) {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const record of records) {
      if (isBlockedIp(record.address)) {
        throw new Error(`Blocked resolved private IP for ${hostname}`);
      }
    }
  }

  return parsed;
}
