/**
 * PART 6 §3 — SSRF endpoint policy for user-configured provider URLs.
 *
 * Credential-free and offline: DNS is always an injected, labelled mock, so no
 * test ever resolves or contacts a real host. Every rejection path asserts the
 * typed `EndpointRejectedError` (ENDPOINT_REJECTED) with a safe message.
 */
import { describe, it, expect } from 'vitest';
import {
  EndpointPolicy,
  hasPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  parseAllowlist,
} from '../../src/providers/endpoint-policy.js';
import { EndpointRejectedError } from '../../src/core/errors.js';

/** Labelled mock resolver: never touches the network. */
function policyWith(
  addresses: readonly string[],
  allowlist: readonly string[] = [],
): EndpointPolicy {
  return new EndpointPolicy({
    allowlist,
    lookup: async () => addresses,
  });
}

function expectRejected(fn: () => unknown): EndpointRejectedError {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EndpointRejectedError);
  return caught as EndpointRejectedError;
}

async function expectRejectedAsync(promise: Promise<unknown>): Promise<EndpointRejectedError> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EndpointRejectedError);
  return caught as EndpointRejectedError;
}

/* ========================================================================== */
/*  Shape validation                                                          */
/* ========================================================================== */

describe('EndpointPolicy.validateShape — URL discipline', () => {
  const policy = policyWith([]);

  it('accepts an absolute https URL', () => {
    const url = policy.validateShape('https://api.example.com/v1');
    expect(url.toString()).toBe('https://api.example.com/v1');
  });

  it('accepts http (self-hosted providers commonly speak plain http)', () => {
    expect(policy.validateShape('http://ollama.example.com:11434').port).toBe('11434');
  });

  it('rejects an empty URL', () => {
    const error = expectRejected(() => policy.validateShape('   '));
    expect(error).toMatchObject({ code: 'ENDPOINT_REJECTED', httpStatus: 400 });
  });

  it('rejects a non-URL string', () => {
    const error = expectRejected(() => policy.validateShape('not a url at all'));
    expect(error).toMatchObject({ code: 'ENDPOINT_REJECTED' });
  });

  it('rejects a URL longer than 2048 characters', () => {
    const long = `https://api.example.com/${'a'.repeat(2100)}`;
    const error = expectRejected(() => policy.validateShape(long));
    expect(error).toMatchObject({ code: 'ENDPOINT_REJECTED' });
  });

  it('rejects non-http(s) schemes', () => {
    for (const url of ['ftp://api.example.com', 'file:///etc/passwd', 'gopher://x.test']) {
      expectRejected(() => policy.validateShape(url));
    }
  });

  it('rejects credentials embedded in the URL', () => {
    const error = expectRejected(() => policy.validateShape('https://user:pass@api.example.com'));
    expect(error.message).toMatch(/credential/i);
  });

  it('rejects a fragment', () => {
    expectRejected(() => policy.validateShape('https://api.example.com/v1#x'));
  });
});

/* ========================================================================== */
/*  Blocked hosts and ranges                                                  */
/* ========================================================================== */

describe('EndpointPolicy.validateShape — loopback, private and metadata hosts', () => {
  const policy = policyWith([]);

  it('blocks localhost and its subdomains', () => {
    for (const host of ['http://localhost:8080', 'http://app.localhost', 'http://foo.LOCAL', 'http://svc.internal']) {
      expectRejected(() => policy.validateShape(host));
    }
  });

  it('blocks cloud metadata hostnames even when allowlisted', () => {
    const allowlisted = policyWith([], ['metadata.google.internal', '169.254.169.254']);
    expectRejected(() => allowlisted.validateShape('http://metadata.google.internal/computeMetadata/v1/'));
    expectRejected(() => allowlisted.validateShape('http://instance-data/'));
  });

  it('blocks the IPv4 loopback and link-local metadata address', () => {
    expectRejected(() => policy.validateShape('http://127.0.0.1:8080'));
    expectRejected(() => policy.validateShape('http://169.254.169.254/latest/meta-data/'));
  });

  it('blocks RFC1918 / CGNAT / TEST-NET / multicast literals', () => {
    for (const ip of [
      '10.0.0.5',
      '172.16.10.4',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      expectRejected(() => policy.validateShape(`https://${ip}/v1`));
    }
  });

  it('blocks private/link-local/mapped IPv6 literals', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::']) {
      expectRejected(() => policy.validateShape(`https://[${ip}]/v1`));
    }
  });

  it('accepts globally routable literals', () => {
    expect(policy.validateShape('https://93.184.216.34/v1')).toBeInstanceOf(URL);
    expect(policy.validateShape('https://[2606:4700:4700::1111]/v1')).toBeInstanceOf(URL);
  });

  it('lets an operator allowlist a self-hosted private endpoint', () => {
    const allowlisted = policyWith([], ['ollama.local', '192.168.1.20', '10.0.0.7:8080']);
    expect(allowlisted.validateShape('http://ollama.local:11434').hostname).toBe('ollama.local');
    expect(allowlisted.validateShape('http://192.168.1.20:11434')).toBeInstanceOf(URL);
    // host:port entries only match that port.
    expectRejected(() => allowlisted.validateShape('http://10.0.0.7:9090'));
    expect(allowlisted.validateShape('http://10.0.0.7:8080')).toBeInstanceOf(URL);
  });
});

/* ========================================================================== */
/*  DNS rebinding defense                                                     */
/* ========================================================================== */

describe('EndpointPolicy.validate — resolution must be global', () => {
  it('accepts a hostname that resolves to public addresses', async () => {
    const policy = policyWith(['93.184.216.34', '2606:4700:4700::1111']);
    const result = await policy.validate('https://api.example.com/v1');
    expect(result.allowlisted).toBe(false);
    expect(result.resolvedAddresses).toEqual(['93.184.216.34', '2606:4700:4700::1111']);
  });

  it('rejects a hostname that resolves to a private address (DNS rebinding)', async () => {
    const policy = policyWith(['93.184.216.34', '127.0.0.1']);
    const error = await expectRejectedAsync(policy.validate('https://evil.example.com/v1'));
    expect(error.message).toMatch(/restricted address range/i);
  });

  it('rejects a hostname that resolves to nothing', async () => {
    await expectRejectedAsync(policyWith([]).validate('https://api.example.com/v1'));
  });

  it('rejects when resolution fails', async () => {
    const failing = new EndpointPolicy({
      lookup: async () => {
        throw new Error('ENOTFOUND (mock)');
      },
    });
    await expectRejectedAsync(failing.validate('https://api.example.com/v1'));
  });

  it('skips DNS for allowlisted hosts (self-hosted on a private range)', async () => {
    const policy = policyWith(['127.0.0.1'], ['ollama.example.internal']);
    const result = await policy.validate('http://ollama.example.internal:11434');
    expect(result.allowlisted).toBe(true);
    expect(result.resolvedAddresses).toEqual([]);
  });

  it('skips DNS for literal IPs (already range-checked in the shape pass)', async () => {
    const result = await policyWith([]).validate('https://93.184.216.34/v1');
    expect(result.resolvedAddresses).toEqual(['93.184.216.34']);
  });
});

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

describe('endpoint policy helpers', () => {
  it('classifies IPv4 ranges', () => {
    expect(isPrivateIpv4('127.0.0.1')).toBe(true);
    expect(isPrivateIpv4('10.1.2.3')).toBe(true);
    expect(isPrivateIpv4('169.254.169.254')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    expect(isPrivateIpv4('not-an-ip')).toBe(false);
  });

  it('classifies IPv6 ranges including mapped IPv4', () => {
    expect(isPrivateIpv6('::1')).toBe(true);
    expect(isPrivateIpv6('fe80::1')).toBe(true);
    expect(isPrivateIpv6('fd12:3456::1')).toBe(true);
    expect(isPrivateIpv6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false);
  });

  it('detects a mixed public/private address set', () => {
    expect(hasPrivateAddress(['8.8.8.8'])).toBe(false);
    expect(hasPrivateAddress(['8.8.8.8', '10.0.0.1'])).toBe(true);
    expect(hasPrivateAddress(['2606:4700::1111', '::1'])).toBe(true);
  });

  it('parses a comma/space separated allowlist with a bounded size', () => {
    expect(parseAllowlist(' Ollama.local ,\n10.0.0.7:8080  ')).toEqual([
      'ollama.local',
      '10.0.0.7:8080',
    ]);
    expect(parseAllowlist(undefined)).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `host${i}.example.com`).join(',');
    expect(parseAllowlist(many)).toHaveLength(50);
  });
});
