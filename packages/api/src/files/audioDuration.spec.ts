import { formatDurationSeconds, measureAudioDurationSeconds } from './audioDuration';

/** Builds a RIFF/WAVE buffer declaring `seconds` of PCM audio. */
function makeWav(seconds: number, sampleRate = 44100, channels = 1, bits = 16): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const dataSize = byteRate * seconds;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

/**
 * Builds an MPEG-1 Layer III buffer of `frames` constant-bitrate frames.
 * Header byte 3 is `0xc0`: bitrate index 12 (128 kbps), rate index 0 (44.1 kHz).
 */
function makeMp3(seconds: number, withXing = false): Buffer {
  const sampleRate = 44100;
  const frameLen = Math.floor((1152 / 8) * ((128 * 1000) / sampleRate));
  const frames = Math.round((seconds * sampleRate) / 1152);
  const buf = Buffer.alloc(frameLen * frames);
  for (let i = 0; i < frames; i += 1) {
    const o = i * frameLen;
    buf[o] = 0xff;
    buf[o + 1] = 0xfb;
    buf[o + 2] = 0xc0;
    buf[o + 3] = 0x00;
  }
  if (withXing) {
    const o = 4 + 32; // past the frame header and MPEG-1 stereo side information
    buf.write('Xing', o);
    buf.writeUInt32BE(0x01, o + 4);
    buf.writeUInt32BE(frames, o + 8);
  }
  return buf;
}

/** Builds an ISO-BMFF buffer carrying `moov/mvhd` with the given duration. */
function makeMp4(duration: number, timescale = 1000, version: 0 | 1 = 0): Buffer {
  const body = Buffer.alloc(version === 1 ? 112 : 100);
  body[0] = version;
  if (version === 1) {
    body.writeUInt32BE(timescale, 20);
    body.writeBigUInt64BE(BigInt(duration), 24);
  } else {
    body.writeUInt32BE(timescale, 12);
    body.writeUInt32BE(duration, 16);
  }
  const mvhd = Buffer.concat([
    Buffer.from([0, 0, 0, 8 + body.length]),
    Buffer.from('mvhd'),
    body,
  ]);
  const moov = Buffer.concat([
    Buffer.from([0, 0, 0, 8 + mvhd.length]),
    Buffer.from('moov'),
    mvhd,
  ]);
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 20]),
    Buffer.from('ftypM4A '),
    Buffer.alloc(8),
  ]);
  return Buffer.concat([ftyp, moov]);
}

describe('measureAudioDurationSeconds', () => {
  describe('WAVE', () => {
    it('reads the data chunk against the declared byte rate', () => {
      const buf = makeWav(10);
      expect(measureAudioDurationSeconds(buf, buf.length)).toBeCloseTo(10, 2);
    });

    it('accounts for channels and sample rate', () => {
      const buf = makeWav(360, 44100, 2);
      expect(measureAudioDurationSeconds(buf, buf.length)).toBeCloseTo(360, 2);
    });

    it('falls back to the bytes present when a recorder left the size unset', () => {
      const buf = makeWav(5);
      buf.writeUInt32LE(0, 40);
      expect(measureAudioDurationSeconds(buf, buf.length)).toBeCloseTo(5, 2);
    });
  });

  describe('MP3', () => {
    it('extrapolates from the frame walk for a headerless CBR file', () => {
      const buf = makeMp3(30);
      const duration = measureAudioDurationSeconds(buf, buf.length);
      expect(duration).not.toBeNull();
      expect(Math.abs((duration as number) - 30)).toBeLessThan(1.5);
    });

    it('prefers the exact Xing frame count', () => {
      const buf = makeMp3(600, true);
      const duration = measureAudioDurationSeconds(buf, buf.length);
      expect(duration).not.toBeNull();
      expect(Math.abs((duration as number) - 600)).toBeLessThan(5);
    });

    it('skips a leading ID3v2 tag', () => {
      const tag = Buffer.alloc(1000);
      tag.write('ID3', 0);
      tag[3] = 3;
      const size = 990;
      tag.writeUInt8((size >> 21) & 0x7f, 6);
      tag.writeUInt8((size >> 14) & 0x7f, 7);
      tag.writeUInt8((size >> 7) & 0x7f, 8);
      tag.writeUInt8(size & 0x7f, 9);
      const buf = Buffer.concat([tag, makeMp3(20)]);
      const duration = measureAudioDurationSeconds(buf, buf.length);
      expect(duration).not.toBeNull();
      expect(Math.abs((duration as number) - 20)).toBeLessThan(1.5);
    });
  });

  describe('ISO-BMFF', () => {
    it('reads moov/mvhd version 0', () => {
      expect(measureAudioDurationSeconds(makeMp4(45000), 200)).toBeCloseTo(45, 2);
    });

    it('reads moov/mvhd version 1', () => {
      expect(measureAudioDurationSeconds(makeMp4(48000 * 90, 48000, 1), 200)).toBeCloseTo(90, 2);
    });
  });

  describe('FLAC', () => {
    it('reads STREAMINFO total samples', () => {
      const sampleRate = 44100;
      const totalSamples = sampleRate * 120;
      const si = Buffer.alloc(34);
      si[10] = (sampleRate >> 12) & 0xff;
      si[11] = (sampleRate >> 4) & 0xff;
      si[12] = (sampleRate & 0x0f) << 4;
      si[13] = Math.floor(totalSamples / 2 ** 32) & 0x0f;
      si.writeUInt32BE(totalSamples >>> 0, 14);
      const buf = Buffer.concat([Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), si]);
      expect(measureAudioDurationSeconds(buf, buf.length)).toBeCloseTo(120, 2);
    });
  });

  describe('unmeasurable input', () => {
    it('returns null for an unrecognised container', () => {
      expect(measureAudioDurationSeconds(Buffer.alloc(1000, 0x42), 1000)).toBeNull();
    });

    it('returns null when the buffer is too short to hold a header', () => {
      expect(measureAudioDurationSeconds(Buffer.from('RIFF'), 4)).toBeNull();
    });

    it('returns null when the declared size is not positive', () => {
      expect(measureAudioDurationSeconds(makeWav(5), 0)).toBeNull();
    });

    it('does not throw on a corrupt frame sync', () => {
      const buf = Buffer.alloc(5000);
      buf[0] = 0xff;
      buf[1] = 0xfb;
      buf[2] = 0xff; // reserved bitrate and sample-rate indices
      expect(() => measureAudioDurationSeconds(buf, buf.length)).not.toThrow();
    });
  });
});

describe('formatDurationSeconds', () => {
  it('renders minutes and zero-padded seconds', () => {
    expect(formatDurationSeconds(300)).toBe('5:00');
    expect(formatDurationSeconds(65)).toBe('1:05');
    expect(formatDurationSeconds(0)).toBe('0:00');
  });

  it('clamps negative input', () => {
    expect(formatDurationSeconds(-30)).toBe('0:00');
  });
});
