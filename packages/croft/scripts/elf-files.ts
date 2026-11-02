// The source-file names an ELF object was compiled from: the STT_FILE entries of its symbol table, which is what `nm -a` shows as
// `a name.c`. Linux builds of DuckDB's extensions keep them; the macOS builds do not (Mach-O, stripped). Little-endian ELF64 only,
// which is every Linux file croft pins (x86_64 and aarch64). Returns null for a file that is not that.
const STT_FILE = 4;

export function elfSourceFiles(bytes: Buffer): string[] | null {
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46) return null; // "\x7fELF"
  if (bytes[4] !== 2 || bytes[5] !== 1) return null; // ELFCLASS64, little-endian
  const shoff = Number(bytes.readBigUInt64LE(0x28));
  const shentsize = bytes.readUInt16LE(0x3a);
  const shnum = bytes.readUInt16LE(0x3c);
  if (!shoff || !shnum) return null;
  const section = (i: number) => {
    const o = shoff + i * shentsize;
    return {
      type: bytes.readUInt32LE(o + 4),
      offset: Number(bytes.readBigUInt64LE(o + 0x18)),
      size: Number(bytes.readBigUInt64LE(o + 0x20)),
      link: bytes.readUInt32LE(o + 0x28),
      entsize: Number(bytes.readBigUInt64LE(o + 0x38)),
    };
  };
  const SHT_SYMTAB = 2;
  const out = new Set<string>();
  for (let i = 0; i < shnum; i++) {
    const s = section(i);
    if (s.type !== SHT_SYMTAB || !s.entsize) continue;
    const strtab = section(s.link);
    for (let o = s.offset; o + s.entsize <= s.offset + s.size; o += s.entsize) {
      if ((bytes[o + 4]! & 0xf) !== STT_FILE) continue;
      const start = strtab.offset + bytes.readUInt32LE(o);
      const end = bytes.indexOf(0, start);
      const name = bytes.toString("latin1", start, end < 0 ? undefined : end);
      if (name) out.add(name);
    }
  }
  return out.size ? [...out] : null;
}
