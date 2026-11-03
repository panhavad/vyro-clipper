import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import type { SourceMeta } from '../core/types';

export function openInput(file: Blob): Input {
  return new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
}

export async function probeMedia(file: Blob): Promise<SourceMeta & { canDecodeVideo: boolean; canDecodeAudio: boolean }> {
  const input = openInput(file);
  try {
    const duration = await input.computeDuration();
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    let fps = 30;
    if (video) {
      try {
        const stats = await video.computePacketStats(120);
        if (stats.averagePacketRate > 1 && stats.averagePacketRate < 241) fps = stats.averagePacketRate;
      } catch {
        /* keep default */
      }
    }
    return {
      duration,
      width: video?.displayWidth ?? 0,
      height: video?.displayHeight ?? 0,
      fps,
      hasAudio: !!audio,
      hasVideo: !!video,
      videoCodec: video?.codec ?? null,
      audioCodec: audio?.codec ?? null,
      canDecodeVideo: video ? await video.canDecode() : false,
      canDecodeAudio: audio ? await audio.canDecode() : false,
    };
  } finally {
    input.dispose();
  }
}
