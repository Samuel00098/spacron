import { describe, expect, it } from 'vitest';
import {
  annexbConcat,
  annexbToAvcc,
  arraysEqual,
  base64ToBytes,
  buildAvcC,
  h264CodecString,
  parseFrame,
  splitAccessUnits,
  splitNals,
} from './scrcpy';

// A plausible 1080p SPS/PPS (profile 42 / level 1f) — the exact content does
// not matter, only that the helpers treat them as opaque NAL payloads.
const SPS = Uint8Array.from([0x67, 0x42, 0xc0, 0x1f, 0x8c, 0x8d, 0x40, 0x50, 0x1e]);
const PPS = Uint8Array.from([0x68, 0xce, 0x33, 0x20]);

/** A NAL prefixed with a 4-byte start code. */
function sc4(nal: number[] | Uint8Array): Uint8Array {
  return Uint8Array.from([0x00, 0x00, 0x00, 0x01, ...nal]);
}

describe('splitNals', () => {
  it('splits a config + frame packet into SPS, PPS and slice NALs', () => {
    const packet = Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4([0x65, 0x88, 0x84, 0x00])]);
    const nals = splitNals(packet);
    expect(nals.map((n) => n.type)).toEqual([7, 8, 5]);
    expect(nals[0].data).toEqual(SPS);
    expect(nals[1].data).toEqual(PPS);
    expect(nals[2].data).toEqual(Uint8Array.from([0x65, 0x88, 0x84, 0x00]));
  });

  it('handles 3-byte start codes', () => {
    const packet = Uint8Array.from([0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x00, 0x01, 0x65, 0x11]);
    const nals = splitNals(packet);
    expect(nals.map((n) => n.type)).toEqual([7, 5]);
  });

  it('keeps a trailing zero byte that is real slice data', () => {
    // A slice NAL may legitimately end in 0x00; with no following start code
    // the zero is data, not padding.
    const packet = Uint8Array.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00]);
    const nals = splitNals(packet);
    expect(nals).toHaveLength(1);
    expect(nals[0].data).toEqual(Uint8Array.from([0x65, 0x88, 0x84, 0x00]));
  });

  it('ignores leading zeros and padding before a following start code', () => {
    const packet = Uint8Array.from([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x65, 0xaa, 0xbb, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x01, 0x68, 0xcc,
    ]);
    const nals = splitNals(packet);
    expect(nals.map((n) => n.type)).toEqual([5, 8]);
    expect(nals[0].data).toEqual(Uint8Array.from([0x65, 0xaa, 0xbb]));
    expect(nals[1].data).toEqual(Uint8Array.from([0x68, 0xcc]));
  });

  it('returns an empty array for length-prefixed (non-Annex-B) payloads', () => {
    // No start codes present — e.g. a device whose csd is length-prefixed.
    const packet = Uint8Array.from([0x00, 0x09, 0x67, 0x42, 0xc0, 0x1f, 0x01, 0x02, 0x03, 0x04]);
    expect(splitNals(packet)).toHaveLength(0);
  });
});

describe('splitAccessUnits', () => {
  it('groups SPS + PPS + IDR into one access unit', () => {
    const packet = Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4([0x65, 0x88])]);
    const units = splitAccessUnits(packet);
    expect(units).toHaveLength(1);
    expect(units[0]).toEqual(Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4([0x65, 0x88])]));
  });

  it('splits two frames carried in one packet', () => {
    const packet = Uint8Array.from([
      ...sc4([0x65, 0x10, 0x20]), // IDR (frame 1)
      ...sc4([0x41, 0x30, 0x40]), // P slice (frame 2)
    ]);
    const units = splitAccessUnits(packet);
    expect(units).toHaveLength(2);
    expect(units[0]).toEqual(Uint8Array.from([...sc4([0x65, 0x10, 0x20])]));
    expect(units[1]).toEqual(Uint8Array.from([...sc4([0x41, 0x30, 0x40])]));
  });

  it('keeps non-VCL NALs attached to the following VCL NAL', () => {
    const packet = Uint8Array.from([
      ...sc4(SPS),
      ...sc4(PPS),
      ...sc4([0x65, 0xaa]),
      ...sc4([0x06, 0x00]), // SEI follows frame 1 → same unit
      ...sc4([0x41, 0xbb]),
    ]);
    const units = splitAccessUnits(packet);
    expect(units).toHaveLength(2);
    expect(units[1]).toEqual(Uint8Array.from([...sc4([0x41, 0xbb])]));
  });

  it('drops a pure config packet (no VCL NAL — decoding it could fail the decoder)', () => {
    const packet = Uint8Array.from([...sc4(SPS), ...sc4(PPS)]);
    expect(splitAccessUnits(packet)).toHaveLength(0);
  });
});

describe('annexbToAvcc', () => {
  it('replaces each start code with a 4-byte big-endian NAL length', () => {
    const unit = Uint8Array.from([...sc4(SPS), ...sc4(PPS)]);
    const avcc = annexbToAvcc(unit);
    expect(avcc).toHaveLength(4 + SPS.length + 4 + PPS.length);
    expect(Array.from(avcc.slice(0, 4))).toEqual([0, 0, 0, SPS.length]);
    expect(avcc.slice(4, 4 + SPS.length)).toEqual(SPS);
    const ppsAt = 4 + SPS.length;
    expect(Array.from(avcc.slice(ppsAt, ppsAt + 4))).toEqual([0, 0, 0, PPS.length]);
    expect(avcc.slice(ppsAt + 4)).toEqual(PPS);
  });

  it('never leaves a start code behind — the decoder would read it as a length', () => {
    const avcc = annexbToAvcc(Uint8Array.from([...sc4(SPS), ...sc4(PPS)]));
    // 00 00 00 01 at the head of a chunk is the exact failure this guards.
    expect(Array.from(avcc.slice(0, 4))).not.toEqual([0, 0, 0, 1]);
  });

  it('encodes lengths above 255 across all four bytes', () => {
    const big = Uint8Array.from([0x65, ...new Array(400).fill(0x11)]);
    const avcc = annexbToAvcc(Uint8Array.from([...sc4(big)]));
    expect(Array.from(avcc.slice(0, 4))).toEqual([0, 0, (401 >> 8) & 0xff, 401 & 0xff]);
    expect(avcc).toHaveLength(4 + 401);
  });

  it('returns an empty buffer when there is no start code at all', () => {
    expect(annexbToAvcc(Uint8Array.from([1, 2, 3]))).toHaveLength(0);
  });
});

describe('buildAvcC + h264CodecString', () => {
  it('builds a well-formed AVCDecoderConfigurationRecord', () => {
    const avcC = buildAvcC(SPS, PPS);
    expect(avcC[0]).toBe(1); // configurationVersion
    expect(avcC[1]).toBe(SPS[1]); // profile from SPS
    expect(avcC[2]).toBe(SPS[2]);
    expect(avcC[3]).toBe(SPS[3]);
    expect(avcC[4]).toBe(0xff); // lengthSizeMinusOne = 3
    expect(avcC[5]).toBe(0xe1); // one SPS
    expect((avcC[6] << 8) | avcC[7]).toBe(SPS.length);
    expect(avcC.slice(8, 8 + SPS.length)).toEqual(SPS);
    const ppsOffset = 8 + SPS.length;
    expect(avcC[ppsOffset]).toBe(1); // one PPS
    expect((avcC[ppsOffset + 1] << 8) | avcC[ppsOffset + 2]).toBe(PPS.length);
    expect(avcC.slice(ppsOffset + 3)).toEqual(PPS);
  });

  it('derives the codec string from SPS and from the avcC identically', () => {
    const avcC = buildAvcC(SPS, PPS);
    expect(h264CodecString(SPS)).toBe('avc1.42c01f');
    expect(h264CodecString(avcC)).toBe(h264CodecString(SPS));
  });
});

describe('base64ToBytes + annexbConcat + arraysEqual', () => {
  it('round-trips base64', () => {
    expect(base64ToBytes('SGVsbG8=')).toEqual(Uint8Array.from([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
  });

  it('concatenates NALs with 4-byte start codes', () => {
    const nals = splitNals(Uint8Array.from([...sc4(SPS), ...sc4(PPS)]));
    expect(annexbConcat(nals)).toEqual(Uint8Array.from([...sc4(SPS), ...sc4(PPS)]));
  });

  it('compares byte arrays', () => {
    expect(arraysEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 2]))).toBe(true);
    expect(arraysEqual(Uint8Array.from([1, 2]), Uint8Array.from([1, 3]))).toBe(false);
    expect(arraysEqual(Uint8Array.from([1]), Uint8Array.from([1, 2]))).toBe(false);
  });
});

describe('parseFrame', () => {
  // The whole point of the fused parser is that it is a drop-in for the three
  // separate passes it replaces, so most of these assert exactly that.
  const equivalentUnits = (packet: Uint8Array) =>
    splitAccessUnits(packet).map((unit) => annexbToAvcc(unit));

  it('returns the SPS and PPS the packet carried', () => {
    const packet = Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4([0x65, 0x88, 0x84])]);
    const { sps, pps } = parseFrame(packet);
    expect(sps).toEqual(SPS);
    expect(pps).toEqual(PPS);
  });

  it('leaves sps/pps undefined on a packet that carries neither', () => {
    const { sps, pps, units } = parseFrame(sc4([0x41, 0x9a, 0x02]));
    expect(sps).toBeUndefined();
    expect(pps).toBeUndefined();
    expect(units).toHaveLength(1);
  });

  it('emits AVCC units matching splitAccessUnits + annexbToAvcc', () => {
    const packet = Uint8Array.from([...sc4(SPS), ...sc4(PPS), ...sc4([0x65, 0x88, 0x84])]);
    expect(parseFrame(packet).units).toEqual(equivalentUnits(packet));
  });

  it('splits two frames carried in one packet, like the helpers do', () => {
    const packet = Uint8Array.from([...sc4([0x41, 0x11]), ...sc4([0x41, 0x22])]);
    const { units } = parseFrame(packet);
    expect(units).toHaveLength(2);
    expect(units).toEqual(equivalentUnits(packet));
  });

  it('drops a pure config packet — no VCL NAL means nothing decodable', () => {
    const packet = Uint8Array.from([...sc4(SPS), ...sc4(PPS)]);
    const { sps, pps, units } = parseFrame(packet);
    // The parameter sets still come back: they are what rebuilds the decoder.
    expect(sps).toEqual(SPS);
    expect(pps).toEqual(PPS);
    expect(units).toEqual([]);
  });

  it('returns nothing for a payload with no start code at all', () => {
    expect(parseFrame(Uint8Array.from([0x00, 0x00, 0x00, 0x09, 0x65]))).toEqual({ units: [] });
  });

  it('writes NAL lengths as 4-byte big-endian, with no start code left behind', () => {
    const big = new Uint8Array(300).fill(0x11);
    big[0] = 0x65;
    const { units } = parseFrame(sc4(big));
    expect(units).toHaveLength(1);
    const unit = units[0];
    expect(Array.from(unit.slice(0, 4))).toEqual([0x00, 0x00, 0x01, 0x2c]); // 300
    expect(unit.slice(4)).toEqual(big);
  });
});
