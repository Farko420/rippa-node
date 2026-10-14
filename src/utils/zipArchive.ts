import { deflateRawSync } from "node:zlib";

/**
 * A MINIMAL ZIP WRITER — the counterpart to `extract-zip`.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * The node can READ archives (`extract-zip`, used by the OTA path and by the
 * bundled-Ollama installer) but it has never been able to WRITE one, because
 * nothing shipped a writer: `archiver`, `jszip` and `adm-zip` are all absent
 * from `package.json`, and adding a dependency whose only purpose was to freeze
 * two files into an archive would be a poor trade. The provisioning endpoint
 * (`POST /api/admin/provision-node`) needs exactly that, so the writer lives
 * here instead — ~120 lines of `node:zlib` and a CRC-32 table.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 *   - No ZIP64. Every member, and the archive itself, must stay under 4 GiB. The
 *     two things this actually packages (a `rippa-node.exe` of ~100 MB and a
 *     `rippa-satellite.apk` of ~12 MB) are orders of magnitude clear of that,
 *     and the guards below fail loudly rather than emitting a silently
 *     truncated archive if one ever is not.
 *   - No encryption, no spanning, no directory entries. A folder is implied by
 *     a `/` in a member name, which is how every unzip tool reads it anyway.
 *
 * STORE BY DEFAULT, DEFLATE ON REQUEST. The bytes being bundled are already
 * compressed artefacts (a `pkg`-frozen executable, and a signed APK which is
 * itself a zip), so re-deflating them would burn CPU and seconds of a
 * synchronous request for single-digit savings. Small text members —
 * `config.json`, the install notes — ask for `compress: true` and get it.
 */

/** One member of the archive. */
export interface ZipEntry {
  /** Member name. Forward slashes only; a `/` implies a folder. */
  name: string;
  /** Raw bytes (a string is written as UTF-8). */
  data: Buffer | Uint8Array | string;
  /**
   * Deflate this member. Default `false` (STORE) — see the note above. Deflate
   * is only used when it actually SHRINKS the payload; a tiny input that grows
   * under deflate is stored instead, because a compressed member larger than
   * its source is pure overhead.
   */
  compress?: boolean;
}

/** Largest value a classic (non-ZIP64) ZIP field can hold. */
const MAX_ZIP32 = 0xffffffff;

/**
 * CRC-32 (IEEE 802.3) lookup table, built once.
 *
 * ZIP stores a CRC of the UNCOMPRESSED bytes of every member. `node:zlib` has
 * no public CRC-32 helper, so the polynomial is evaluated here — the same
 * 0xEDB88320 reflected polynomial every zip tool uses.
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32 of a buffer, as an unsigned 32-bit integer. */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * MS-DOS packed date/time, the only timestamp format the classic ZIP header
 * has room for.
 *
 * Clamped at 1980 (the format's epoch — anything earlier is not representable)
 * and at 2107 (the year field is 7 bits). Seconds are stored in 2-second units,
 * so they are halved on the way in.
 */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, when.getFullYear()));
  const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const time =
    (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  return { time: time & 0xffff, date: date & 0xffff };
}

/** Normalises a member name: forward slashes, no leading slash, no `..`. */
function normalizeEntryName(raw: string): string {
  const cleaned = String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    // A `..` segment is the zip-slip vector on the way back OUT, so it is
    // dropped rather than preserved. Nothing this module writes needs it.
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
  if (!cleaned) throw new Error("createZipArchive: every entry needs a non-empty name.");
  return cleaned;
}


/**
 * Builds a ZIP archive from `entries`, in the given order.
 *
 * Throws — rather than silently truncating — when a member or the whole archive
 * would need ZIP64 fields this writer does not emit. A provisioning bundle that
 * looks complete but is missing its payload is worse than a failed request,
 * because the operator only discovers it on the target machine.
 *
 * @param options.when timestamp stamped on every member (defaults to now). The
 *   provisioner pins it so both members carry the same time.
 */
export function createZipArchive(
  entries: readonly ZipEntry[],
  options: { when?: Date } = {},
): Buffer {
  const { time, date } = dosDateTime(options.when ?? new Date());

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  /** Byte offset of each local header, which the central directory points back to. */
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(normalizeEntryName(entry.name), "utf8");
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data as Uint8Array | string);

    if (raw.length > MAX_ZIP32) {
      throw new Error(
        `createZipArchive: "${entry.name}" is ${raw.length} bytes, which needs ZIP64 — ` +
          "this writer only emits classic 32-bit headers.",
      );
    }

    const deflated = entry.compress ? deflateRawSync(raw, { level: 9 }) : raw;
    const useDeflate = Boolean(entry.compress) && deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    // 0 = STORE, 8 = DEFLATE. The two methods every unzip tool supports.
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);

    // --- Local file header (30 bytes + name + payload) ----------------------
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature "PK\x03\x04"
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    // Bit 11 (0x0800) declares the name is UTF-8. A node code and a version are
    // ASCII today, but a hand-supplied node name is not guaranteed to be, and a
    // mis-declared name is mojibake on the target machine.
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localChunks.push(local, name, payload);

    // --- Central directory entry (46 bytes + name) --------------------------
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // signature "PK\x01\x02"
    central.writeUInt16LE(20, 4); // version made by (2.0 / MS-DOS)
    central.writeUInt16LE(20, 6); // version needed to extract
    central.writeUInt16LE(0x0800, 8); // flags (UTF-8 names)
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    // External attributes: the high 16 bits are the Unix mode. 0o100644 (regular
    // file, rw-r--r--) stops `unzip` on the target from inventing 0777, and is
    // ignored by Windows entirely.
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    centralChunks.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);

  if (centralDirectory.length > MAX_ZIP32 || offset > MAX_ZIP32) {
    throw new Error(
      "createZipArchive: the archive exceeds the 4 GiB classic ZIP limit and would " +
        "need ZIP64, which this writer does not emit.",
    );
  }

  // --- End of central directory record (22 bytes) ---------------------------
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // signature "PK\x05\x06"
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries total
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16); // offset of the central directory
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralDirectory, end]);
}
