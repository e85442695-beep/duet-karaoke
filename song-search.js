import { lyricReference } from "./lyrics.js";

const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export async function searchTracks(query, signal) {
  const url = new URL("https://lrclib.net/api/search");
  url.searchParams.set("q", query);
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Search unavailable");
  const results = await response.json();
  if (!Array.isArray(results)) throw new Error("Invalid search response");
  const tracks = new Map();
  for (const item of results) {
    if (!item || typeof item.trackName !== "string" || !item.trackName.trim() || item.instrumental) continue;
    const key = [item.trackName, item.artistName, Math.round(item.duration)].join("|").toLowerCase();
    if (!tracks.has(key) || (!tracks.get(key).syncedLyrics && item.syncedLyrics)) tracks.set(key, item);
  }
  return [...tracks.values()].slice(0, 15);
}

export function youtubeId(input) {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
    let id;
    if (host === "youtu.be") id = url.pathname.split("/")[1];
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      id = url.pathname === "/watch" ? url.searchParams.get("v") :
        url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)\/?$/)?.[1];
    }
    return ID_PATTERN.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

export function backingAudioUrl(input) {
  try {
    const url = new URL(input.trim());
    return url.protocol === "https:" && !url.username && !url.password &&
      /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(url.pathname) ? url.href : null;
  } catch {
    return null;
  }
}

function referenceDuration(track) {
  return Number(track?.duration) > 0 ? Math.min(3600, Number(track.duration)) : 3600;
}

function recordingAlternatives(track, tracks) {
  if (!track?.artistName) return [];
  const key = (value) => String(value || "").normalize("NFC").trim().toLowerCase();
  const title = key(track.trackName);
  const artist = key(track.artistName);
  return tracks.filter((candidate) => candidate !== track && candidate.syncedLyrics &&
      key(candidate.trackName) === title && key(candidate.artistName) === artist)
    .map((candidate) => lyricReference(candidate, referenceDuration(candidate)))
    .filter((candidate) => candidate.timing === "timed").slice(0, 2);
}

export function externalSong(track, backing, query, tracks = []) {
  return validateExternalSong({
    id: "external:" + crypto.randomUUID(),
    ...backing,
    title: track?.trackName || query.trim() || (backing.videoId ? "Караоке з YouTube" : "Мінусовка"),
    genre: track?.artistName || (backing.videoId ? "YouTube" : "Аудіо"),
    ...lyricReference(track, referenceDuration(track)),
    alternatives: recordingAlternatives(track, tracks),
  });
}

function validateReference(raw) {
  if (!raw ||
      !Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 3600 ||
      !Array.isArray(raw.lines) || raw.lines.length > 320) return null;
  const timing = raw.timing ?? (raw.lines.length ? "timed" : "none");
  if (!["timed", "estimated", "none"].includes(timing) || (timing === "none") !== (raw.lines.length === 0)) return null;
  let previous = -1;
  for (const cue of raw.lines) {
    if (!cue || typeof cue.text !== "string" || cue.text.length > 280 || !["blue", "red"].includes(cue.part)) return null;
    if (timing === "timed") {
      if (!Number.isFinite(cue.start) || cue.start < 0 || cue.start <= previous || cue.start >= raw.duration ||
          !Number.isFinite(cue.duration) || cue.duration <= 0 || cue.duration > 12) return null;
      previous = cue.start;
    }
  }
  return { duration: raw.duration, timing, lines: raw.lines, intro: raw.lines[0]?.start ?? 0 };
}

export function validateExternalSong(raw) {
  if (!raw || typeof raw.id !== "string" || !/^external:[a-f0-9-]{36}$/.test(raw.id) ||
      typeof raw.title !== "string" || !raw.title.trim() || typeof raw.genre !== "string") return null;
  const reference = validateReference(raw);
  if (!reference) return null;
  const videoId = typeof raw.videoId === "string" && ID_PATTERN.test(raw.videoId) ? raw.videoId : null;
  const audioUrl = typeof raw.audioUrl === "string" && raw.audioUrl.length <= 500 ? backingAudioUrl(raw.audioUrl) : null;
  if (!videoId && !audioUrl) return null;
  const alternatives = Array.isArray(raw.alternatives) ? raw.alternatives.slice(0, 2).map(validateReference)
    .filter((candidate) => candidate?.timing === "timed") : [];
  return {
    id: raw.id, ...(videoId ? { videoId } : { audioUrl }), title: raw.title.slice(0, 160), genre: raw.genre.slice(0, 120),
    ...reference, alternatives,
  };
}
