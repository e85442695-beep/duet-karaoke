const sectionLabel = /^\[(?:verse|chorus|refrain|bridge|intro|outro|куплет|приспів|вступ|програш|фінал)[^\]]*\]$/iu;

function lineKey(text) {
  return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function plainLines(plain) {
  if (typeof plain !== "string") return [];
  let section = false;
  const lines = [];
  for (const line of plain.split(/\r?\n/)) {
    const text = line.trim().slice(0, 280);
    if (!text || sectionLabel.test(text)) {
      section = lines.length > 0;
    } else {
      lines.push({ text, section });
      section = false;
      if (lines.length === 320) break;
    }
  }
  return lines;
}

function applyParts(lines) {
  const gaps = lines.slice(1).map((line, i) => line.start - lines[i].start).filter((gap) => gap > 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const hasSections = lines.some((line, i) => i > 0 && line.section);
  const inferred = gaps.map((gap, index) => index > 0 && gap >= Math.max(6, median * 1.8));
  const hasInferred = inferred.some(Boolean);
  const block = lines.length <= 4 ? Math.ceil(lines.length / 2) : 4;
  let part = "blue";
  let count = 0;
  return lines.map(({ section, ...line }, index) => {
    if (count && (section || (!hasSections && hasInferred && inferred[index - 1]) ||
      (!hasSections && !hasInferred && count >= block))) {
      part = part === "blue" ? "red" : "blue";
      count = 0;
    }
    count += 1;
    return { ...line, part };
  });
}

function timedLines(lrc, plain, duration) {
  if (typeof lrc !== "string") return [];
  const entries = new Map();
  const offset = Number(lrc.match(/^\[offset:([+-]?\d+)\]/im)?.[1] || 0) / 1000;
  let section = false;
  for (const line of lrc.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!timestamps.length) {
      if (!line.trim() || sectionLabel.test(line.trim())) section = true;
      continue;
    }
    const text = line.slice(timestamps.at(-1).index + timestamps.at(-1)[0].length).trim().slice(0, 280);
    for (const [, minutes, seconds, fraction] of timestamps) {
      const start = Math.max(0, 60 * Number(minutes) + Number(seconds) + Number("0." + (fraction || "0")) + offset);
      const visible = text && !sectionLabel.test(text);
      if (start < duration && (visible || !entries.has(start))) entries.set(start, { text: visible ? text : "", section });
      section = !visible;
    }
  }

  const timed = [...entries].sort(([a], [b]) => a - b).slice(0, 320);
  const plainKeys = plain.map(({ text }) => lineKey(text));
  let plainIndex = 0;
  let afterBreak = false;
  const lines = [];
  for (const [index, [start, entry]] of timed.entries()) {
    if (!entry.text) {
      afterBreak = true;
      continue;
    }
    const key = lineKey(entry.text);
    const match = plainKeys.slice(plainIndex, plainIndex + 4).indexOf(key);
    const plainSection = match >= 0 && plain[plainIndex + match].section;
    if (match >= 0) plainIndex += match + 1;
    const next = timed[index + 1]?.[0] ?? Math.min(duration, start + 6);
    lines.push({ text: entry.text, start, duration: Math.min(next - start, 12), section: entry.section || afterBreak || plainSection });
    afterBreak = false;
  }
  return applyParts(lines);
}

export function lyricReference(track, duration) {
  const plain = plainLines(track?.plainLyrics);
  const timed = timedLines(track?.syncedLyrics, plain, duration);
  if (timed.length) return { duration, lines: timed, timing: "timed" };
  const lines = applyParts(plain);
  return { duration, lines, timing: lines.length ? "estimated" : "none" };
}

function estimate(lines, duration) {
  const intro = Math.min(8, duration * 0.06);
  const outro = Math.min(5, duration * 0.03);
  const weights = lines.map(({ text }) => Math.sqrt(Math.max(1, lineKey(text).length)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const step = (duration - intro - outro) / total;
  let start = intro;
  return lines.map((line, i) => {
    const length = weights[i] * step;
    const cue = { ...line, start, duration: length };
    start += length;
    return cue;
  });
}

export function adaptLyrics(song, mediaDuration) {
  if (!song.timing || song.timing === "none") return { lines: song.lines, intro: song.intro, approximate: false };
  const duration = mediaDuration > 0 ? mediaDuration : song.duration;
  let reference = song;
  if (mediaDuration > 0) {
    for (const candidate of song.alternatives || []) {
      if (reference.timing !== "timed" ||
          Math.abs(candidate.duration - duration) + 0.25 < Math.abs(reference.duration - duration)) reference = candidate;
    }
  }
  const estimated = reference.timing === "estimated";
  const scale = Math.abs(reference.duration - duration) > 2 ? duration / reference.duration : 1;
  const lines = estimated ? estimate(reference.lines, duration) : reference.lines.map((line) => ({
    ...line, start: line.start * scale, duration: line.duration * scale,
  }));
  return { lines, intro: lines[0]?.start || 0, approximate: estimated || scale !== 1 };
}
