const FORMATS = Object.freeze({
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac"
});

export function detectAudioFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    return { extension: "wav", contentType: FORMATS.wav };
  }
  if (bytes.toString("ascii", 0, 4) === "fLaC") {
    return { extension: "flac", contentType: FORMATS.flac };
  }
  if (bytes.toString("ascii", 0, 4) === "OggS") {
    return { extension: "ogg", contentType: FORMATS.ogg };
  }
  if (bytes.toString("ascii", 0, 3) === "ID3" ||
      (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
    return { extension: "mp3", contentType: FORMATS.mp3 };
  }
  if (bytes.toString("ascii", 4, 8) === "ftyp") {
    return { extension: "m4a", contentType: FORMATS.m4a };
  }
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return { extension: "aac", contentType: FORMATS.aac };
  }
  return null;
}
