/**
 * Container-level audio duration measurement.
 *
 * Speech providers cap recording length (Qwen's ASR stops at five minutes) and
 * answer an over-long upload with a transport error, which the client can only
 * surface as a bare 500. Measuring the file before the request turns that into
 * a 400 that names the limit, and it costs one pass over a header rather than a
 * round trip.
 *
 * Nothing here shells out or pulls in a decoder: the containers LibreChat
 * accepts for transcription all carry their duration in a header, so it is read
 * directly. Formats whose duration is not recoverable this way return `null`,
 * and callers must treat `null` as "unknown, do not block" — refusing an upload
 * we could not measure would be worse than letting the provider decide.
 */

/** Largest header region scanned while looking for a container's metadata. */
const MAX_HEADER_SCAN_BYTES = 512 * 1024;

/** Upper bound on MP3 frame traversal, so a corrupt file cannot spin. */
const MAX_MP3_FRAMES = 400_000;

const MP3_BITRATES_V1_L3 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176];
const MP3_RATES_V1 = [44100, 48000, 32000];

function readUInt32BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

/** RIFF is little-endian, unlike every other container handled here. */
function readUInt32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

/** Reads a 32-bit synchsafe integer, as used by ID3v2 tag headers. */
function readSynchsafe(buffer: Buffer, offset: number): number {
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
}

/**
 * Duration of a RIFF/WAVE file, from the `data` chunk size divided by the
 * `fmt ` chunk's byte rate. Exact for PCM; for compressed WAVE payloads the
 * byte rate is still declared, so the result stays correct.
 */
function wavDuration(buffer: Buffer): number | null {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== 'RIFF') {
    return null;
  }
  if (buffer.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }

  let byteRate = 0;
  let offset = 12;
  const limit = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES);

  while (offset + 8 <= limit) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = readUInt32LE(buffer, offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 12 <= buffer.length) {
      // `fmt ` layout: audioFormat(2) channels(2) sampleRate(4) byteRate(4)
      byteRate = readUInt32LE(buffer, body + 8);
    } else if (id === 'data') {
      if (byteRate <= 0) {
        return null;
      }
      // A streaming recorder may write size 0 or 0xffffffff; fall back to the
      // bytes actually present after the chunk header.
      const declared = size === 0 || size === 0xffffffff ? buffer.length - body : size;
      return declared / byteRate;
    }

    // Chunks are word-aligned.
    offset = body + size + (size % 2);
    if (offset <= body) {
      return null;
    }
  }

  return null;
}

/**
 * Duration of an ISO-BMFF file (`.m4a`, `.mp4`), from `moov/mvhd`. Exact.
 */
function mp4Duration(buffer: Buffer): number | null {
  const limit = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES);
  let offset = 0;

  // Descend into container boxes until `mvhd` is found.
  for (let depth = 0; depth < 8 && offset + 8 <= limit; depth += 1) {
    let size = readUInt32BE(buffer, offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > limit) {
        return null;
      }
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize) {
      return null;
    }

    if (type === 'mvhd') {
      const body = offset + headerSize;
      if (body + 4 > buffer.length) {
        return null;
      }
      const version = buffer[body];
      if (version === 1) {
        if (body + 28 > buffer.length) {
          return null;
        }
        const timescale = readUInt32BE(buffer, body + 20);
        const duration = Number(buffer.readBigUInt64BE(body + 24));
        return timescale > 0 ? duration / timescale : null;
      }
      if (body + 20 > buffer.length) {
        return null;
      }
      const timescale = readUInt32BE(buffer, body + 12);
      const duration = readUInt32BE(buffer, body + 16);
      return timescale > 0 ? duration / timescale : null;
    }

    if (type === 'moov' || type === 'trak' || type === 'mdia' || type === 'udta') {
      offset += headerSize;
      continue;
    }

    offset += size;
  }

  return null;
}

/** Duration of a FLAC file, from STREAMINFO's total sample count. Exact. */
function flacDuration(buffer: Buffer): number | null {
  if (buffer.length < 4 || buffer.toString('latin1', 0, 4) !== 'fLaC') {
    return null;
  }

  let offset = 4;
  const limit = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES);

  while (offset + 4 <= limit) {
    const isLast = (buffer[offset] & 0x80) !== 0;
    const blockType = buffer[offset] & 0x7f;
    const blockLength =
      (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
    const body = offset + 4;

    if (blockType === 0) {
      if (body + 18 > buffer.length) {
        return null;
      }
      // Bytes 10..17 pack sampleRate(20) channels(3) bitsPerSample(5) totalSamples(36).
      const sampleRate =
        (buffer[body + 10] << 12) | (buffer[body + 11] << 4) | (buffer[body + 12] >> 4);
      const totalSamples =
        ((buffer[body + 13] & 0x0f) * 2 ** 32) + readUInt32BE(buffer, body + 14);
      return sampleRate > 0 ? totalSamples / sampleRate : null;
    }

    offset = body + blockLength;
    if (isLast || blockLength === 0) {
      return null;
    }
  }

  return null;
}

/**
 * Duration of an Ogg stream.
 *
 * The authoritative value is the granule position of the final page, which
 * needs a seek to the end of the file; only the head is in hand here, so this
 * falls back to the Vorbis identification header's nominal bitrate and the
 * payload size. Accurate to within a few percent for CBR and a reasonable
 * estimate for VBR — enough to reject a recording that is hours over the limit
 * without rejecting one that is marginally under.
 */
function oggDuration(buffer: Buffer, totalBytes: number): number | null {
  if (buffer.length < 4 || buffer.toString('latin1', 0, 4) !== 'OggS') {
    return null;
  }

  // Locate the first audio packet: page header, then the segment table.
  let offset = 0;
  const limit = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES);

  while (offset + 27 <= limit && buffer.toString('latin1', offset, offset + 4) === 'OggS') {
    const segmentCount = buffer[offset + 26];
    const tableStart = offset + 27;
    if (tableStart + segmentCount > buffer.length) {
      return null;
    }
    let payloadSize = 0;
    for (let i = 0; i < segmentCount; i += 1) {
      payloadSize += buffer[tableStart + i];
    }
    const payload = tableStart + segmentCount;

    // `\x01vorbis` marks the identification header.
    if (
      payload + 30 <= buffer.length &&
      buffer[payload] === 0x01 &&
      buffer.toString('latin1', payload + 1, payload + 7) === 'vorbis'
    ) {
      const bitrateNominal = buffer.readInt32LE(payload + 16);
      const bitrateUpper = buffer.readInt32LE(payload + 12);
      const bitrate = bitrateNominal > 0 ? bitrateNominal : bitrateUpper;
      if (bitrate <= 0) {
        return null;
      }
      return (totalBytes * 8) / bitrate;
    }

    offset = payload + payloadSize;
  }

  return null;
}

/**
 * Duration of an MPEG audio file (`.mp3`).
 *
 * Prefers an exact frame count from a Xing/Info/VBRI header; failing that,
 * divides the payload by the first frame's declared bitrate, which is exact for
 * CBR and close for headerless VBR.
 */
function mp3Duration(buffer: Buffer, totalBytes: number): number | null {
  let offset = 0;

  // Skip an ID3v2 tag if present.
  if (buffer.length >= 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    offset = 10 + readSynchsafe(buffer, 6);
  }

  const limit = Math.min(buffer.length, MAX_HEADER_SCAN_BYTES);

  // Find the first frame sync.
  while (offset + 4 <= limit) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) {
      break;
    }
    offset += 1;
  }
  if (offset + 4 > limit) {
    return null;
  }

  const b1 = buffer[offset + 1];
  const b2 = buffer[offset + 2];

  const versionBits = (b1 >> 3) & 0x03; // 00 = MPEG2.5, 10 = MPEG2, 11 = MPEG1
  const layerBits = (b1 >> 1) & 0x03; // 01 = Layer III
  if (layerBits !== 0x01) {
    // Layer I/II use different tables; not worth guessing.
    return null;
  }

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
    return null;
  }

  const isMpeg1 = versionBits === 0x03;
  const sampleRateBase = MP3_RATES_V1[rateIndex];
  const sampleRate = isMpeg1
    ? sampleRateBase
    : versionBits === 0x02
      ? sampleRateBase / 2
      : sampleRateBase / 4;
  const bitrateKbps = isMpeg1 ? MP3_BITRATES_V1_L3[bitrateIndex] : MP3_BITRATES_V2_L3[bitrateIndex];
  if (!sampleRate || !bitrateKbps) {
    return null;
  }

  const samplesPerFrame = isMpeg1 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  if (frameLength <= 4) {
    return null;
  }

  // Xing/Info (CBR/VBR header) or VBRI (Fraunhofer) carry the exact frame count.
  // The side-information block the tag follows is 32 bytes for MPEG1 stereo and
  // 17 for MPEG2, so both offsets are probed along with the two common variants.
  const sideInfoSize = isMpeg1 ? 32 : 17;
  const tagOffset = offset + 4 + sideInfoSize;
  for (const probe of [tagOffset, offset + 4 + 17, offset + 4 + 32, offset + 4 + 36]) {
    if (probe + 12 > buffer.length) {
      continue;
    }
    const tag = buffer.toString('latin1', probe, probe + 4);
    if (tag === 'Xing' || tag === 'Info') {
      const flags = readUInt32BE(buffer, probe + 4);
      if ((flags & 0x01) !== 0) {
        const frames = readUInt32BE(buffer, probe + 8);
        if (frames > 0) {
          return (frames * samplesPerFrame) / sampleRate;
        }
      }
    } else if (tag === 'VBRI' && probe + 26 <= buffer.length) {
      const frames = readUInt32BE(buffer, probe + 14);
      if (frames > 0) {
        return (frames * samplesPerFrame) / sampleRate;
      }
    }
  }

  // No VBR header: walk frames while they are consistent, then extrapolate from
  // the average frame size. Walking is bounded so a corrupt file cannot spin.
  let cursor = offset;
  let frames = 0;
  let bytes = 0;
  const walkLimit = Math.min(totalBytes, buffer.length);

  while (cursor + 4 <= walkLimit && frames < MAX_MP3_FRAMES) {
    if (buffer[cursor] !== 0xff || (buffer[cursor + 1] & 0xe0) !== 0xe0) {
      break;
    }
    const fb2 = buffer[cursor + 2];
    const fBitrateIndex = (fb2 >> 4) & 0x0f;
    const fRateIndex = (fb2 >> 2) & 0x03;
    const fPadding = (fb2 >> 1) & 0x01;
    if (fBitrateIndex === 0 || fBitrateIndex === 15 || fRateIndex === 3) {
      break;
    }
    const fBitrate = isMpeg1 ? MP3_BITRATES_V1_L3[fBitrateIndex] : MP3_BITRATES_V2_L3[fBitrateIndex];
    if (!fBitrate) {
      break;
    }
    const fLength =
      Math.floor((samplesPerFrame / 8) * ((fBitrate * 1000) / sampleRate)) + fPadding;
    if (fLength <= 4) {
      break;
    }
    cursor += fLength;
    frames += 1;
    bytes += fLength;
  }

  if (frames > 0 && bytes > 0) {
    const avgFrameBytes = bytes / frames;
    const totalFrames = (totalBytes - offset) / avgFrameBytes;
    return (totalFrames * samplesPerFrame) / sampleRate;
  }

  return ((totalBytes - offset) * 8) / (bitrateKbps * 1000);
}

/**
 * Measures an audio recording's duration in seconds from its container header.
 *
 * @param head - The leading bytes of the file. At least the first 64 KiB should
 *   be supplied; container metadata can sit behind an ID3 tag or a long `moov`.
 * @param totalBytes - The file's full size, needed to extrapolate for formats
 *   whose header describes a rate rather than a total.
 * @returns Duration in seconds, or `null` when the container is unrecognised or
 *   its duration is not recoverable from the bytes supplied. Callers must treat
 *   `null` as unknown rather than as zero.
 */
export function measureAudioDurationSeconds(head: Buffer, totalBytes: number): number | null {
  if (!Buffer.isBuffer(head) || head.length < 12 || totalBytes <= 0) {
    return null;
  }

  const magic = head.toString('latin1', 0, 4);

  if (magic === 'RIFF') {
    return wavDuration(head);
  }
  if (magic === 'fLaC') {
    return flacDuration(head);
  }
  if (magic === 'OggS') {
    return oggDuration(head, totalBytes);
  }
  // ISO-BMFF: `ftyp` at offset 4.
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    return mp4Duration(head);
  }
  if (head[0] === 0xff || head.toString('latin1', 0, 3) === 'ID3') {
    return mp3Duration(head, totalBytes);
  }

  return null;
}

/** Formats a duration as `m:ss`, for use in a user-facing limit message. */
export function formatDurationSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
