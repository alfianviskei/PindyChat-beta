import fs from 'fs';
import type { FileObject, ServerRequest, STTService } from '~/types';
import { UninspectableFileError } from '~/protection/files';
import { AudioTranscriptionError, processAudioFile } from './audio';

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: { ...actual.promises, readFile: jest.fn(), open: jest.fn() },
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));

describe('processAudioFile transcript inspection coverage', () => {
  const file = {
    path: '/tmp/audio.webm',
    originalname: 'audio.webm',
    mimetype: 'audio/webm',
    size: 5,
  };

  const createRequest = (uninspectable?: 'allow' | 'block') =>
    ({
      config: {
        filters: {
          files: {
            pii: {
              fields: ['transcript'],
              uninspectable,
            },
          },
        },
      },
    }) as ServerRequest;

  const createSttService = (sttRequest: STTService['sttRequest']): STTService => ({
    getInstance: jest.fn(),
    getProviderSchema: jest.fn().mockResolvedValue(['openai', {}]),
    sttRequest,
  });

  beforeEach(() => {
    (fs.promises.readFile as jest.Mock).mockResolvedValue(Buffer.from('audio'));
    // No real file backs these fixtures; the duration probe must fail open.
    (fs.promises.open as jest.Mock).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('threads the section-level allowedAddresses from getProviderSchema into sttRequest', async () => {
    const sttRequest = jest.fn().mockResolvedValue('transcribed');
    const schema = { url: 'http://stt.internal:8020' };
    const sttService: STTService = {
      getInstance: jest.fn(),
      getProviderSchema: jest.fn().mockResolvedValue(['openai', schema, ['stt.internal:8020']]),
      sttRequest,
    };
    const allowedAddressFile: FileObject = {
      path: '/tmp/a.wav',
      originalname: 'a.wav',
      mimetype: 'audio/wav',
      size: 5,
    };

    const result = await processAudioFile({
      req: {} as ServerRequest,
      file: allowedAddressFile,
      sttService,
    });

    expect(result.text).toBe('transcribed');
    expect(sttRequest).toHaveBeenCalledWith('openai', schema, expect.any(Object), [
      'stt.internal:8020',
    ]);
  });

  it('fails closed when strict transcript inspection cannot transcribe supported audio', async () => {
    const sttService = createSttService(jest.fn().mockRejectedValue(new Error('provider failed')));

    await expect(
      processAudioFile({ req: createRequest('block'), file, sttService }),
    ).rejects.toBeInstanceOf(UninspectableFileError);
  });

  it('fails closed when transcription produces no inspectable text', async () => {
    const sttService = createSttService(jest.fn().mockResolvedValue('   '));

    await expect(
      processAudioFile({ req: createRequest('block'), file, sttService }),
    ).rejects.toBeInstanceOf(UninspectableFileError);
  });

  it('returns a produced transcript for downstream inspection under strict policy', async () => {
    const sttService = createSttService(jest.fn().mockResolvedValue('inspectable transcript'));

    await expect(
      processAudioFile({ req: createRequest('block'), file, sttService }),
    ).resolves.toEqual({ text: 'inspectable transcript', bytes: 22 });
  });
});

describe('processAudioFile duration limit', () => {
  /** Builds a RIFF/WAVE header declaring `seconds` of 16-bit 44.1 kHz mono. */
  const wavHeader = (seconds: number) => {
    const byteRate = 44100 * 2;
    const dataSize = byteRate * seconds;
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(44100, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    return buf;
  };

  const audioFile = (size: number): FileObject => ({
    path: '/tmp/recording.wav',
    originalname: 'recording.wav',
    mimetype: 'audio/wav',
    size,
  });

  /** Stands in for the partial read the duration probe performs. */
  const mockProbe = (head: Buffer) => {
    (fs.promises.open as jest.Mock).mockResolvedValue({
      read: jest.fn().mockImplementation((buffer: Buffer) => {
        head.copy(buffer, 0, 0, Math.min(head.length, buffer.length));
        return Promise.resolve({ bytesRead: head.length });
      }),
      close: jest.fn().mockResolvedValue(undefined),
    });
  };

  const sttService = (schema: Record<string, unknown>, sttRequest = jest.fn()): STTService => ({
    getInstance: jest.fn(),
    getProviderSchema: jest.fn().mockResolvedValue(['openai', schema]),
    sttRequest: sttRequest.mockResolvedValue('transcribed'),
  });

  beforeEach(() => {
    (fs.promises.readFile as jest.Mock).mockResolvedValue(Buffer.from('audio'));
  });

  it('rejects a recording longer than the default five-minute cap before calling the provider', async () => {
    const sttRequest = jest.fn();
    mockProbe(wavHeader(360));

    const error = await processAudioFile({
      req: {} as ServerRequest,
      file: audioFile(44 + 88200 * 360),
      sttService: sttService({}, sttRequest),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AudioTranscriptionError);
    expect((error as Error).message).toContain('6:00');
    expect((error as Error).message).toContain('5:00');
    expect(error.userErrorStatusCode).toBe(400);
    expect(sttRequest).not.toHaveBeenCalled();
  });

  it('honours a provider-configured maxDurationSeconds', async () => {
    mockProbe(wavHeader(90));

    const error = await processAudioFile({
      req: {} as ServerRequest,
      file: audioFile(44 + 88200 * 90),
      sttService: sttService({ maxDurationSeconds: 60 }),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AudioTranscriptionError);
    expect((error as Error).message).toContain('1:00');
  });

  it('transcribes a recording within the cap', async () => {
    mockProbe(wavHeader(120));

    await expect(
      processAudioFile({
        req: {} as ServerRequest,
        file: audioFile(44 + 88200 * 120),
        sttService: sttService({}),
      }),
    ).resolves.toEqual({ text: 'transcribed', bytes: 12 });
  });

  it('skips the check when maxDurationSeconds is 0', async () => {
    mockProbe(wavHeader(3600));

    await expect(
      processAudioFile({
        req: {} as ServerRequest,
        file: audioFile(44 + 88200 * 3600),
        sttService: sttService({ maxDurationSeconds: 0 }),
      }),
    ).resolves.toEqual({ text: 'transcribed', bytes: 12 });
  });

  it('fails open when the duration cannot be measured', async () => {
    mockProbe(Buffer.alloc(64, 0x42));

    await expect(
      processAudioFile({
        req: {} as ServerRequest,
        file: audioFile(1024),
        sttService: sttService({}),
      }),
    ).resolves.toEqual({ text: 'transcribed', bytes: 12 });
  });

  it('reports a provider rejection as a 400 rather than a 500', async () => {
    (fs.promises.open as jest.Mock).mockRejectedValue(new Error('ENOENT'));

    const error = await processAudioFile({
      req: {} as ServerRequest,
      file: audioFile(1024),
      sttService: sttService({}, jest.fn().mockRejectedValue(new Error('audio too long'))),
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AudioTranscriptionError);
    expect((error as Error).message).toContain('audio too long');
    expect(error.userErrorStatusCode).toBe(400);
  });

  it('still fails closed on an uninspectable transcript under strict policy', async () => {
    (fs.promises.open as jest.Mock).mockRejectedValue(new Error('ENOENT'));
    const req = {
      config: { filters: { files: { pii: { fields: ['transcript'], uninspectable: 'block' } } } },
    } as ServerRequest;

    await expect(
      processAudioFile({
        req,
        file: audioFile(1024),
        sttService: sttService({}, jest.fn().mockRejectedValue(new Error('provider failed'))),
      }),
    ).rejects.toBeInstanceOf(UninspectableFileError);
  });
});
