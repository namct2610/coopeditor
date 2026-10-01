// Streaming ZIP writer, STORE method only (no compression): video is already
// compressed, deflate would burn NAS CPU for ~1% gain. Each file is read once,
// CRC'd on the fly and written straight to the response — no temp file, a few
// MB of RAM regardless of archive size. Sizes are known up front, so the exact
// archive length is computable (zipLength) and sent as Content-Length.
//
// The CRC is only known after the data, so entries use a data descriptor
// (flag bit 3). The local header still carries the real sizes, so streaming
// readers can find the end of each stored entry. ZIP64 kicks in per entry /
// for the end record only when a size or offset crosses 4 GiB.
import { createReadStream } from "node:fs";
import { once } from "node:events";
import { crc32 } from "node:zlib";

const MAX32 = 0xffffffff;
const FLAGS = 0x0808; // bit 3: data descriptor, bit 11: UTF-8 names

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name, path, size, mtime? }] → layout with offsets + zip64 flags.
// `limit` is the ZIP64 threshold; tests lower it to exercise the ZIP64 path
// without writing 4 GiB.
function plan(entries, limit) {
  let offset = 0;
  const items = entries.map((e) => {
    const nameBuf = Buffer.from(e.name, "utf8");
    const zip64 = e.size >= limit || offset >= limit;
    const { time, date } = dosDateTime(e.mtime || new Date());
    const item = { ...e, nameBuf, zip64, offset, time, date };
    offset += localHeader(item).length + e.size + (zip64 ? 24 : 16);
    return item;
  });
  return { items, cdOffset: offset };
}

function localHeader(it) {
  const extra = it.zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
  if (it.zip64) {
    extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(it.size), 4); extra.writeBigUInt64LE(BigInt(it.size), 12);
  }
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(it.zip64 ? 45 : 20, 4);
  h.writeUInt16LE(FLAGS, 6);
  h.writeUInt16LE(0, 8); // store
  h.writeUInt16LE(it.time, 10); h.writeUInt16LE(it.date, 12);
  h.writeUInt32LE(0, 14); // crc → data descriptor
  h.writeUInt32LE(it.zip64 ? MAX32 : it.size, 18);
  h.writeUInt32LE(it.zip64 ? MAX32 : it.size, 22);
  h.writeUInt16LE(it.nameBuf.length, 26); h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, it.nameBuf, extra]);
}

function dataDescriptor(it, crc) {
  const d = Buffer.alloc(it.zip64 ? 24 : 16);
  d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc >>> 0, 4);
  if (it.zip64) { d.writeBigUInt64LE(BigInt(it.size), 8); d.writeBigUInt64LE(BigInt(it.size), 16); }
  else { d.writeUInt32LE(it.size, 8); d.writeUInt32LE(it.size, 12); }
  return d;
}

function centralEntry(it, crc, limit) {
  const bigSize = it.size >= limit;
  const bigOff = it.offset >= limit;
  const fields = [bigSize && it.size, bigSize && it.size, bigOff && it.offset].filter((v) => v !== false);
  const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
  if (fields.length) {
    extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(fields.length * 8, 2);
    fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + i * 8));
  }
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE((3 << 8) | 45, 4); // made by: unix, 4.5
  h.writeUInt16LE(it.zip64 || fields.length ? 45 : 20, 6);
  h.writeUInt16LE(FLAGS, 8);
  h.writeUInt16LE(0, 10);
  h.writeUInt16LE(it.time, 12); h.writeUInt16LE(it.date, 14);
  h.writeUInt32LE(crc >>> 0, 16);
  h.writeUInt32LE(bigSize ? MAX32 : it.size, 20);
  h.writeUInt32LE(bigSize ? MAX32 : it.size, 24);
  h.writeUInt16LE(it.nameBuf.length, 28); h.writeUInt16LE(extra.length, 30);
  h.writeUInt16LE(0, 32); h.writeUInt16LE(0, 34); h.writeUInt16LE(0, 36);
  h.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  h.writeUInt32LE(bigOff ? MAX32 : it.offset, 42);
  return Buffer.concat([h, it.nameBuf, extra]);
}

function endRecords(count, cdOffset, cdSize, limit) {
  const zip64 = count >= 0xffff || cdOffset >= limit || cdSize >= limit;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : count, 8); eocd.writeUInt16LE(zip64 ? 0xffff : count, 10);
  eocd.writeUInt32LE(zip64 ? MAX32 : cdSize, 12); eocd.writeUInt32LE(zip64 ? MAX32 : cdOffset, 16);
  if (!zip64) return eocd;
  const rec = Buffer.alloc(56);
  rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4);
  rec.writeUInt16LE((3 << 8) | 45, 12); rec.writeUInt16LE(45, 14);
  rec.writeBigUInt64LE(BigInt(count), 24); rec.writeBigUInt64LE(BigInt(count), 32);
  rec.writeBigUInt64LE(BigInt(cdSize), 40); rec.writeBigUInt64LE(BigInt(cdOffset), 48);
  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(0x07064b50, 0); loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8); loc.writeUInt32LE(1, 16);
  return Buffer.concat([rec, loc, eocd]);
}

export function zipLength(entries, { limit = MAX32 } = {}) {
  const { items, cdOffset } = plan(entries, limit);
  const cdSize = items.reduce((n, it) => n + centralEntry(it, 0, limit).length, 0);
  return cdOffset + cdSize + endRecords(items.length, cdOffset, cdSize, limit).length;
}

// Writes the archive to `out` (an http.ServerResponse or any Writable),
// honouring backpressure. Throws if a file is shorter than its planned size
// (changed on disk mid-download) — the caller must destroy the response so the
// browser sees a failed download instead of a silently corrupt archive.
export async function writeZip(out, entries, { limit = MAX32 } = {}) {
  const { items, cdOffset } = plan(entries, limit);
  const write = async (buf) => { if (!out.write(buf)) await once(out, "drain"); };
  const crcs = [];
  for (const it of items) {
    if (out.destroyed) return;
    await write(localHeader(it));
    let crc = 0, read = 0;
    if (it.size > 0) {
      const stream = createReadStream(it.path, { start: 0, end: it.size - 1 });
      try {
        for await (const chunk of stream) {
          if (out.destroyed) return;
          crc = crc32(chunk, crc);
          read += chunk.length;
          await write(chunk);
        }
      } finally { stream.destroy(); }
    }
    if (read !== it.size) throw new Error("file changed while zipping: " + it.name);
    crcs.push(crc);
    await write(dataDescriptor(it, crc));
  }
  const cd = Buffer.concat(items.map((it, i) => centralEntry(it, crcs[i], limit)));
  await write(Buffer.concat([cd, endRecords(items.length, cdOffset, cd.length, limit)]));
}
