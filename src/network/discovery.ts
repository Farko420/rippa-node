import dgram from "node:dgram";
import os from "node:os";
import { normalizeNodeCode } from "../config/nodeAuth";

/**
 * LAN AUTO-DISCOVERY — zero-configuration Satellite → Master linking.
 *
 * Satellites normally need the Master's LAN IP typed by hand, which breaks the
 * moment a DHCP lease changes, a PC is renamed, or a VPN adapter claims the
 * default route. To remove that fragility, every Master broadcasts a small
 * UDP beacon to the local broadcast address; Satellites listen for a few
 * seconds and get a ready-to-use list of Master URLs.
 *
 * Design notes:
 *  - `dgram` (UDP) is used because it needs no open firewall state, no extra
 *    discovery dependency, and is available natively in the pkg build.
 *  - Broadcast is used rather than multicast so it works on consumer routers
 *    and Windows networks without IGMP configuration.
 *  - Every failure path degrades to "no results found". Discovery is a
 *    convenience, never a hard dependency — manual IP entry remains.
 */

/** UDP port for the beacon. Fixed and documented so both roles always agree. */
export const DISCOVERY_PORT = 45678;

/** How often a Master re-announces itself, in milliseconds. */
export const BEACON_INTERVAL_MS = 5_000;

/**
 * How long a Satellite listens for beacons before returning results.
 * MUST be >= BEACON_INTERVAL_MS, otherwise a satellite that starts listening
 * just after a beacon fires would time out before the next one arrives and
 * report "no Masters found" even though one is running. The extra margin
 * absorbs timer jitter.
 */
export const SCAN_DURATION_MS = 6_000;

/** Protocol marker so unrelated UDP traffic on the port is ignored. */
const BEACON_KIND = "rippa-node-beacon/v1";

/** A Master node found on the local network. */
export interface DiscoveredMaster {
  nodeName: string;
  /**
   * The Master's permanent node code (`RIPPA-XXXX-XXXX`).
   *
   * Present so a Satellite can be pointed at its Master by CODE rather than by IP.
   * The beacon is the only channel a Master has on the LAN, and without its code
   * in the payload a code typed into the setup form was unresolvable — the field
   * looked like it accepted one and then always failed with "not a valid URL".
   */
  nodeCode: string;
  ipAddress: string;
  /** The Master's API port. */
  port: number;
  /** Ready-to-use base URL, e.g. "http://192.168.0.221:4000". */
  url: string;
}

interface BeaconPayload {
  kind: string;
  nodeName: string;
  nodeCode: string;
  ipAddress: string;
  port: number;
}

/**
 * Best-effort primary LAN IPv4 address of this machine, used as the advertised
 * address. Prefers RFC1918 ranges so a VPN/WSL virtual adapter is not
 * advertised ahead of the real router lease. Falls back to loopback.
 */
export function localIPv4(): string {
  const privateAddresses: string[] = [];
  const others: string[] = [];

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (isPrivateIPv4(address.address)) privateAddresses.push(address.address);
      else others.push(address.address);
    }
  }
  return privateAddresses[0] ?? others[0] ?? "127.0.0.1";
}

/** True when an address is in an RFC1918 private range. */
export function isPrivateIPv4(address: string): boolean {
  return (
    /^192\.168\./.test(address) ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/**
 * Builds the beacon payload this node advertises as a Master.
 *
 * `nodeCode` is read from this node's own permanent identity rather than passed
 * in, so it can never drift from the code this node authenticates with.
 */
function buildBeacon(nodeName: string, port: number, nodeCode: string): BeaconPayload {
  return { kind: BEACON_KIND, nodeName, nodeCode, ipAddress: localIPv4(), port };
}

/**
 * Broadcast addresses to announce on: this node's subnet broadcast address
 * first, then the global broadcast address as a fallback.
 *
 * The subnet address (e.g. 192.168.0.255) is what most consumer routers and
 * Windows firewall profiles actually permit, and it never leaves the LAN.
 */
export function broadcastTargets(): string[] {
  const targets = new Set<string>();
  const address = localIPv4();
  const octets = address.split(".");
  if (octets.length === 4) {
    targets.add(`${octets[0]}.${octets[1]}.${octets[2]}.255`);
  }
  targets.add("255.255.255.255");
  return [...targets];
}

/**
 * True when this node should advertise itself on the LAN.
 * Satellites never broadcast — they are the ones looking for a Master.
 */
export function shouldAdvertise(role: string): boolean {
  return role !== "satellite";
}

/**
 * Master-side beacon broadcaster.
 *
 * Owns one UDP socket and re-broadcasts on an interval. `stop()` is
 * idempotent and safe to call when the beacon was never started (e.g. this node
 * is a Satellite, or a GUI save demoted it to satellite role).
 */
export class MasterBeacon {
  private socket: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;

  /**
   * Starts broadcasting. Resolves `false` — never throws — when the socket is
   * unavailable, because a blocked UDP port must not stop the node booting.
   */
  start(nodeName: string, port: number, nodeCode: string): Promise<boolean> {
    if (this.timer) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      let sock: dgram.Socket;
      try {
        sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
      } catch (error) {
        console.warn(`[Discovery] Beacon socket unavailable — ${describe(error)}`);
        finish(false);
        return;
      }
      this.socket = sock;

      sock.on("error", (error) => {
        // Non-fatal: log and stop advertising, leaving the node fully usable.
        console.warn(`[Discovery] Beacon socket error — ${describe(error)}`);
        this.stop();
        finish(false);
      });

      sock.on("listening", () => {
        // setBroadcast(true) MUST precede sending to a broadcast address —
        // on Windows the socket gets EACCES until it is opted in.
        let broadcastOk = false;
        try {
          sock.setBroadcast(true);
          broadcastOk = true;
        } catch (error) {
          console.warn(`[Discovery] Could not enable broadcast — ${describe(error)}`);
        }

        const announce = (): void => {
          const payload = Buffer.from(JSON.stringify(buildBeacon(nodeName, port, nodeCode)), "utf8");
          // Send to the subnet broadcast address for this node, falling back to
          // the global broadcast address. The subnet address is what a Windows
          // firewall profile typically permits.
          for (const target of broadcastTargets()) {
            sock.send(payload, 0, payload.length, DISCOVERY_PORT, target, (error) => {
              if (error) {
                console.warn(`[Discovery] Beacon send to ${target} failed — ${describe(error)}`);
              }
            });
          }
        };

        // Announce immediately, then on the interval.
        announce();
        this.timer = setInterval(announce, BEACON_INTERVAL_MS);
        console.log(
          `[Discovery] Beacon broadcasting as "${nodeName}" ` +
            `(${localIPv4()}:${port}) every ${BEACON_INTERVAL_MS / 1000}s` +
            `${broadcastOk ? "" : " [broadcast unavailable]"}`,
        );
        finish(true);
      });

      try {
        sock.bind({ port: DISCOVERY_PORT, address: "0.0.0.0" });
      } catch (error) {
        console.warn(`[Discovery] Could not bind UDP ${DISCOVERY_PORT} — ${describe(error)}`);
        this.stop();
        finish(false);
      }
    });
  }

  /** Stops broadcasting and closes the socket. Safe to call repeatedly. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // Already closed.
      }
      this.socket = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

/**
 * Satellite-side scan: listens for Master beacons for `timeoutMs` and resolves
 * with everything heard, de-duplicated by URL and sorted by node name.
 *
 * Always resolves (never rejects): a firewall, a busy port, or a network that
 * blocks broadcast simply yields an empty list, and the UI falls back to
 * manual entry.
 */
export function scanForMasters(timeoutMs: number = SCAN_DURATION_MS): Promise<DiscoveredMaster[]> {
  return new Promise<DiscoveredMaster[]>((resolve) => {
    const found = new Map<string, DiscoveredMaster>();
    let settled = false;
    let sock: dgram.Socket | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sock) {
        try {
          sock.close();
        } catch {
          // Already closed.
        }
      }
      resolve([...found.values()].sort((a, b) => a.nodeName.localeCompare(b.nodeName)));
    };

    const timer = setTimeout(finish, timeoutMs);

    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch (error) {
      console.warn(`[Discovery] Scan socket unavailable — ${describe(error)}`);
      finish();
      return;
    }

    const active = sock;

    active.on("error", (error) => {
      console.warn(`[Discovery] Scan socket error — ${describe(error)}`);
      finish();
    });

    active.on("message", (message) => {
      const master = parseBeacon(message);
      if (master) found.set(master.url, master);
    });

    active.on("listening", () => {
      try {
        // Broadcast datagrams sent to the subnet broadcast address are only
        // delivered to sockets that explicitly opt in.
        active.setBroadcast(true);
      } catch {
        /* best effort */
      }
    });

    try {
      active.bind({ port: DISCOVERY_PORT, address: "0.0.0.0" });
    } catch (error) {
      console.warn(
        `[Discovery] Could not bind UDP ${DISCOVERY_PORT} for scanning — ${describe(error)}`,
      );
      finish();
    }
  });
}

/**
 * Parses and validates an inbound datagram.
 * Returns null for anything that is not a well-formed Rippa beacon — another
 * process may legitimately share UDP port 45678.
 */
function parseBeacon(message: Buffer): DiscoveredMaster | null {
  let payload: Partial<BeaconPayload>;
  try {
    payload = JSON.parse(message.toString("utf8")) as Partial<BeaconPayload>;
  } catch {
    return null; // not JSON — ignore
  }
  if (!payload || payload.kind !== BEACON_KIND) return null;

  const ipAddress = typeof payload.ipAddress === "string" ? payload.ipAddress.trim() : "";
  const port = Number(payload.port);
  if (!ipAddress || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  const nodeName =
    (typeof payload.nodeName === "string" && payload.nodeName.trim()) || ipAddress;
  // Normalised through the same rules the setup form uses, so a code read off
  // the wire compares equal to one typed by hand. A beacon with no usable code
  // is still returned (it can be picked by address), just with an empty code.
  const nodeCode = normalizeNodeCode(payload.nodeCode);

  return { nodeName, nodeCode, ipAddress, port, url: `http://${ipAddress}:${port}` };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

