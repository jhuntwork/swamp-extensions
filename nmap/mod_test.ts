import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { extractHosts, model, safeInstanceName } from "./mod.ts";

Deno.test("extractHosts keeps valid records and skips malformed ports", () => {
  const result = extractHosts(
    {
      nmaprun: {
        host: [{
          status: { "@_state": "up", "@_reason": "syn-ack" },
          times: { "@_srtt": "1234" },
          address: [
            { "@_addrtype": "ipv6", "@_addr": "2001:db8::5" },
            { "@_addrtype": "mac", "@_addr": "00:11:22:33:44:55" },
          ],
          hostnames: { hostname: [{ "@_name": "scanner.example" }] },
          ports: {
            port: [
              {
                "@_protocol": "tcp",
                "@_portid": "443",
                state: { "@_state": "open", "@_reason": "syn-ack" },
                service: { "@_name": "https", "@_version": "1" },
              },
              {
                "@_protocol": "tcp",
                "@_portid": "65536",
                state: { "@_state": "open" },
              },
              {
                "@_protocol": "tcp",
                "@_portid": "22",
                state: { "@_state": "not-a-state" },
              },
            ],
          },
        }],
      },
    },
    "2001:db8::/64",
    "2026-11-10T00:00:00.000Z",
  );

  assertEquals(result.hostsUp, 1);
  assertEquals(result.hostsDown, 0);
  assertEquals(result.hosts[0].ip, "2001:db8::5");
  assertEquals(result.hosts[0].latencyMs, 1);
  assertEquals(result.ports.length, 1);
  assertEquals(result.ports[0].port, 443);
});

Deno.test("safeInstanceName preserves distinct IPv6 addresses", () => {
  assertEquals(
    safeInstanceName("2001:db8::1"),
    "2001_u3a_db8_u3a__u3a_1",
  );
  assertEquals(
    safeInstanceName("2001_db8__1"),
    "2001_db8__1",
  );
  assertEquals(
    safeInstanceName("2001:db8::1") === safeInstanceName("2001_db8__1"),
    false,
  );
});

Deno.test("argument schemas reject nmap option injection", () => {
  assertThrows(() =>
    model.methods.scan.arguments.parse({ target: "--script=default" })
  );
  assertThrows(() =>
    model.methods.scan.arguments.parse({
      target: "192.0.2.1",
      ports: "--script",
    })
  );
});

Deno.test("discover rejects ARP in unprivileged mode", async () => {
  await assertRejects(
    () =>
      model.methods.discover.execute(
        { subnet: "192.0.2.0/24", arp: true },
        {
          globalArgs: {
            privileged: false,
            nmapPath: "nmap",
            timing: "T4",
          },
          logger: { info() {}, warn() {}, error() {} },
        },
      ),
    Error,
    "arp=true requires privileged=true",
  );
});

Deno.test("model has the current version and an upgrade path", () => {
  assertEquals(model.version, "2026.11.10.1");
  assertEquals(model.upgrades?.[0]?.toVersion, "2026.11.10.1");
});
