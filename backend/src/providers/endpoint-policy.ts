/**
 * Outbound endpoint policy (Part 6 §3) — SSRF defense for user-configured URLs.
 *
 * A provider base URL is attacker-influenced configuration: it arrives from the
 * dashboard, is validated here, and only afterwards is anything fetched. The
 * rules:
 *
 *  1. `http:`/`https:` only, no embedded credentials, bounded length.
 *  2. Hostnames that obviously mean "this machine" are rejected outright
 *     (`localhost`, `*.local`, `*.internal`, cloud metadata hosts).
 *  3. Literal IPs are range-checked: loopback, private, link-local, CGNAT,
 *     multicast, reserved and the cloud metadata address (169.254.169.254).
 *  4. Hostnames are RESOLVED and every returned A/AAAA record must be global —
 *     this is what stops `evil.example.com -> 127.0.0.1` rebinding.
 *  5. The one deliberate escape hatch: an operator-supplied
 *     `SELF_HOSTED_ENDPOINT_ALLOWLIST` (hostname or host:port) permits a private
 *     self-hosted endpoint. It is server-side configuration, never client input.
 *
 * Nothing here fetches the URL: validation is pure (plus DNS), and the actual
 * request in `transport.ts` re-validates, refuses redirects and caps size.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { EndpointRejectedError } from '../core/errors.js';

export interface ValidatedEndpoint {
  readonly url: URL;
  /** True when the operator allowlisted this host (private ranges permitted). */
  readonly allowlisted: boolean;
  /** Addresses the hostname resolved to (empty for literal IPs). */
  readonly resolvedAddresses: readonly string[];
}

export type DnsLookupFn = (hostname: string) => Promise<readonly string[]>;

const defaultLookup: DnsLookupFn = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

/** Cloud metadata endpoints: these may NEVER be reached, not even allowlisted. */
const METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'instance-data']);

function isMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return METADATA_HOSTS.has(host) || host.endsWith('.metadata.google.internal');
}

/**
 * Hostnames rejected unless the operator allowlisted them (`localhost`,
 * `*.local`, `*.internal`, cluster DNS names). Metadata hosts are handled
 * separately above and are never allowlistable.
 */
function isNeverAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(host)) return true;
  return (
    host === 'localhost' ||
    host === 'kubernetes' ||
    host === 'kubernetes.default' ||
    host === 'kubernetes.default.svc' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.metadata.google.internal')
  );
}

/* -------------------------------------------------------------------------- */
/*  IP range checks                                                           */
/* -------------------------------------------------------------------------- */

function ipv4ToBytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function ipv6Groups(ip: string): number[] | null {
  // Strip an IPv4-mapped tail ("::ffff:127.0.0.1") into hex groups.
  let normalized = ip.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const v4 = normalized.slice(lastColon + 1);
    const bytes = ipv4ToBytes(v4);
    if (!bytes) return null;
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;
    const hi = ((b0 << 8) | b1).toString(16);
    const lo = ((b2 << 8) | b3).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  const values = groups.map((group) => Number.parseInt(group, 16));
  return values.some((value) => Number.isNaN(value)) ? null : values;
}

/** True when an IPv4 literal sits in a non-globally-routable range. */
export function isPrivateIpv4(ip: string): boolean {
  const bytes = ipv4ToBytes(ip);
  if (!bytes) return false;
  const [a, b, c, d] = bytes as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  void d;
  return false;
}

/** True when an IPv6 literal is loopback, link-local, ULA, mapped or multicast. */
export function isPrivateIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) return false;
  const g0 = groups[0] ?? 0;
  const g5 = groups[5] ?? 0;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && g7 === 1) return true; // ::1
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d — judge the tail.
  if (groups.slice(0, 5).every((group) => group === 0)) {
    if (g5 !== 0 || g6 !== 0) {
      const v4 = `${g5 >> 8}.${g5 & 0xff}.${g6 >> 8}.${g6 & 0xff}`;
      return isPrivateIpv4(v4);
    }
    if (g7 !== 0) {
      const tailV4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
      return isPrivateIpv4(tailV4);
    }
  }
  return false;
}

/** True when ANY address in the resolved set is non-global. */
export function hasPrivateAddress(addresses: readonly string[]): boolean {
  return addresses.some((address) =>
    address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address),
  );
}

/* -------------------------------------------------------------------------- */
/*  Policy                                                                    */
/* -------------------------------------------------------------------------- */

export function parseAllowlist(raw: string | readonly string[] | undefined): string[] {
  const parts = Array.isArray(raw)
    ? (raw as readonly string[])
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/)
      : [];
  return parts
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .slice(0, 50);
}

export interface EndpointPolicyOptions {
  readonly allowlist?: readonly string[];
  /** Injectable resolver for deterministic tests (labelled mocks). */
  readonly lookup?: DnsLookupFn;
}

export class EndpointPolicy {
  private readonly allowlist: readonly string[];
  private readonly lookup: DnsLookupFn;

  constructor(options: EndpointPolicyOptions = {}) {
    this.allowlist = parseAllowlist(options.allowlist);
    this.lookup = options.lookup ?? defaultLookup;
  }

  /** Shape-only validation (no DNS). Used for immediate form feedback. */
  validateShape(rawUrl: string): URL {
    const trimmed = rawUrl.trim();
    if (trimmed.length === 0) {
      throw new EndpointRejectedError('Endpoint URL is required.', { reason: 'empty' });
    }
    if (trimmed.length > 2048) {
      throw new EndpointRejectedError('Endpoint URL is too long (max 2048 characters).', {
        reason: 'too_long',
      });
    }

    let url: URL | null = null;
    try {
      url = new URL(trimmed);
    } catch {
      url = null;
    }
    if (!url) {
      throw new EndpointRejectedError('Endpoint is not a valid absolute URL.', {
        reason: 'malformed',
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new EndpointRejectedError('Endpoint must use http:// or https://.', {
        reason: 'scheme',
      });
    }
    if (url.username || url.password) {
      throw new EndpointRejectedError(
        'Endpoint must not embed credentials in the URL; use the secret field.',
        { reason: 'userinfo' },
      );
    }
    if (url.hash) {
      throw new EndpointRejectedError('Endpoint must not contain a fragment (#...).', {
        reason: 'fragment',
      });
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname.length === 0) {
      throw new EndpointRejectedError('Endpoint URL has no hostname.', { reason: 'no_host' });
    }

    // Metadata endpoints are off limits unconditionally — an allowlist entry is
    // server-side configuration and must never open a path to cloud credentials.
    if (isMetadataHost(hostname)) {
      throw new EndpointRejectedError(`Endpoint host "${hostname}" is not an allowed destination.`, {
        reason: 'blocked_host',
      });
    }

    const allowlisted = this.isAllowlisted(hostname, url.port);
    if (!allowlisted) {
      if (isNeverAllowedHost(hostname)) {
        throw new EndpointRejectedError(`Endpoint host "${hostname}" is not an allowed destination.`, {
          reason: 'blocked_host',
        });
      }
      const isLiteral = Boolean(ipv4ToBytes(hostname) || ipv6Groups(hostname));
      if (isLiteral) {
        const blocked = hostname.includes(':')
          ? isPrivateIpv6(hostname)
          : isPrivateIpv4(hostname);
        if (blocked) {
          throw new EndpointRejectedError(
            `Endpoint resolves to a restricted address range (${hostname}). ` +
              'Add the host to SELF_HOSTED_ENDPOINT_ALLOWLIST if this is your own server.',
            { reason: 'blocked_range' },
          );
        }
      }
    }
    return url;
  }

  /**
   * Full validation: shape + DNS resolution. Throws `EndpointRejectedError`
   * (safe, exposed message) — never leaks resolver internals.
   */
  async validate(rawUrl: string): Promise<ValidatedEndpoint> {
    const url = this.validateShape(rawUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowlisted = this.isAllowlisted(hostname, url.port);

    // Literal IPs are already range-checked in validateShape.
    const isLiteral = Boolean(ipv4ToBytes(hostname) || ipv6Groups(hostname));
    if (isLiteral || allowlisted) {
      return { url, allowlisted, resolvedAddresses: isLiteral ? [hostname] : [] };
    }

    let addresses: readonly string[];
    try {
      addresses = await this.lookup(hostname);
    } catch {
      throw new EndpointRejectedError(`Endpoint host "${hostname}" could not be resolved.`, {
        reason: 'dns_failed',
      });
    }
    if (addresses.length === 0) {
      throw new EndpointRejectedError(`Endpoint host "${hostname}" resolved to no addresses.`, {
        reason: 'dns_empty',
      });
    }
    if (hasPrivateAddress(addresses)) {
      throw new EndpointRejectedError(
        `Endpoint host "${hostname}" resolves to a restricted address range. ` +
          'Add the host to SELF_HOSTED_ENDPOINT_ALLOWLIST if this is your own server.',
        { reason: 'dns_private' },
      );
    }
    return { url, allowlisted: false, resolvedAddresses: [...addresses] };
  }

  private isAllowlisted(hostname: string, port: string): boolean {
    if (this.allowlist.length === 0) return false;
    const host = hostname.toLowerCase();
    return this.allowlist.some((entry) => {
      if (entry.includes(':')) {
        const [entryHost, entryPort] = entry.split(':');
        return entryHost === host && (entryPort === port || entryPort === '*');
      }
      return entry === host;
    });
  }
}
