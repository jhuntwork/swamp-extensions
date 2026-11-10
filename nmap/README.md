# @jeremy/nmap

Network scanning with [nmap](https://nmap.org), stored as structured data for
change tracking over time via the swamp data model.

## Tools Required

- `nmap` on `PATH` (or configure with `nmapPath` global arg)

## Usage

```bash
# Install the extension
swamp extension pull @jeremy/nmap

# Create a model instance (unprivileged by default)
swamp model create @jeremy/nmap net-scan

# Or with privileged mode for SYN/ARP/OS detection
swamp model create @jeremy/nmap net-scan --global-arg privileged=true
```

### Discover live hosts on a subnet

```bash
swamp model method run net-scan discover --input subnet=192.0.2.0/24
```

Produces one `host` resource per live host, keyed by IP. Rerun later and
the swamp data model versions each host resource — diff over time to see
what appeared, disappeared, or changed.

By default, discovery probes TCP ports `22,80,443,445,1400` in addition
to ICMP echo — this catches devices (Sonos, printers, IoT) that don't
respond to ping. Override with:

```bash
swamp model method run net-scan discover \
  --input subnet=192.0.2.0/24 --input probePorts=80,443,22,53
```

### ARP-based discovery (privileged, LAN only)

```bash
swamp model method run net-scan discover \
  --input subnet=192.0.2.0/24 --input arp=true
```

More reliable than SYN sweeps on the local L2 segment. Requires
`privileged=true` on the model.

### Port and service scan

```bash
# Default: top 1000 TCP ports with service/version detection
swamp model method run net-scan scan --input target=192.0.2.5

# Specific ports
swamp model method run net-scan scan \
  --input target=192.0.2.0/24 --input ports=80,443,1400

# Skip service detection (faster)
swamp model method run net-scan scan \
  --input target=192.0.2.5 --input services=false

# Include closed ports too (default: open + filtered only)
swamp model method run net-scan scan \
  --input target=192.0.2.5 --input includeClosed=true
```

Produces `host` resources per target and `port` resources per
interesting port. Closed ports are skipped by default (they're noise for
inventory work). Port instance keys are `{ip}-{proto}-{port}` — so
"which hosts have port 1400 open?" becomes a natural data query:

```bash
swamp data query \
  'modelName == "net-scan" && specName == "port" && content.state == "open" && content.port == 1400'
```

### Input safety

The extension passes target and port values as direct argv entries, never through a
shell. Targets cannot contain whitespace or begin with `-`, and port lists are
restricted to numeric ranges (with optional `T:`, `U:`, or `C:` prefixes). This
prevents a target from being interpreted as an extra nmap option. `arp=true`
requires `privileged=true`; it fails rather than silently falling back to a
less precise discovery mode.


- **discover** — Ping sweep + TCP SYN probes to find live hosts. Falls back
  to `-sn --unprivileged -PS...` when unprivileged; can use `-PR` (ARP) with
  `privileged=true` and `arp=true`.
- **scan** — TCP scan (`-sT` unprivileged, `-sS` privileged) with optional
  service detection (`-sV`).

## Resources

- **scan** — Metadata per invocation: target, args, nmap version, duration,
  host counts, timestamp. Instance name is scan-descriptor + timestamp. GC
  retains 20 versions (audit log).
- **host** — Discovered host, keyed by IP. Contains ip, hostname, MAC,
  vendor, state, discovery reason, latency (round-trip time). GC retains
  100 versions (long change history).
- **port** — Port state, keyed by `{ip}-{proto}-{port}`. Contains state,
  service, product, version, extra info. GC retains 100 versions.

## Global Arguments

- **privileged** (bool, default false) — Enables SYN scans, ARP discovery,
  requires nmap capability or root.
- **nmapPath** (string, default `nmap`) — Path to nmap binary.
- **timing** (`T0..T5`, default `T4`) — Nmap timing template. Extension
  default is `T4` (aggressive but reliable). Set `T3` for nmap's polite
  default, `T5` for maximum speed, `T0-T2` for evasion/politeness.

## Method Arguments

**discover:**
- `subnet` (required) — CIDR, range, or host that nmap accepts.
- `probePorts` (optional, default `22,80,443,445,1400`) — TCP ports for
  SYN probes during host discovery. Empty string = ICMP only.
- `arp` (optional) — Use ARP (privileged + LAN only).

**scan:**
- `target` (required) — Host, subnet, or range.
- `ports` (optional) — Port spec. Default: nmap's top 1000 TCP.
- `services` (bool, default true) — Enable `-sV`.
- `includeClosed` (bool, default false) — Emit records for closed ports.
- `includeFiltered` (bool, default true) — Emit records for filtered ports.

## Design notes

- **Purpose-built methods, not a flag passthrough.** Rather than exposing
  every nmap option, this extension picks discovery and scanning use cases
  and constrains arguments to what matters.
- **Better default discovery.** ICMP-only ping sweep misses too many devices
  in real networks (30% missed on the author's home LAN). SYN probes to a
  curated port list are cheap and dramatically improve coverage.
- **XML output for reliability.** Uses `nmap -oX -` (XML to stdout), parsed
  with `fast-xml-parser`. Nmap's XML schema is stable and well-documented.
- **Ports as first-class resources.** Each interesting port is a separate
  resource rather than nested inside the host. Enables cross-host port
  queries without post-scan filtering.
- **Closed ports skipped by default.** They're noise for inventory work — a
  10-host scan of one closed port produced 10 port records with no
  actionable value. Users can opt back in via `includeClosed=true`.
- **Aggressive timing by default.** `-T4` is faster than nmap's `-T3`
  default with negligible reliability loss on modern networks. Users on
  fragile networks can drop to `T3` or lower.
- **Explicit privilege.** No auto-degradation. If you configure privileged
  mode, you get privileged features. If you don't, you get unprivileged
  scanning. Failures are clear.

## What's not (yet) here

- OS fingerprinting
- NSE script execution
- Vulnerability scanning
- Traceroute integration
- IPv6 (requires `-6`, easy to add)
- Delta reports (compare current scan to previous) — belongs in a report
  extension consuming this model's data

Add methods as concrete use cases emerge.
