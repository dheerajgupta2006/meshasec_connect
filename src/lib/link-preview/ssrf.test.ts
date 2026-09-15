import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  classifyHostname,
  classifyPreviewUrl,
  isIpv4Literal,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
} from "@/lib/link-preview/ssrf";

describe("isIpv4Literal", () => {
  it("accepts a plain dotted quad", () => {
    for (const value of ["1.2.3.4", "255.255.255.255", "0.0.0.0"]) {
      expect(isIpv4Literal(value)).toBe(true);
    }
  });

  it("rejects octal-style leading zeros", () => {
    // `010.0.0.1` is parsed as octal by some resolvers, which is a classic
    // filter bypass: it reaches 8.0.0.1 while looking like 10.x.
    for (const value of ["010.0.0.1", "01.2.3.4", "1.2.3.04"]) {
      expect(isIpv4Literal(value)).toBe(false);
    }
  });

  it("rejects out-of-range octets and wrong shapes", () => {
    for (const value of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "a.b.c.d", ""]) {
      expect(isIpv4Literal(value)).toBe(false);
    }
  });
});

describe("isPrivateIpv4", () => {
  it("blocks the cloud metadata endpoint", () => {
    // Reaching this leaks IAM credentials on AWS. It is the single most
    // important address in this file.
    expect(isPrivateIpv4("169.254.169.254")).toBe(true);
  });

  it("blocks loopback, RFC 1918, CGNAT and reserved ranges", () => {
    const blocked = [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "0.0.0.0",
      "100.64.0.1",
      "100.127.255.255",
      "198.18.0.1",
      "192.0.0.1",
      "192.88.99.1",
      "224.0.0.1",
      "255.255.255.255",
    ];

    blocked.forEach((address) => {
      expect(isPrivateIpv4(address)).toBe(true);
    });
  });

  it("allows ordinary public addresses", () => {
    const allowed = [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "172.15.0.1",
      "172.32.0.1",
      "100.63.255.255",
      "100.128.0.1",
      "192.167.1.1",
      "192.169.1.1",
      "198.20.0.1",
    ];

    allowed.forEach((address) => {
      expect(isPrivateIpv4(address)).toBe(false);
    });
  });

  it("treats the 172.16/12 boundary exactly", () => {
    expect(isPrivateIpv4("172.15.255.255")).toBe(false);
    expect(isPrivateIpv4("172.16.0.0")).toBe(true);
    expect(isPrivateIpv4("172.31.255.255")).toBe(true);
    expect(isPrivateIpv4("172.32.0.0")).toBe(false);
  });

  it("never throws on arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(() => isPrivateIpv4(value)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("isPrivateIpv6", () => {
  it("blocks loopback, unspecified, link-local and unique-local", () => {
    for (const address of [
      "::1",
      "::",
      "fe80::1",
      "fe80::1%eth0",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "2001:db8::1",
    ]) {
      expect(isPrivateIpv6(address)).toBe(true);
    }
  });

  it("blocks an IPv4-mapped private address in dotted notation", () => {
    // ::ffff:169.254.169.254 tunnels the metadata endpoint through IPv6.
    expect(isPrivateIpv6("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateIpv6("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIpv6("::ffff:10.0.0.1")).toBe(true);
  });

  it("blocks an IPv4-mapped private address in hex notation", () => {
    // This is the form `new URL()` normalises the dotted notation into, so a
    // check that only understands dotted quads is bypassable.
    expect(isPrivateIpv6("::ffff:a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isPrivateIpv6("::ffff:7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateIpv6("::ffff:a00:1")).toBe(true); // 10.0.0.1
    expect(isPrivateIpv6("::ffff:c0a8:101")).toBe(true); // 192.168.1.1
    expect(isPrivateIpv6("::ffff:0:0")).toBe(true); // 0.0.0.0
  });

  it("allows a public IPv4-mapped address in hex notation", () => {
    expect(isPrivateIpv6("::ffff:808:808")).toBe(false); // 8.8.8.8
  });

  it("agrees between the dotted and hex notations of the same address", () => {
    const pairs: [string, string][] = [
      ["::ffff:169.254.169.254", "::ffff:a9fe:a9fe"],
      ["::ffff:127.0.0.1", "::ffff:7f00:1"],
      ["::ffff:8.8.8.8", "::ffff:808:808"],
      ["::ffff:1.1.1.1", "::ffff:101:101"],
    ];

    pairs.forEach(([dotted, hex]) => {
      expect(isPrivateIpv6(hex)).toBe(isPrivateIpv6(dotted));
    });
  });

  it("allows an IPv4-mapped public address and ordinary global unicast", () => {
    expect(isPrivateIpv6("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIpv6("2606:4700::1111")).toBe(false);
  });

  it("strips brackets from a literal host", () => {
    expect(isPrivateIpv6("[::1]")).toBe(true);
  });
});

describe("isPrivateAddress", () => {
  it("routes to the right family", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("treats an empty value as private, failing closed", () => {
    expect(isPrivateAddress("")).toBe(true);
    expect(isPrivateAddress("   ")).toBe(true);
  });

  it("returns false for a plain hostname, which needs DNS to judge", () => {
    // Names are handled by classifyHostname; this function only judges addresses.
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});

describe("classifyHostname", () => {
  it("refuses localhost and internal suffixes", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "printer.local",
      "db.internal",
      "wiki.intranet",
      "nas.lan",
      "router.home.arpa",
      "metadata.google.internal",
    ]) {
      expect(classifyHostname(host).allowed).toBe(false);
    }
  });

  it("refuses a single-label host", () => {
    // On most networks a bare label resolves through a search domain to an
    // internal machine.
    expect(classifyHostname("intranet").allowed).toBe(false);
    expect(classifyHostname("db").allowed).toBe(false);
  });

  it("refuses a private address given as the hostname", () => {
    expect(classifyHostname("127.0.0.1").allowed).toBe(false);
    expect(classifyHostname("169.254.169.254").allowed).toBe(false);
    expect(classifyHostname("[::1]").allowed).toBe(false);
  });

  it("is case-insensitive and tolerates a trailing dot", () => {
    // `LOCALHOST.` is the same host, and a naive check misses both variations.
    expect(classifyHostname("LOCALHOST").allowed).toBe(false);
    expect(classifyHostname("localhost.").allowed).toBe(false);
    expect(classifyHostname("METADATA.GOOGLE.INTERNAL").allowed).toBe(false);
  });

  it("allows an ordinary public hostname", () => {
    for (const host of ["example.com", "www.example.co.uk", "8.8.8.8"]) {
      expect(classifyHostname(host).allowed).toBe(true);
    }
  });

  it("never throws", () => {
    fc.assert(
      fc.property(fc.string(), (host) => {
        expect(() => classifyHostname(host)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});

describe("classifyPreviewUrl", () => {
  it("allows a normal https URL", () => {
    expect(classifyPreviewUrl("https://example.com/a/b?c=1").allowed).toBe(true);
  });

  it("refuses non-web schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com",
      "gopher://example.com",
      "data:text/html,<h1>x</h1>",
      "javascript:alert(1)",
    ]) {
      expect(classifyPreviewUrl(url).allowed).toBe(false);
    }
  });

  it("refuses credentials in the URL", () => {
    // Also used to disguise the real host from a human reader:
    // https://trusted.com@evil.com/
    expect(
      classifyPreviewUrl("https://user:pass@example.com").allowed,
    ).toBe(false);
    expect(classifyPreviewUrl("https://user@example.com").allowed).toBe(false);
  });

  it("refuses ports other than 80 and 443", () => {
    for (const port of [22, 3306, 5432, 6379, 8080, 9200]) {
      expect(
        classifyPreviewUrl(`https://example.com:${port}/`).allowed,
      ).toBe(false);
    }

    expect(classifyPreviewUrl("http://example.com:80/").allowed).toBe(true);
    expect(classifyPreviewUrl("https://example.com:443/").allowed).toBe(true);
  });

  it("refuses the metadata endpoint in every notation", () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:169.254.169.254]/",
      "http://metadata.google.internal/",
    ]) {
      expect(classifyPreviewUrl(url).allowed).toBe(false);
    }
  });

  it("refuses an unparseable value", () => {
    for (const url of ["", "not a url", "http://", "://example.com"]) {
      expect(classifyPreviewUrl(url).allowed).toBe(false);
    }
  });

  it("never throws, and always gives a reason when refusing", () => {
    fc.assert(
      // A throw inside the property is reported as a failure, so calling it
      // directly covers "never throws" without a closure assignment.
      fc.property(fc.string(), (raw) => {
        const verdict = classifyPreviewUrl(raw);

        if (!verdict.allowed) {
          expect(typeof verdict.reason).toBe("string");
          expect(verdict.reason.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });
});
