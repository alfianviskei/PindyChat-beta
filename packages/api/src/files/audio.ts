import fs from 'fs';
import { logger } from '@librechat/data-schemas';
import type {
  AudioProcessingResult,
  ServerRequest,
  AudioFileInfo,
  STTService,
  FileObject,
} from '~/types';
import { getBlockedUninspectableFileField, UninspectableFileError } from '~/protection/files';
import { getSafeErrorMetadata } from '~/utils';
import { formatDurationSeconds, measureAudioDurationSeconds } from './audioDuration';

/**
 * Default longest recording accepted for transcription, in seconds.
 *
 * Matches the cap Qwen's ASR models enforce. Providers reject an over-long
 * upload with a transport error rather than a structured one, so without a
 * local measurement the client can only report a bare 500; measuring first
 * turns it into a 400 that names the limit. Configure per provider with
 * `speech.stt.<provider>.maxDurationSeconds`; `0` disables the check.
 */
export const DEFAULT_STT_MAX_DURATION_SECONDS = 300;

/** Bytes of head read to locate a container's duration metadata. */
const DURATION_PROBE_BYTES = 256 * 1024;

/** The `[provider, schema, allowedAddresses]` tuple the STT service resolves. */
type ProviderSchema = Awaited<ReturnType<STTService['getProviderSchema']>>;

/**
 * An audio recording the configured speech provider cannot accept.
 *
 * Carries `userErrorStatusCode` so `api/server/routes/files/files.js:918-924`
 * answers 400 instead of 500: the upload is the caller's to fix, not a server
 * fault, and the message is written to be shown verbatim.
 */
export class AudioTranscriptionError extends Error {
  readonly userErrorStatusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AudioTranscriptionError';
  }
}

/**
 * Rejects a recording longer than the provider accepts, before paying for the
 * round trip that would fail anyway.
 *
 * Duration is read from the container header. When it cannot be determined the
 * check is skipped rather than guessed at — refusing an upload we could not
 * measure would strand formats this parser does not know, and the provider's
 * own rejection still produces a clear 400 through `AudioTranscriptionError`.
 *
 * @throws {AudioTranscriptionError} When the measured duration exceeds the cap.
 */
async function assertAudioWithinDurationLimit(
  filePath: string,
  fileSize: number,
  maxDurationSeconds: number | undefined,
): Promise<void> {
  const limit = maxDurationSeconds ?? DEFAULT_STT_MAX_DURATION_SECONDS;
  if (!(limit > 0)) {
    return;
  }

  let head: Buffer;
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      head = Buffer.alloc(Math.min(DURATION_PROBE_BYTES, fileSize));
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
  } catch (error) {
    logger.warn('[processAudioFile] Could not probe audio duration:', getSafeErrorMetadata(error));
    return;
  }

  const seconds = measureAudioDurationSeconds(head, fileSize);
  if (seconds == null || seconds <= limit) {
    return;
  }

  throw new AudioTranscriptionError(
    `This recording is ${formatDurationSeconds(seconds)} long, but transcription is limited to ${formatDurationSeconds(limit)}. Split it into shorter parts and upload them separately.`,
  );
}

/**
 * Processes audio files using Speech-to-Text (STT) service.
 *
 * Transcription is all-or-nothing: there is no fallback to another model or to
 * passing the raw audio to the chat model. A failure throws, so the upload is
 * reported rather than silently producing a conversation the model cannot hear.
 *
 * @returns A promise that resolves to an object containing text and bytes.
 * @throws {AudioTranscriptionError} When the recording is too long or the
 *   provider rejects it; surfaces to the client as HTTP 400.
 */
export async function processAudioFile({
  req,
  file,
  sttService,
}: {
  req: ServerRequest;
  file: FileObject;
  sttService: STTService;
}): Promise<AudioProcessingResult> {
  const uninspectableField = getBlockedUninspectableFileField(req.config?.filters, ['transcript']);

  let provider: ProviderSchema[0];
  let sttSchema: ProviderSchema[1];
  let allowedAddresses: ProviderSchema[2];
  try {
    [provider, sttSchema, allowedAddresses] = await sttService.getProviderSchema(req);
  } catch (error) {
    logger.error('Error resolving the speech-to-text provider:', getSafeErrorMetadata(error));
    if (uninspectableField != null) {
      throw new UninspectableFileError(uninspectableField);
    }
    throw new AudioTranscriptionError(
      `Audio transcription is not available: ${(error as Error).message || 'no speech provider is configured'}`,
    );
  }

  await assertAudioWithinDurationLimit(
    file.path,
    file.size,
    (sttSchema as { maxDurationSeconds?: number } | undefined)?.maxDurationSeconds,
  );

  let text: string;
  try {
    const audioBuffer = await fs.promises.readFile(file.path);
    const audioFile: AudioFileInfo = {
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    };

    text = await sttService.sttRequest(
      provider,
      sttSchema,
      { audioBuffer, audioFile },
      allowedAddresses,
    );
  } catch (error) {
    logger.error('Error processing audio file with STT:', getSafeErrorMetadata(error));
    if (uninspectableField != null) {
      throw new UninspectableFileError(uninspectableField);
    }
    // A provider rejection is the caller's to act on (unsupported format,
    // recording too long, expired key), so it is reported as 400 with the
    // provider's own reason rather than collapsed into a 500.
    throw new AudioTranscriptionError(
      `Audio transcription failed: ${(error as Error).message || 'the speech provider rejected the file'}`,
    );
  }

  if (text.trim().length === 0 && uninspectableField != null) {
    throw new UninspectableFileError(uninspectableField);
  }
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}
