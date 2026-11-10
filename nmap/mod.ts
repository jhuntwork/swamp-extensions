// ABOUTME: Network scanning with nmap, producing structured host/port
// ABOUTME: resources for change tracking over time via the swamp data model.
// deno-lint-ignore-file no-import-prefix
import { z } from "npm:zod@4.4.3";
import { XMLParser } from "npm:fast-xml-parser@5.10.1";

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB stdout/stderr cap
const DEFAULT_PROBE_PORTS = "22,80,443,445,1400";
const DEFAULT_TIMING = "T4";
const PORT_STATES = [
  "open",
  "closed",
  "filtered",
  "unfiltered",
  "open|filtered",
  "closed|filtered",
] as const;

const TargetSchema = z.string().min(1).max(2048).refine(
  (value) => !/\s/.test(value) && !value.startsWith("-"),
  "must be one nmap target without whitespace or a leading option prefix",
);
const ProbePortsSchema = z.string().max(128).regex(
  /^(?:\d{1,5}(?:-\d{1,5})?)(?:,(?:\d{1,5}(?:-\d{1,5})?))*$/,
  "must be a comma-separated TCP port or port-range list",
).or(z.literal(""));
const PortSpecSchema = z.string().max(256).regex(
  /^(?:(?:[TUC]:)?\d{1,5}(?:-\d{1,5})?)(?:,(?:(?:[TUC]:)?\d{1,5}(?:-\d{1,5})?))*$/,
  "must be a comma-separated nmap port specification",
);

const GlobalArgsSchema = z.object({
  privileged: z.boolean().default(false).describe(
    "Run nmap in privileged mode (SYN scan, ARP discovery, OS detection). " +
      "Requires nmap to have CAP_NET_RAW+ep or be run as root. Default is " +
      "unprivileged TCP-connect scanning.",
  ),
  nmapPath: z.string().min(1).default("nmap").describe(
    "Path to the nmap binary. Default resolves 'nmap' via PATH.",
  ),
  timing: z.enum(["T0", "T1", "T2", "T3", "T4", "T5"]).default(DEFAULT_TIMING)
    .describe(
      "Nmap timing template. T0=paranoid (slowest), T3=normal (nmap default), " +
        "T4=aggressive (this extension's default, works on most networks), " +
        "T5=insane (fastest, may miss things).",
    ),
});

/** Metadata for a single scan invocation. */
const ScanSchema = z.object({
  target: z.string(),
  method: z.enum(["discover", "scan"]),
  args: z.array(z.string()),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  nmapVersion: z.string(),
  hostsUp: z.number().int().nonnegative(),
  hostsDown: z.number().int().nonnegative(),
  privileged: z.boolean(),
  success: z.boolean(),
  error: z.string().optional(),
});

/** A single discovered host, keyed by IP address. */
const HostSchema = z.object({
  ip: z.string(),
  hostname: z.string().optional(),
  macAddress: z.string().optional(),
  macVendor: z.string().optional(),
  state: z.enum(["up", "down", "unknown"]),
  reason: z.string().optional(),
  latencyMs: z.number().optional(),
  discoveredAt: z.string(),
  scanTarget: z.string(),
});

/** A single port on a host, keyed by ip-proto-port. */
const PortSchema = z.object({
  ip: z.string(),
  protocol: z.enum(["tcp", "udp", "sctp"]),
  port: z.number().int().min(0).max(65535),
  state: z.enum(PORT_STATES),
  reason: z.string().optional(),
  service: z.string().optional(),
  product: z.string().optional(),
  version: z.string().optional(),
  extraInfo: z.string().optional(),
  discoveredAt: z.string(),
});

// deno-lint-ignore no-explicit-any
type NmapXml = any;

/**
 * Encode characters that are not safe in a resource instance name.
 * Keeping the code point in the replacement avoids common IPv6/key
 * collisions caused by mapping every punctuation character to `_`.
 */
export function safeInstanceName(s: string): string {
  return s.replace(
    /[^a-zA-Z0-9._-]/g,
    (character) => `_u${character.codePointAt(0)!.toString(16)}_`,
  );
}

function assertTarget(value: string, label: string): void {
  TargetSchema.parse(value);
  if (value.length > 2048) {
    throw new Error(`${label} is too long`);
  }
}

function assertProbePorts(value: string | undefined): void {
  if (value !== undefined) ProbePortsSchema.parse(value);
}

function assertPortSpec(value: string | undefined): void {
  if (value !== undefined) PortSpecSchema.parse(value);
}

/** Read a subprocess stream without allowing unbounded output to accumulate. */
async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - length;
    if (remaining > 0) {
      const kept = value.subarray(0, Math.min(remaining, value.length));
      chunks.push(kept);
      length += kept.length;
    }
    if (value.length > remaining) truncated = true;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function decodeOutput(result: {
  bytes: Uint8Array;
  truncated: boolean;
}): string {
  const text = new TextDecoder().decode(result.bytes);
  return result.truncated ? `${text}\n... [truncated]` : text;
}

/** Run nmap with the given args, returning parsed XML + bounded raw output. */
async function runNmap(
  nmapPath: string,
  args: string[],
  // deno-lint-ignore no-explicit-any
  logger: any,
): Promise<{
  exitCode: number;
  xml: NmapXml | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  outputTruncated: boolean;
  spawnError?: string;
}> {
  const fullArgs = ["-oX", "-", ...args];
  logger.info("Executing: {cmd} {args}", {
    cmd: nmapPath,
    args: fullArgs.join(" "),
  });

  const start = performance.now();
  let output: {
    code: number;
    stdout: { bytes: Uint8Array; truncated: boolean };
    stderr: { bytes: Uint8Array; truncated: boolean };
  };
  try {
    // swamp-quality-ignore deno-command: nmap is the required external scanner
    const cmd = new Deno.Command(nmapPath, {
      args: fullArgs,
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const [stdout, stderr] = await Promise.all([
      readLimited(child.stdout!, MAX_OUTPUT_BYTES),
      readLimited(child.stderr!, MAX_OUTPUT_BYTES),
    ]);
    const status = await child.status;
    output = { code: status.code, stdout, stderr };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const msg = String(err);
    logger.error("nmap spawn failed: {err}", { err: msg });
    return {
      exitCode: -1,
      xml: null,
      stdout: "",
      stderr: "",
      durationMs,
      outputTruncated: false,
      spawnError: msg,
    };
  }
  const durationMs = Math.round(performance.now() - start);

  const stdout = decodeOutput(output.stdout);
  const stderr = decodeOutput(output.stderr);
  const outputTruncated = output.stdout.truncated || output.stderr.truncated;

  let xml: NmapXml | null = null;
  if (!output.stdout.truncated && stdout.trim().startsWith("<?xml")) {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      isArray: (name) => ["host", "port", "hostname", "address"].includes(name),
    });
    try {
      xml = parser.parse(stdout);
    } catch (err) {
      logger.warn("Failed to parse nmap XML output: {err}", {
        err: String(err),
      });
    }
  }

  return {
    exitCode: output.code,
    xml,
    stdout,
    stderr,
    durationMs,
    outputTruncated,
  };
}

/** Extract nmap version from parsed XML. */
function extractNmapVersion(xml: NmapXml): string {
  return xml?.nmaprun?.["@_version"] ?? "unknown";
}

/** Extract host records from parsed nmap XML. */
export function extractHosts(xml: NmapXml, target: string, now: string): {
  hosts: z.infer<typeof HostSchema>[];
  ports: z.infer<typeof PortSchema>[];
  hostsUp: number;
  hostsDown: number;
} {
  const hosts: z.infer<typeof HostSchema>[] = [];
  const ports: z.infer<typeof PortSchema>[] = [];
  let hostsUp = 0;
  let hostsDown = 0;

  const xmlHosts = xml?.nmaprun?.host ?? [];
  for (const h of xmlHosts) {
    const state = h?.status?.["@_state"] ?? "unknown";
    const reason = h?.status?.["@_reason"];

    // Round-trip time in milliseconds (nmap reports srtt in microseconds).
    const srttUs = h?.times?.["@_srtt"];
    const parsedLatencyMs = srttUs === undefined
      ? undefined
      : Number(srttUs) / 1000;
    const latencyMs = parsedLatencyMs !== undefined &&
        Number.isFinite(parsedLatencyMs)
      ? Math.round(parsedLatencyMs)
      : undefined;

    // Addresses: primary is IPv4/IPv6; MAC may also be present.
    let ip = "";
    let mac: string | undefined;
    let macVendor: string | undefined;
    const addrs = h?.address ?? [];
    for (const a of addrs) {
      const type = a?.["@_addrtype"];
      const addr = a?.["@_addr"];
      if (type === "ipv4" || type === "ipv6") {
        if (!ip) ip = addr;
      } else if (type === "mac") {
        mac = addr;
        macVendor = a?.["@_vendor"];
      }
    }
    if (!ip) continue;

    // Hostname: prefer first from hostnames.hostname[].
    let hostname: string | undefined;
    const hostnames = h?.hostnames?.hostname ?? [];
    if (Array.isArray(hostnames) && hostnames.length > 0) {
      hostname = hostnames[0]?.["@_name"];
    }

    hosts.push({
      ip,
      hostname,
      macAddress: mac,
      macVendor,
      state: state === "up" ? "up" : state === "down" ? "down" : "unknown",
      reason,
      latencyMs,
      discoveredAt: now,
      scanTarget: target,
    });

    if (state === "up") hostsUp++;
    else if (state === "down") hostsDown++;

    // Ports (only present in scan output, not discover).
    const xmlPorts = h?.ports?.port ?? [];
    for (const p of xmlPorts) {
      const protocol = p?.["@_protocol"];
      const portNum = Number(p?.["@_portid"]);
      const portState = p?.state?.["@_state"];
      if (
        !protocol ||
        !Number.isInteger(portNum) ||
        portNum < 0 ||
        portNum > 65535 ||
        !PORT_STATES.includes(portState)
      ) continue;
      if (!["tcp", "udp", "sctp"].includes(protocol)) continue;

      const svc = p?.service ?? {};
      ports.push({
        ip,
        protocol: protocol as "tcp" | "udp" | "sctp",
        port: portNum,
        state: portState,
        reason: p?.state?.["@_reason"],
        service: svc["@_name"],
        product: svc["@_product"],
        version: svc["@_version"],
        extraInfo: svc["@_extrainfo"],
        discoveredAt: now,
      });
    }
  }

  return { hosts, ports, hostsUp, hostsDown };
}

/** Model definition for nmap network scanning. */
export const model = {
  type: "@jeremy/nmap",
  version: "2026.11.10.1",
  description:
    "Network scanning with nmap. Produces structured host and port resources " +
    "keyed by IP and port number for change tracking over time via the swamp " +
    "data model. Uses nmap's XML output for reliable parsing.",
  upgrades: [{
    toVersion: "2026.11.10.1",
    description:
      "Pin dependencies, bound nmap output, reject option injection, and discard malformed XML port records.",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  }],
  globalArguments: GlobalArgsSchema,
  resources: {
    scan: {
      description: "Metadata for a single scan invocation",
      schema: ScanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    host: {
      description: "A discovered host, keyed by IP address",
      schema: HostSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
    port: {
      description:
        "An open (or filtered) port on a host, keyed by ip-proto-port",
      schema: PortSchema,
      lifetime: "infinite" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    discover: {
      description:
        "Discover live hosts on a subnet using ping + TCP SYN probes (nmap -sn). " +
        "By default probes ports 22,80,443,445,1400 for maximum coverage " +
        "without needing privileged mode — many devices (Sonos, printers, " +
        "IoT) don't respond to ICMP echo but do respond to SYN. With " +
        "privileged=true and arp=true, uses ARP requests instead (fastest " +
        "and most reliable on the local L2 segment).",
      arguments: z.object({
        subnet: TargetSchema.describe(
          "Target subnet in CIDR notation (e.g. '192.0.2.0/24') or a " +
            "range/host that nmap accepts.",
        ),
        probePorts: ProbePortsSchema.optional().describe(
          "Comma-separated TCP ports to include in host-discovery SYN " +
            "probes (nmap -PS). Default: '22,80,443,445,1400'. Set to " +
            "empty string to rely on ICMP only.",
        ),
        arp: z.boolean().optional().describe(
          "Use ARP discovery (-PR). Only works on the local L2 segment. " +
            "Requires privileged=true. When true, probePorts is ignored.",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { subnet, probePorts, arp } = args as {
          subnet: string;
          probePorts?: string;
          arp?: boolean;
        };
        const globalArgs = context.globalArgs;
        assertTarget(subnet, "subnet");
        assertProbePorts(probePorts);
        if (arp && !globalArgs.privileged) {
          throw new Error("arp=true requires privileged=true");
        }
        const now = new Date().toISOString();
        const nmapArgs: string[] = ["-sn", `-${globalArgs.timing}`];
        if (globalArgs.privileged) {
          if (arp) {
            nmapArgs.push("-PR");
          } else {
            const ports = probePorts ?? DEFAULT_PROBE_PORTS;
            if (ports) nmapArgs.push(`-PS${ports}`);
          }
        } else {
          nmapArgs.push("--unprivileged");
          const ports = probePorts ?? DEFAULT_PROBE_PORTS;
          if (ports) nmapArgs.push(`-PS${ports}`);
        }
        nmapArgs.push(subnet);

        const result = await runNmap(
          globalArgs.nmapPath,
          nmapArgs,
          context.logger,
        );

        const scanKey = safeInstanceName(`discover-${subnet}-${now}`);

        if (!result.xml) {
          const scanMeta = {
            target: subnet,
            method: "discover" as const,
            args: nmapArgs,
            startedAt: now,
            durationMs: result.durationMs,
            nmapVersion: "unknown",
            hostsUp: 0,
            hostsDown: 0,
            privileged: globalArgs.privileged,
            success: false,
            error: result.spawnError
              ? `Failed to spawn nmap at '${globalArgs.nmapPath}': ${result.spawnError}`
              : `nmap exited ${result.exitCode}; stderr: ${result.stderr}`,
          };
          const handle = await context.writeResource("scan", scanKey, scanMeta);
          return { dataHandles: [handle] };
        }

        const { hosts, hostsUp, hostsDown } = extractHosts(
          result.xml,
          subnet,
          now,
        );
        const handles = [];

        const scanMeta = {
          target: subnet,
          method: "discover" as const,
          args: nmapArgs,
          startedAt: now,
          durationMs: result.durationMs,
          nmapVersion: extractNmapVersion(result.xml),
          hostsUp,
          hostsDown,
          privileged: globalArgs.privileged,
          success: result.exitCode === 0,
        };
        handles.push(await context.writeResource("scan", scanKey, scanMeta));

        for (const host of hosts) {
          handles.push(
            await context.writeResource(
              "host",
              safeInstanceName(host.ip),
              host,
            ),
          );
        }

        context.logger.info(
          "Discover complete: {up} up, {down} down, {duration}ms",
          { up: hostsUp, down: hostsDown, duration: result.durationMs },
        );

        return { dataHandles: handles };
      },
    },
    scan: {
      description:
        "TCP scan of one or more targets with service detection. Produces " +
        "'host' resources per target and 'port' resources per interesting " +
        "port (open by default; closed ports skipped as noise). Uses -sV " +
        "for service+version detection. With privileged=true, uses SYN " +
        "scan (-sS); otherwise TCP connect (-sT).",
      arguments: z.object({
        target: TargetSchema.describe(
          "Host, subnet, or range that nmap accepts (e.g. '192.0.2.5', " +
            "'192.0.2.0/24', '198.51.100.1-50').",
        ),
        ports: PortSpecSchema.optional().describe(
          "Port specification (e.g. '80,443', '1-1000', 'T:80,U:53'). " +
            "Default: nmap's top 1000 TCP ports.",
        ),
        services: z.boolean().optional().default(true).describe(
          "Enable service/version detection (-sV). Default true.",
        ),
        includeClosed: z.boolean().optional().default(false).describe(
          "Emit port resources for closed ports too. Default false " +
            "(only open and filtered ports produce records).",
        ),
        includeFiltered: z.boolean().optional().default(true).describe(
          "Emit port resources for filtered ports. Default true " +
            "(filtered ports are useful for firewall/security context).",
        ),
      }),
      // deno-lint-ignore no-explicit-any
      execute: async (args: Record<string, unknown>, context: any) => {
        const { target, ports, services, includeClosed, includeFiltered } =
          args as {
            target: string;
            ports?: string;
            services?: boolean;
            includeClosed?: boolean;
            includeFiltered?: boolean;
          };
        const globalArgs = context.globalArgs;
        assertTarget(target, "target");
        assertPortSpec(ports);
        const now = new Date().toISOString();

        const nmapArgs: string[] = [`-${globalArgs.timing}`];
        if (globalArgs.privileged) {
          nmapArgs.push("-sS");
        } else {
          nmapArgs.push("-sT", "--unprivileged");
        }
        if (services !== false) nmapArgs.push("-sV");
        if (ports) nmapArgs.push("-p", ports);
        nmapArgs.push(target);

        const result = await runNmap(
          globalArgs.nmapPath,
          nmapArgs,
          context.logger,
        );

        const scanKey = safeInstanceName(`scan-${target}-${now}`);

        if (!result.xml) {
          const scanMeta = {
            target,
            method: "scan" as const,
            args: nmapArgs,
            startedAt: now,
            durationMs: result.durationMs,
            nmapVersion: "unknown",
            hostsUp: 0,
            hostsDown: 0,
            privileged: globalArgs.privileged,
            success: false,
            error: result.spawnError
              ? `Failed to spawn nmap at '${globalArgs.nmapPath}': ${result.spawnError}`
              : `nmap exited ${result.exitCode}; stderr: ${result.stderr}`,
          };
          const handle = await context.writeResource("scan", scanKey, scanMeta);
          return { dataHandles: [handle] };
        }

        const { hosts, ports: portRecords, hostsUp, hostsDown } = extractHosts(
          result.xml,
          target,
          now,
        );

        // Filter port records based on user preferences.
        const wantClosed = includeClosed === true;
        const wantFiltered = includeFiltered !== false;
        const filteredPortRecords = portRecords.filter((p) => {
          if (p.state === "open") return true;
          if (p.state === "closed" || p.state === "closed|filtered") {
            return wantClosed;
          }
          if (p.state === "filtered" || p.state === "open|filtered") {
            return wantFiltered;
          }
          return true; // unfiltered and anything else
        });

        const handles = [];

        const scanMeta = {
          target,
          method: "scan" as const,
          args: nmapArgs,
          startedAt: now,
          durationMs: result.durationMs,
          nmapVersion: extractNmapVersion(result.xml),
          hostsUp,
          hostsDown,
          privileged: globalArgs.privileged,
          success: result.exitCode === 0,
        };
        handles.push(await context.writeResource("scan", scanKey, scanMeta));

        for (const host of hosts) {
          handles.push(
            await context.writeResource(
              "host",
              safeInstanceName(host.ip),
              host,
            ),
          );
        }

        for (const port of filteredPortRecords) {
          const portKey = safeInstanceName(
            `${port.ip}-${port.protocol}-${port.port}`,
          );
          handles.push(await context.writeResource("port", portKey, port));
        }

        context.logger.info(
          "Scan complete: {hosts} hosts, {ports}/{total} ports emitted, {duration}ms",
          {
            hosts: hosts.length,
            ports: filteredPortRecords.length,
            total: portRecords.length,
            duration: result.durationMs,
          },
        );

        return { dataHandles: handles };
      },
    },
  },
};
