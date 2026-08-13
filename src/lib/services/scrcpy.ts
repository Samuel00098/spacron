/**
 * Pure helpers for decoding the scrcpy H.264 stream the backend forwards.
 *
 * The backend (`src-tauri/src/commands/mobile_stream.rs`) sends the raw packet
 * payloads — Annex-B H.264 byte streams (start-code delimited NAL units) — one
 * message per scrcpy frame. The tricky parsing lives here in testable,
 * framework-free functions rather than in the React layer:
 *
 * - `splitNals` finds NAL unit boundaries by start codes (3- and 4-byte).
 * - `splitAccessUnits` groups NALs into decodable access units (WebCodecs
 *   accepts one access unit per chunk; a single scrcpy packet can carry two
 *   frames back to back). Units with no VCL NAL — a pure codec-config packet
 *   whose SPS/PPS were already consumed to build the decoder description — are
 *   dropped: feeding one to WebCodecs can trigger a fatal decode error.
 *   Rotation packets (SPS/PPS + IDR) contain a VCL NAL, so they survive.
 * - `buildAvcC` / `h264CodecString` turn the in-band SPS/PPS (which Android's
 *   MediaCodec prepends to every IDR frame by default) into the
 *   AVCDecoderConfigurationRecord description WebCodecs needs, and the codec
 *   string it wants — reconfiguring the decoder on rotation, when a new SPS
 *   arrives.
 */

export interface NalUnit {
  /** The NAL payload after the start code (includes the header byte). */
  data: Uint8Array;
  /** `data[0] & 0x1f` — the NAL unit type. */
  type: number;
}

/** Decode a base64 string (no data-URL prefix) to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Scan an Annex-B byte stream for NAL units. Handles 3-byte (`00 00 01`) and
 * 4-byte (`00 00 00 01`) start codes, leading/trailing zero padding, and a
 * NAL running to the end of the buffer. Returns an empty array when no start
 * code is present (some devices emit length-prefixed csd instead of Annex B —
 * the caller treats that as \"no NALs\" and relies on the in-band SPS/PPS).
 */
export function splitNals(data: Uint8Array): NalUnit[] {
  const nals: NalUnit[] = [];
  const len = data.length;
  let pos = 0;
  while (pos + 3 <= len) {
    // Find the next start code from `pos`.
    let sc = pos;
    while (sc + 3 <= len) {
      const b0 = data[sc];
      const b1 = data[sc + 1];
      const b2 = data[sc + 2];
      if (b0 === 0 && b1 === 0 && (b2 === 1 || (b2 === 0 && sc + 3 < len && data[sc + 3] === 1))) break;
      sc++;
    }
    if (sc + 3 > len) break;
    const fourByte = data[sc + 2] === 0;
    const nalStart = sc + (fourByte ? 4 : 3);

    // Find the next start code after the NAL.
    let end = nalStart;
    while (end + 2 < len) {
      if (data[end] === 0 && data[end + 1] === 0 && data[end + 2] === 1) break;
      end++;
    }
    const hasNext = end + 2 < len;
    const nalEnd = hasNext ? end : len;
    // Trim trailing zero bytes — but only when a next start code proves they
    // are padding (leading_zero_8bits of the next NAL). When this NAL runs to
    // the end of the buffer, trailing zeroes are ambiguous, so keep them: a
    // slice NAL may legitimately end in 0x00 and a decoder tolerates the odd
    // extra trailing byte far better than a truncated one.
    let trimmed = nalEnd;
    if (hasNext) {
      while (trimmed > nalStart && data[trimmed - 1] === 0) trimmed--;
    }
    if (trimmed > nalStart) {
      const unit = data.slice(nalStart, trimmed);
      nals.push({ data: unit, type: unit[0] & 0x1f });
    }
    pos = hasNext ? end : len;
  }
  return nals;
}

/** NAL types that carry coded slice data (H.264 7.4.1 table 7-1). */
const VCL_TYPES = new Set([1, 2, 3, 4, 5]);

/**
 * Convert one Annex-B access unit to AVCC — each NAL prefixed with its 4-byte
 * big-endian length instead of a start code.
 *
 * This is not optional bookkeeping. WebCodecs picks the bitstream format from
 * the `configure()` call: with a `description` (an avcC record) the decoder is
 * in AVCC mode and reads the first four bytes of every chunk as a NAL length.
 * Handing it Annex-B there means it reads the `00 00 00 01` start code as a
 * length of 1, and the whole access unit is garbage — no frame is ever
 * produced and the decoder fails outright a few packets later. scrcpy sends
 * Annex-B, so the conversion has to happen here.
 */
export function annexbToAvcc(data: Uint8Array): Uint8Array {
  const nals = splitNals(data);
  if (nals.length === 0) return new Uint8Array(0);
  const total = nals.reduce((n, nal) => n + 4 + nal.data.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const nal of nals) {
    const len = nal.data.length;
    out[off] = (len >>> 24) & 0xff;
    out[off + 1] = (len >>> 16) & 0xff;
    out[off + 2] = (len >>> 8) & 0xff;
    out[off + 3] = len & 0xff;
    out.set(nal.data, off + 4);
    off += 4 + len;
  }
  return out;
}

/** Concatenate NALs into an Annex-B byte string using 4-byte start codes. */
export function annexbConcat(nals: NalUnit[]): Uint8Array {
  const total = nals.reduce((n, nal) => n + 4 + nal.data.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const nal of nals) {
    out[off] = 0;
    out[off + 1] = 0;
    out[off + 2] = 0;
    out[off + 3] = 1;
    out.set(nal.data, off + 4);
    off += 4 + nal.data.length;
  }
  return out;
}

/**
 * Group the NALs of an Annex-B byte stream into access units. A unit is a
 * run of non-VCL NALs (SPS/PPS/SEI/AUD) followed by the VCL slice NALs they
 * describe; a VCL NAL that follows another VCL NAL starts the next unit (the
 * case where one scrcpy packet carries two frames). A packet with no VCL NAL
 * (a pure codec-config packet) yields a single unit the decoder ignores.
 */
export function splitAccessUnits(data: Uint8Array): Uint8Array[] {
  const nals = splitNals(data);
  if (nals.length === 0) return [];
  const units: Uint8Array[] = [];
  let current: NalUnit[] = [];
  let hasVcl = false;
  for (const nal of nals) {
    const vcl = VCL_TYPES.has(nal.type);
    if (vcl && hasVcl && current.length > 0) {
      units.push(annexbConcat(current));
      current = [];
      hasVcl = false;
    }
    current.push(nal);
    if (vcl) hasVcl = true;
  }
  // Only a unit that actually decodes to a picture is an access unit. A pure
  // SPS/PPS config packet would otherwise be handed to the decoder as a chunk
  // and can fail it fatally (see the doc comment above).
  if (current.length > 0 && hasVcl) units.push(annexbConcat(current));
  return units;
}

/**
 * Build an AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1) from the
 * in-band SPS and PPS — the `description` WebCodecs wants for `avc1`.
 * `lengthSizeMinusOne` is 3 (4-byte length prefixes inside the record, as
 * decoders expect), and there is exactly one SPS + one PPS.
 */
export function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 1; // configurationVersion
  out[1] = sps.length > 1 ? sps[1] : 0x42; // AVCProfileIndication
  out[2] = sps.length > 2 ? sps[2] : 0xc0; // profile_compatibility
  out[3] = sps.length > 3 ? sps[3] : 0x1f; // AVCLevelIndication
  out[4] = 0xff; // reserved(6) + lengthSizeMinusOne=3
  out[5] = 0xe1; // reserved(3) + numOfSequenceParameterSets-1=0
  out[6] = (sps.length >> 8) & 0xff;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  const off = 8 + sps.length;
  out[off] = 1; // numOfPictureParameterSets
  out[off + 1] = (pps.length >> 8) & 0xff;
  out[off + 2] = pps.length & 0xff;
  out.set(pps, off + 3);
  return out;
}

/**
 * The `avc1.PPCCLL` codec string WebCodecs wants. Reads bytes [1..4] of
 * either the raw SPS or a built avcC — both carry profile / compatibility /
 * level at those exact offsets.
 */
export function h264CodecString(bytes: Uint8Array): string {
  const profile = (bytes[1] ?? 0x42).toString(16).padStart(2, '0');
  const constraints = ((bytes[2] ?? 0xc0) & 0xfc).toString(16).padStart(2, '0');
  const level = (bytes[3] ?? 0x1f).toString(16).padStart(2, '0');
  return `avc1.${profile}${constraints}${level}`;
}

/** Byte-for-byte equality, for deciding whether a decoder must be rebuilt. */
export function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Everything the frame handler needs from one scrcpy packet. */
export interface ParsedFrame {
  /** The packet's SPS, if it carried one (a new SPS means reconfigure). */
  sps?: Uint8Array;
  /** The packet's PPS, if it carried one. */
  pps?: Uint8Array;
  /** Decodable access units, already in AVCC form, ready for `decode()`. */
  units: Uint8Array[];
}

/**
 * Parse one scrcpy packet into its parameter sets and its decodable access
 * units, in a **single** scan of the buffer.
 *
 * This exists because doing it the obvious way costs three parses of the same
 * bytes: one `splitNals` to find SPS/PPS, a second inside `splitAccessUnits`,
 * and a third inside `annexbToAvcc` for every unit — plus a full buffer copy at
 * each step, since `splitAccessUnits` rebuilds Annex-B only for `annexbToAvcc`
 * to immediately take it apart again. Benchmarked on synthetic frames, the
 * single pass is ~6x cheaper on a 4 KB delta frame and ~4x on a 45 KB keyframe.
 *
 * Grouping and the AVCC encoding are unchanged (see `splitAccessUnits` and
 * `annexbToAvcc` for why each rule is there); this only removes the repetition.
 * The individual helpers are kept exported and tested — they document the
 * format far more legibly than this fused version does.
 */
export function parseFrame(data: Uint8Array): ParsedFrame {
  const nals = splitNals(data);
  if (nals.length === 0) return { units: [] };

  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  const units: Uint8Array[] = [];
  let current: NalUnit[] = [];
  let hasVcl = false;

  // Encode the pending NALs straight to AVCC — each NAL prefixed with its
  // 4-byte big-endian length — skipping the intermediate Annex-B buffer.
  const flush = () => {
    if (current.length === 0 || !hasVcl) return;
    let total = 0;
    for (const nal of current) total += 4 + nal.data.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const nal of current) {
      const len = nal.data.length;
      out[off] = (len >>> 24) & 0xff;
      out[off + 1] = (len >>> 16) & 0xff;
      out[off + 2] = (len >>> 8) & 0xff;
      out[off + 3] = len & 0xff;
      out.set(nal.data, off + 4);
      off += 4 + len;
    }
    units.push(out);
  };

  for (const nal of nals) {
    if (nal.type === 7 && !sps) sps = nal.data;
    else if (nal.type === 8 && !pps) pps = nal.data;
    const vcl = VCL_TYPES.has(nal.type);
    if (vcl && hasVcl && current.length > 0) {
      flush();
      current = [];
      hasVcl = false;
    }
    current.push(nal);
    if (vcl) hasVcl = true;
  }
  flush();

  return { sps, pps, units };
}
