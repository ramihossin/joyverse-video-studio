const SAMPLE_RATE = 22050;
const MAX_DURATION_SECONDS = 180;
const PROGRESSIONS = Object.freeze({
  cheerful: [
    [261.63, 329.63, 392.00],
    [349.23, 440.00, 523.25],
    [392.00, 493.88, 587.33],
    [261.63, 329.63, 392.00]
  ],
  adventure: [
    [220.00, 261.63, 329.63],
    [174.61, 220.00, 261.63],
    [261.63, 329.63, 392.00],
    [196.00, 246.94, 293.66]
  ],
  gentle: [
    [349.23, 440.00, 523.25],
    [293.66, 349.23, 440.00],
    [233.08, 293.66, 349.23],
    [261.63, 329.63, 392.00]
  ]
});

function writeWavHeader(buffer, dataBytes, sampleRate) {
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
}

export function createProceduralMusicWav({
  durationSeconds,
  style = "cheerful",
  sampleRate = SAMPLE_RATE
} = {}) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) ||
      durationSeconds < 1 || durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error("Music duration must be from 1 to 180 seconds.");
  }
  if (!Object.hasOwn(PROGRESSIONS, style)) {
    throw new Error("Music style must be cheerful, adventure, or gentle.");
  }
  if (![16000, 22050, 44100].includes(sampleRate)) {
    throw new Error("Music sample rate must be 16000, 22050, or 44100 Hz.");
  }

  const frames = Math.ceil(durationSeconds * sampleRate);
  const dataBytes = frames * 4;
  const output = Buffer.alloc(44 + dataBytes);
  writeWavHeader(output, dataBytes, sampleRate);
  const progression = PROGRESSIONS[style];
  const barSeconds = 2;
  const beatSeconds = 0.5;

  for (let i = 0; i < frames; i++) {
    const time = i / sampleRate;
    const bar = Math.floor(time / barSeconds) % progression.length;
    const chord = progression[bar];
    let sample = 0;

    for (const frequency of chord) {
      sample += 0.014 * Math.sin(2 * Math.PI * frequency * time);
      sample += 0.003 * Math.sin(4 * Math.PI * frequency * time);
    }
    sample += 0.012 * Math.sin(2 * Math.PI * (chord[0] / 2) * time);

    const beat = Math.floor(time / beatSeconds);
    const beatStart = beat * beatSeconds;
    const beatOffset = time - beatStart;
    const pluckFrequency = chord[beat % chord.length];
    const pluckEnvelope = Math.exp(-beatOffset * 5.5) * (1 - Math.exp(-beatOffset * 55));
    sample += 0.12 * pluckEnvelope * Math.sin(2 * Math.PI * pluckFrequency * beatOffset);

    if (beat % 4 === 0) {
      const kickEnvelope = Math.exp(-beatOffset * 18);
      sample += 0.035 * kickEnvelope * Math.sin(2 * Math.PI * (78 - beatOffset * 22) * beatOffset);
    }

    if (beat % 4 === 2) {
      const sparkleEnvelope = Math.exp(-beatOffset * 7) * (1 - Math.exp(-beatOffset * 70));
      sample += 0.045 * sparkleEnvelope * Math.sin(2 * Math.PI * chord[2] * 2 * beatOffset);
    }

    const fadeIn = Math.min(1, time / 0.15);
    const fadeOut = Math.min(1, Math.max(0, (durationSeconds - time) / 0.3));
    const value = Math.max(-0.85, Math.min(0.85, sample * fadeIn * fadeOut));
    const pcm = Math.round(value * 32767);
    const offset = 44 + i * 4;
    output.writeInt16LE(pcm, offset);
    output.writeInt16LE(pcm, offset + 2);
  }
  return output;
}
