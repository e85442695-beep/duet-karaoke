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
    const key = [item.trackName, item.artistName, Math.round(item.duration / 5)].join("|").toLowerCase();
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

export function parseLyrics(lrc, shift, total) {
  if (typeof lrc !== "string") return [];
  const entries = new Map();
  const fileOffset = Number(lrc.match(/^\[offset:([+-]?\d+)\]/im)?.[1] || 0) / 1000;
  for (const line of lrc.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!timestamps.length) continue;
    const text = line.slice(timestamps.at(-1).index + timestamps.at(-1)[0].length).trim().slice(0, 280);
    for (const [, minutes, seconds, fraction] of timestamps) {
      const time = 60 * Number(minutes) + Number(seconds) + Number("0." + (fraction || "0")) + shift + fileOffset;
      if (time >= 0 && time < total) entries.set(time, text);
    }
  }

  const timed = [...entries].sort(([a], [b]) => a - b).slice(0, 320);
  let part = "blue";
  let count = 0;
  let previous = -1;
  const cues = [];
  for (const [index, [start, text]] of timed.entries()) {
    if (!text) continue;
    const gap = previous >= 0 && (start - timed[previous][0] > 10 || index > previous + 1);
    if (count >= 4 || (gap && count >= 2)) {
      part = part === "blue" ? "red" : "blue";
      count = 0;
    }
    const next = timed[index + 1]?.[0] ?? Math.min(total, start + 6);
    cues.push({ text, part, start, duration: Math.min(next - start, 12) });
    previous = index;
    count += 1;
  }
  return cues;
}

export function externalSong(track, backing, offset, query) {
  const duration = Number(track?.duration) > 0 ? Math.min(3600, Number(track.duration)) : 3600;
  return validateExternalSong({
    id: "external:" + crypto.randomUUID(),
    ...backing,
    title: track?.trackName || query.trim() || (backing.videoId ? "Караоке з YouTube" : "Мінусовка"),
    genre: track?.artistName || (backing.videoId ? "YouTube" : "Аудіо"),
    duration,
    lines: parseLyrics(track?.syncedLyrics, offset, duration),
  });
}

export function validateExternalSong(raw) {
  if (!raw || typeof raw.id !== "string" || !/^external:[a-f0-9-]{36}$/.test(raw.id) ||
      typeof raw.title !== "string" || !raw.title.trim() || typeof raw.genre !== "string" ||
      !Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > 3600 ||
      !Array.isArray(raw.lines) || raw.lines.length > 320) return null;
  const videoId = typeof raw.videoId === "string" && ID_PATTERN.test(raw.videoId) ? raw.videoId : null;
  const audioUrl = typeof raw.audioUrl === "string" && raw.audioUrl.length <= 500 ? backingAudioUrl(raw.audioUrl) : null;
  if (!videoId && !audioUrl) return null;
  let previous = -1;
  for (const cue of raw.lines) {
    if (!cue || typeof cue.text !== "string" || cue.text.length > 280 || !["blue", "red"].includes(cue.part) ||
        !Number.isFinite(cue.start) || cue.start < 0 || cue.start <= previous || cue.start >= raw.duration ||
        !Number.isFinite(cue.duration) || cue.duration <= 0 || cue.duration > 12) return null;
    previous = cue.start;
  }
  return {
    id: raw.id, ...(videoId ? { videoId } : { audioUrl }), title: raw.title.slice(0, 160), genre: raw.genre.slice(0, 120),
    intro: raw.lines[0]?.start ?? 0, duration: raw.duration, lines: raw.lines,
  };
}
