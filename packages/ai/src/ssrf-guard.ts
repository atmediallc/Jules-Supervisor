import { isIP } from "node:net";
import dns from "node:dns/promises";

export interface SsrfGuardOptions {
  allowInsecureLocal?: boolean;
  trustedInternalHosts?: string[];
  resolveDns?: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "instance-data",
  "metadata.internal",
  "100.100.100.200", // Alibaba metadata
  "metadata",
]);

/**
 * Parses numeric IPv4 representations (standard decimal dotted, octal, hex, dword/integer)
 */
function parseIpv4ToNumber(host: string): number | null {
  // Check pure 32-bit integer (decimal, hex 0x..., octal 0...)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(host)) {
    const num = Number(host);
    if (!Number.isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return num;
    }
  }

  const parts = host.split(".");
  if (parts.length === 4) {
    const nums: number[] = [];
    for (const part of parts) {
      let n: number;
      if (/^0x[0-9a-f]+$/i.test(part)) {
        n = parseInt(part, 16);
      } else if (/^0[0-7]+$/.test(part) && part.length > 1) {
        n = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        n = parseInt(part, 10);
      } else {
        return null;
      }
      if (n < 0 || n > 255) return null;
      nums.push(n);
    }
    return ((nums[0]! << 24) >>> 0) + (nums[1]! << 16) + (nums[2]! << 8) + nums[3]!;
  }

  return null;
}

/**
 * Checks if a 32-bit integer IPv4 is in private, link-local, loopback, or reserved range.
 */
function isPrivateOrReservedIpv4(ipNum: number): boolean {
  const byte1 = (ipNum >>> 24) & 0xff;
  const byte2 = (ipNum >>> 16) & 0xff;

  // 0.0.0.0/8 (Current network)
  if (byte1 === 0) return true;
  // 10.0.0.0/8 (Private)
  if (byte1 === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (byte1 === 127) return true;
  // 169.254.0.0/16 (Link-local)
  if (byte1 === 169 && byte2 === 254) return true;
  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (byte1 === 172 && byte2 >= 16 && byte2 <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (byte1 === 192 && byte2 === 168) return true;
  // 100.64.0.0/10 (Carrier-grade NAT: 100.64.0.0 - 100.127.255.255)
  if (byte1 === 100 && byte2 >= 64 && byte2 <= 127) return true;
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (byte1 === 192 && byte2 === 0) return true;
  // 192.0.2.0/24 (TEST-NET-1), 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24 (TEST-NET-3)
  if (byte1 === 192 && byte2 === 0) return true;
  if (byte1 === 198 && byte2 === 51) return true;
  if (byte1 === 203 && byte2 === 0) return true;
  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (byte1 >= 224 && byte1 <= 239) return true;
  // 240.0.0.0/4 (Reserved: 240.0.0.0 - 255.255.255.255)
  if (byte1 >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address is loopback, unique-local, link-local, or IPv4-mapped private.
 */
function isPrivateOrReservedIpv6(host: string): boolean {
  // Strip brackets if present
  let clean = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  clean = clean.toLowerCase();

  // ::1 loopback
  if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return true;
  // :: unspecified
  if (clean === "::" || clean === "0:0:0:0:0:0:0:0") return true;

  // IPv4-mapped IPv6: ::ffff:127.0.0.1 or ::ffff:7f00:1
  if (clean.startsWith("::ffff:") || clean.startsWith("0:0:0:0:0:ffff:")) {
    const mappedPart = clean.replace(/^.*ffff:/, "");
    const ipv4Num = parseIpv4ToNumber(mappedPart);
    if (ipv4Num !== null && isPrivateOrReservedIpv4(ipv4Num)) {
      return true;
    }
  }

  // fe80::/10 (link-local)
  if (/^fe[89ab]/i.test(clean)) return true;
  // fc00::/7 (unique local)
  if (/^f[cd]/i.test(clean)) return true;
  // ff00::/8 (multicast)
  if (clean.startsWith("ff")) return true;
  // 2001:db8::/32 (documentation)
  if (clean.startsWith("2001:db8") || clean.startsWith("2001:0db8")) return true;

  return false;
}

export function validateProviderUrl(
  urlStr: string,
  options: SsrfGuardOptions = {},
): { isValid: boolean; reason?: string } {
  try {
    if (!urlStr || typeof urlStr !== "string") {
      return { isValid: false, reason: "URL must be a non-empty string" };
    }

    const parsed = new URL(urlStr);

    // Reject unsupported protocols
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { isValid: false, reason: `Disallowed URL protocol: ${parsed.protocol}` };
    }

    // Reject embedded URL credentials (user:pass@host)
    if (parsed.username || parsed.password) {
      return { isValid: false, reason: "URL credentials (username/password) are forbidden" };
    }

    const rawHost = parsed.hostname.toLowerCase();
    const hostWithoutBrackets =
      rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;

    // Check blocked hostnames
    if (BLOCKED_HOSTNAMES.has(rawHost) || BLOCKED_HOSTNAMES.has(hostWithoutBrackets)) {
      return { isValid: false, reason: `Blocked cloud metadata host: ${rawHost}` };
    }

    // Check trusted exact-host allowlisting
    const trustedHosts = (
      options.trustedInternalHosts ?? ["localhost", "127.0.0.1", "omniroute"]
    ).map((h) => h.toLowerCase().trim());
    const isExplicitlyTrusted =
      trustedHosts.includes(rawHost) || trustedHosts.includes(hostWithoutBrackets);

    // IPv4 analysis
    const ipv4Num = parseIpv4ToNumber(rawHost);
    if (ipv4Num !== null) {
      if (isPrivateOrReservedIpv4(ipv4Num)) {
        if (options.allowInsecureLocal && isExplicitlyTrusted) {
          return { isValid: true };
        }
        return {
          isValid: false,
          reason: `Private, loopback, or reserved IPv4 address blocked: ${rawHost}`,
        };
      }
    }

    // IPv6 analysis
    if (isIP(hostWithoutBrackets) === 6 || rawHost.includes(":")) {
      if (isPrivateOrReservedIpv6(hostWithoutBrackets)) {
        if (options.allowInsecureLocal && isExplicitlyTrusted) {
          return { isValid: true };
        }
        return {
          isValid: false,
          reason: `Private, loopback, or link-local IPv6 address blocked: ${rawHost}`,
        };
      }
    }

    // HTTP plain protocol enforcement
    if (parsed.protocol === "http:") {
      if (!options.allowInsecureLocal) {
        if (!isExplicitlyTrusted) {
          return {
            isValid: false,
            reason:
              "HTTP protocol only allowed for trusted local hosts or when ALLOW_INSECURE_LOCAL_ENDPOINTS=true",
          };
        }
      }
    }

    return { isValid: true };
  } catch (err: unknown) {
    return { isValid: false, reason: `Malformed URL: ${(err as Error).message}` };
  }
}

/**
 * Performs asynchronous DNS resolution to prevent DNS rebinding attacks to internal IPs.
 */
export async function validateProviderUrlWithDns(
  urlStr: string,
  options: SsrfGuardOptions = {},
): Promise<{ isValid: boolean; reason?: string }> {
  const staticResult = validateProviderUrl(urlStr, options);
  if (!staticResult.isValid) return staticResult;

  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;

    // If already an IP or explicitly trusted local host, we can skip DNS resolution
    const trustedHosts = (
      options.trustedInternalHosts ?? ["localhost", "127.0.0.1", "omniroute"]
    ).map((h) => h.toLowerCase().trim());
    if (trustedHosts.includes(hostname.toLowerCase())) {
      return { isValid: true };
    }

    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (addr.family === 4) {
        const num = parseIpv4ToNumber(addr.address);
        if (num !== null && isPrivateOrReservedIpv4(num)) {
          return {
            isValid: false,
            reason: `DNS rebinding detected: host ${hostname} resolved to private IP ${addr.address}`,
          };
        }
      } else if (addr.family === 6) {
        if (isPrivateOrReservedIpv6(addr.address)) {
          return {
            isValid: false,
            reason: `DNS rebinding detected: host ${hostname} resolved to private IPv6 ${addr.address}`,
          };
        }
      }
    }

    return { isValid: true };
  } catch (err: unknown) {
    return {
      isValid: false,
      reason: `DNS resolution failed (fail-closed): ${(err as Error).message}`,
    };
  }
}

/**
 * Creates an SSRF-guarded fetch implementation that validates both the initial
 * destination and every redirect hop against the DNS/IP guard before dispatch.
 */
export function createSsrfGuardedFetch(
  options: SsrfGuardOptions = {},
): typeof fetch {
  return async function ssrfGuardedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const check = await validateProviderUrlWithDns(urlStr, options);
    if (!check.isValid) {
      throw new Error(`SSRF guard blocked request to ${urlStr}: ${check.reason}`);
    }

    let currentUrl = urlStr;
    let currentInit: RequestInit = { ...init, redirect: "manual" };
    let hops = 0;
    const maxHops = 5;

    while (hops < maxHops) {
      hops++;
      const response = await fetch(currentUrl, currentInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          return response;
        }
        const nextUrl = new URL(location, currentUrl).toString();
        const nextCheck = await validateProviderUrlWithDns(nextUrl, options);
        if (!nextCheck.isValid) {
          throw new Error(
            `SSRF guard blocked redirect to ${nextUrl}: ${nextCheck.reason}`,
          );
        }
        currentUrl = nextUrl;
        currentInit = {
          ...currentInit,
          method: [301, 302, 303].includes(response.status)
            ? "GET"
            : currentInit.method,
          body: [301, 302, 303].includes(response.status)
            ? undefined
            : currentInit.body,
        };
        continue;
      }
      return response;
    }
    throw new Error(`SSRF guard: max redirect hops (${maxHops}) exceeded`);
  };
}
