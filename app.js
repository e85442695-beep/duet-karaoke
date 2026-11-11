import { songs } from "./songs.js";
import { DuetAudio } from "./audio.js";
import { clock, DuetConnection } from "./connection.js";
import { backingAudioUrl, externalSong, searchTracks, validateExternalSong, youtubeId } from "./song-search.js";
import { VideoTrack } from "./video.js";
import { adaptLyrics } from "./lyrics.js";

const $ = (id) => document.getElementById(id);
const audio = new DuetAudio();
const video = new VideoTrack($("video-stage"), onVideo);
const invite = new URLSearchParams(location.hash.slice(1));
const roomId = invite.get("room") || "";
const inviteKey = invite.get("key") || "";
const hasInvite = invite.has("room") || invite.has("key");
const validInvite = /^duet-[a-f0-9]{24}$/.test(roomId) && /^[a-f0-9]{32}$/.test(inviteKey);
const host = !hasInvite;
const ownPart = host ? "blue" : "red";
const otherPart = host ? "red" : "blue";
const blankSeat = () => ({ mic: false, muted: false, ready: false });
const state = { song: songs[0], active: false, joined: false, voice: false, me: blankSeat(), other: blankSeat() };
let room;
let connection;
let stream;
let clockSample;
let clockTimer;
let remotePlayback;
let playback;
let finished = false;
let frame = 0;
let lastLyrics = "";
let micPending = false;
let readyPending = false;
let lastVideoSync = 0;
let searchRequest;
let selectedTrack;
let trackResults = [];
let lyricTimeline;
let lyricOffset = 0;
let lyricStart = null;
const music = () => state.song.videoId ? video : audio;
const songDuration = () => {
  if (state.song.videoId) return video.duration;
  return state.song.audioUrl ? audio.duration(state.song) : state.song.duration;
};

function id(length) {
  return [...crypto.getRandomValues(new Uint8Array(length))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function duration(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

function message(text) { $("room-status").textContent = text; }

function seat(part, value, own) {
  const present = own || state.joined;
  const name = own ? "Ти" : "Друг";
  let detail = "Вільне місце";
  if (present) {
    detail = name + " · " + (value.muted ? "мікрофон вимкнено" : value.ready ? "готовий" : value.mic ? "мікрофон увімкнено" : "мікрофон вимкнено");
  }
  $(part + "-seat").querySelector("small").textContent = detail;
}

function canStart() {
  return host && state.joined && state.voice && state.me.ready && state.other.ready && music().ready;
}

function render() {
  $("landing").hidden = state.active;
  $("room").hidden = !state.active;
  $("leave").hidden = !state.active;
  $("catalog-link").hidden = state.active;
  $("host-actions").hidden = !host;
  $("search-tools").hidden = !host;
  $("occupancy").textContent = state.joined ? "2 / 2" : "1 / 2";
  seat(ownPart, state.me, true);
  seat(otherPart, state.other, false);
  $("stage-title").textContent = state.song.title;
  $("mic").textContent = state.me.mic && !state.me.muted ? "Вимкнути мікрофон" : "Увімкнути мікрофон";
  $("mic").disabled = micPending;
  $("mic").setAttribute("aria-pressed", state.me.mic && !state.me.muted);
  $("ready").textContent = state.me.ready ? "Скасувати готовність" : readyPending ? "Завантажуємо…" : "Готовий";
  $("ready").setAttribute("aria-pressed", state.me.ready);
  $("ready").disabled = readyPending || !!playback || !state.voice || !state.me.mic ||
    (!state.me.ready && state.me.muted) || (!host && !clockSample);
  $("start").hidden = !host;
  $("start").disabled = !canStart();
  $("start").textContent = playback || finished ? "Почати спочатку" : "Почати співати";
  $("stop").hidden = !host || !playback;
  renderSync();
  for (const button of $("song-list").children) {
    const selected = button.dataset.song === state.song.id;
    button.setAttribute("aria-pressed", selected);
    button.disabled = state.active && !host;
    button.querySelector(".song-action").textContent = selected ? "✓" : "↗";
  }
  renderLyrics();
}

function renderLyrics() {
  const song = state.song;
  const position = music().position;
  const total = songDuration();
  const mediaDuration = Math.round(total * 10) / 10;
  if (lyricTimeline?.song !== song || lyricTimeline.mediaDuration !== mediaDuration || lyricTimeline.start !== lyricStart) {
    lyricTimeline = { song, mediaDuration, start: lyricStart, ...adaptLyrics(song, mediaDuration, lyricStart) };
    $("timing-note").hidden = !lyricTimeline.approximate;
    $("timing-note").textContent = lyricTimeline.waiting ?
      "У цієї пісні немає таймкодів. Натисни «Почали співати перший рядок», коли почнеться спів." : "Орієнтовний таймінг тексту";
  }
  const { lines, intro } = lyricTimeline;
  const at = position === null ? null : position - lyricOffset;
  const first = lines[0];
  const firstText = first?.text || (song.videoId ? "Текст у відео" : "Текст із таймкодами відсутній");
  let part = first?.part || "blue";
  let label = "До початку";
  let line = firstText;
  let next = lines[1]?.text || "";
  if (position !== null && position < 0) {
    label = "Починаємо за";
    line = String(Math.max(1, Math.ceil(-position)));
    next = first ? "Перший рядок · " + firstText : "";
  } else if (position !== null && lyricTimeline.waiting && !finished) {
    label = "Вступ";
    line = "Чекаємо на перший рядок";
    next = "Натисни «Почали співати перший рядок» · " + firstText;
  } else if (position !== null && at < intro) {
    label = "Вступ";
    line = "Приготуйся співати";
    next = "Перший рядок · " + firstText;
  } else if (position !== null) {
    const index = lines.findIndex((cue) => at >= cue.start && at < cue.start + cue.duration);
    if (index >= 0) {
      const cue = lines[index];
      const upcoming = lines[index + 1];
      part = cue.part;
      label = (part === ownPart ? "Твоя партія" : "Партія друга") + (part === "blue" ? " · синя" : " · червона");
      line = cue.text;
      next = upcoming ? "Далі · " + upcoming.text : "Останній рядок";
    } else if (song.videoId || song.audioUrl) {
      const upcoming = lines.find((cue) => cue.start > at);
      label = song.videoId && !video.playing ? "Відео запускається" : "Караоке";
      line = first ? "Музична пауза" : song.videoId ? "Співайте за текстом у відео" : "Грає мінусовка";
      next = upcoming ? "Далі · " + upcoming.text : "";
    } else {
      label = "Фінал";
      line = "Останні такти";
      next = "";
    }
  } else if (finished) {
    label = "Пісня завершилась";
    line = "Дякуємо за дует!";
    next = host ? "Можна повторити або обрати іншу пісню." : "Ведучий може почати знову або обрати іншу пісню.";
  } else if (first) {
    next = (host ? "Ви починаєте синьою партією" : "Друг починає синьою партією") + " · " + next;
  } else if (song.videoId) {
    next = "Караоке відкриється під текстом.";
  }
  const lyrics = [part, label, line, next].join("\n");
  if (lyrics !== lastLyrics) {
    $("lyric-stage").dataset.part = part;
    $("part-label").textContent = label;
    $("current-line").textContent = line;
    $("next-line").textContent = next;
    lastLyrics = lyrics;
  }
  const elapsed = finished ? total : Math.min(total, Math.max(0, position ?? 0));
  $("stage-time").textContent = duration(elapsed) + " / " + (total ? duration(total) : "—");
  $("progress").max = total || 1;
  $("progress").value = elapsed;
}

function syncable() {
  return state.active && !!(state.song.videoId || state.song.audioUrl) && state.song.timing !== "none" && state.song.lines.length > 0;
}

function renderSync() {
  $("lyric-sync").hidden = !syncable();
  const tenths = Math.round(lyricOffset * 10) / 10;
  $("sync-value").textContent = (tenths > 0 ? "+" : tenths < 0 ? "−" : "") + Math.abs(tenths).toFixed(1) + " с";
  $("sync-reset").hidden = tenths === 0 && lyricStart === null;
  $("sync-first").hidden = !playback;
}

function sendOffset() {
  connection?.send({ type: "offset", song: state.song.id, value: lyricOffset, start: lyricStart });
}

function setOffset(value, send = true, start = lyricStart) {
  lyricOffset = Math.max(-60, Math.min(60, Math.round(value * 10) / 10));
  lyricStart = Number.isFinite(start) && start >= 0 ? Math.round(start * 10) / 10 : null;
  lastLyrics = "";
  if (send) sendOffset();
  renderSync();
  renderLyrics();
}

$("sync-earlier").onclick = () => setOffset(lyricOffset - 0.5);
$("sync-later").onclick = () => setOffset(lyricOffset + 0.5);
$("sync-reset").onclick = () => setOffset(0, true, null);
$("sync-first").onclick = () => {
  const position = music().position;
  const first = lyricTimeline?.lines[0];
  if (position === null || position < 0 || !first) return;
  if (lyricTimeline.estimated) setOffset(0, true, position);
  else setOffset(position - first.start);
};

function tick() {
  if (!playback) return;
  if (state.song.videoId ? video.ended : audio.position >= songDuration()) {
    endPlayback(true);
    message("Пісня завершилась.");
    return;
  }
  if (host && state.song.videoId && video.playing && clock() - lastVideoSync > 3500) {
    lastVideoSync = clock();
    connection.send({ type: "video-position", at: lastVideoSync, position: video.position, playback });
  }
  renderLyrics();
  frame = requestAnimationFrame(tick);
}

function endPlayback(completed = false) {
  cancelAnimationFrame(frame);
  audio.stop();
  video.stop();
  $("video-resume").hidden = true;
  playback = null;
  finished = completed;
  render();
}

function schedule(startAt) {
  try {
    const delay = (startAt - clock() - (host ? 0 : clockSample.offset)) / 1000;
    if (delay < -1 || delay > 8) throw new Error("Clock unavailable");
    music().play(delay);
    finished = false;
    playback = startAt;
    message("");
    cancelAnimationFrame(frame);
    render();
    frame = requestAnimationFrame(tick);
    return true;
  } catch {
    endPlayback();
    message("Не вдалося запустити звук. Натисни «Готовий» і спробуй ще раз.");
    state.me.ready = false;
    sendSeat();
    render();
    return false;
  }
}

function sendSeat() { connection?.send({ type: "seat", song: state.song.id, ...state.me }); }

function changeSong(song, sync = false) {
  if (song.id === state.song.id) return;
  endPlayback();
  video.clear();
  state.song = song;
  lyricOffset = 0;
  lyricStart = null;
  state.me.ready = false;
  state.other.ready = false;
  if (sync) sendSong();
  if (state.active) {
    sendSeat();
    if (state.voice) message("Пісню змінено. Підтвердьте готовність.");
  }
  if (state.active && song.videoId) prepareVideo();
  render();
}

function sendSong() {
  const song = state.song;
  connection?.send(song.videoId || song.audioUrl ? { type: "song", external: song } : { type: "song", id: song.id });
}

function prepareVideo() {
  const song = state.song;
  return video.load(song.videoId).then(render).catch(() => {
    if (state.active && song === state.song) onVideo("error");
  });
}

function onVideo(event) {
  if (event === "blocked") {
    $("video-resume").hidden = false;
    message("Натисни «Увімкнути відео», щоб приєднатися до відтворення.");
  } else if (event === "playing") {
    $("video-resume").hidden = true;
    message("");
  } else if (event === "error") {
    const wasPlaying = !!playback;
    endPlayback();
    state.me.ready = false;
    sendSeat();
    if (wasPlaying) connection?.send({ type: host ? "stop" : "start-failed" });
    message(host ? "Це відео не відтворюється тут. Спробуй інше посилання." : "Це відео не відтворюється тут. Попроси ведучого змінити посилання.");
    render();
  } else {
    renderLyrics();
  }
}

function updateVolumes() {
  audio.volume($("music-volume").valueAsNumber / 100, $("voice-volume").valueAsNumber / 100);
  video.setVolume($("music-volume").valueAsNumber);
}

function syncClock() {
  if (!host && state.joined) connection?.send({ type: "ping", sent: clock() });
}

function onMessage(data) {
  if (!state.joined) return;
  switch (data.type) {
    case "seat":
      state.other = { mic: data.mic === true, muted: data.muted === true, ready: data.song === state.song.id && data.ready === true };
      if (host && state.other.mic && state.me.mic) connection.call();
      render();
      break;
    case "song": {
      const song = songs.find(({ id }) => id === data.id) || validateExternalSong(data.external);
      if (!host && song) changeSong(song);
      break;
    }
    case "offset":
      if (data.song === state.song.id && Number.isFinite(data.value)) setOffset(data.value, false, data.start);
      break;
    case "ping":
      if (host && Number.isFinite(data.sent)) connection.send({ type: "pong", sent: data.sent, hostAt: clock() });
      break;
    case "pong": {
      if (host || !Number.isFinite(data.sent) || !Number.isFinite(data.hostAt)) break;
      const now = clock();
      const roundTrip = now - data.sent;
      if (roundTrip >= 0 && roundTrip < 3500 &&
          (!clockSample || roundTrip < clockSample.roundTrip || now - clockSample.at > 25000)) {
        clockSample = { offset: data.hostAt - (data.sent + now) / 2, roundTrip, at: now };
        render();
      }
      break;
    }
    case "start":
      if (!host && clockSample && state.me.ready && data.song === state.song.id && Number.isFinite(data.at)) {
        if (!schedule(data.at)) connection.send({ type: "start-failed" });
      } else if (!host) {
        connection.send({ type: "start-failed" });
      }
      break;
    case "start-failed":
      if (host) {
        endPlayback();
        message("Другу не вдалося запустити звук. Попроси його підтвердити готовність.");
      }
      break;
    case "stop":
      if (!host) {
        endPlayback();
        message("Ведучий зупинив пісню.");
      }
      break;
    case "video-position":
      if (!host && playback && data.playback === playback && state.song.videoId && clockSample &&
          Number.isFinite(data.at) && Number.isFinite(data.position)) {
        const elapsed = (clock() + clockSample.offset - data.at) / 1000;
        if (elapsed >= 0 && elapsed < 3) video.align(data.position + elapsed);
      }
      break;
  }
}

function resetPartner() {
  state.joined = false;
  state.voice = false;
  state.other = blankSeat();
  state.me.ready = false;
  clockSample = undefined;
  clearInterval(clockTimer);
  audio.partner(null);
  if (remotePlayback) {
    remotePlayback.pause();
    remotePlayback.srcObject = null;
    remotePlayback = null;
  }
  $("unlock").hidden = true;
  endPlayback();
}

function onConnection(event, remote) {
  const messages = {
    unavailable: "Кімната вже закрита або ведучий ще підключається.",
    full: "У кімнаті вже двоє учасників.",
    lost: host ? "Друг від’єднався. Він може зайти за тим самим посиланням." : "Зв’язок обірвався. Спробуй підключитися знову або зміни мережу.",
    "voice-failed": host ? "Зв’язок із другом перервано. Він може зайти за тим самим посиланням." : "Голосовий зв’язок перервано. Спробуй підключитися знову або зміни мережу.",
    "signaling-failed": "Не вдалося підключитися до сервісу кімнат. Спробуй ще раз або зміни мережу.",
  };
  if (event === "joined") {
    state.joined = true;
    $("retry").hidden = true;
    message("Обидва в кімнаті. Увімкніть мікрофони.");
    if (host) {
      sendSong();
      if (lyricOffset || lyricStart !== null) sendOffset();
    } else {
      syncClock();
      setTimeout(syncClock, 250);
      setTimeout(syncClock, 750);
      clockTimer = setInterval(syncClock, 4000);
    }
    sendSeat();
  } else if (event === "voice") {
    state.voice = true;
    remotePlayback = new Audio();
    remotePlayback.muted = true;
    remotePlayback.srcObject = remote;
    audio.partner(remote);
    remotePlayback.play().catch(() => { if (state.voice) $("unlock").hidden = false; });
    message("Голосовий зв’язок працює. Коли будеш готовий, натисни «Готовий».");
  } else if (event === "waiting") {
    message("Запроси друга за посиланням.");
  } else if (event === "signaling") {
    message("Відновлюємо зв’язок із сервісом кімнат…");
  } else {
    resetPartner();
    message(messages[event] || "Не вдалося підключитися. Спробуй іншу мережу.");
    $("retry").hidden = host && event !== "signaling-failed";
  }
  render();
}

function openConnection() {
  connection?.close();
  $("retry").hidden = true;
  message(host ? "Створюємо кімнату…" : "Підключаємося до кімнати…");
  connection = new DuetConnection(room, host, onConnection, onMessage);
  connection.setStream(stream);
  try {
    connection.connect();
  } catch {
    onConnection("signaling-failed");
  }
}

$("enter").onclick = () => {
  room = host ? { id: "duet-" + id(12), key: id(16) } : { id: roomId, key: inviteKey };
  state.active = true;
  $("catalog-status").textContent = "";
  openConnection();
  if (state.song.videoId) prepareVideo();
  render();
  $("room-title").focus();
};

$("copy").onclick = async () => {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ room: room.id, key: room.key });
  try {
    await navigator.clipboard.writeText(url.href);
    message("Запрошення скопійовано.");
  } catch {
    window.prompt("Скопіюй посилання на кімнату", url.href);
  }
};

$("mic").onclick = async () => {
  if (stream) {
    state.me.muted = !state.me.muted;
    stream.getAudioTracks().forEach((track) => { track.enabled = !state.me.muted; });
    sendSeat();
    render();
    return;
  }
  const currentRoom = room;
  micPending = true;
  render();
  try {
    await audio.unlock();
    updateVolumes();
    const capture = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    if (!state.active || room !== currentRoom) {
      capture.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = capture;
    state.me.mic = true;
    connection.setStream(stream);
    stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
      if (stream !== capture) return;
      stream = undefined;
      state.me = blankSeat();
      resetPartner();
      openConnection();
      message("Мікрофон від’єднався. Підключи його знову.");
    }));
    sendSeat();
    if (host && state.other.mic) connection.call();
    if (!state.voice) message(state.joined ? "Чекаємо на мікрофон друга." : "Мікрофон увімкнено. Надішли другу запрошення.");
  } catch (error) {
    if (!state.active || room !== currentRoom) return;
    const errors = {
      NotAllowedError: "Дозволь доступ до мікрофона в налаштуваннях браузера й спробуй ще раз.",
      NotFoundError: "Мікрофон не знайдено. Підключи його й спробуй ще раз.",
      NotReadableError: "Не вдалося відкрити мікрофон. Перевір, чи його не використовує інша програма.",
    };
    message(errors[error.name] || "Не вдалося увімкнути звук. Перевір доступ до мікрофона.");
  } finally {
    micPending = false;
    render();
  }
};

$("ready").onclick = async () => {
  if (state.me.ready) {
    state.me.ready = false;
    sendSeat();
    render();
    return;
  }
  const selected = state.song;
  const currentConnection = connection;
  readyPending = true;
  render();
  try {
    await audio.unlock();
    if (selected.videoId) await video.load(selected.videoId);
    else await audio.load(selected);
    if (!state.active || !state.voice || connection !== currentConnection || selected !== state.song) return;
    state.me.ready = true;
    sendSeat();
    message(host ? "Коли друг буде готовий, можна починати." : "Ти готовий. Ведучий запустить пісню.");
  } catch {
    if (state.active && selected === state.song) {
      message(selected.videoId ? "Не вдалося завантажити відео. Перевір посилання або спробуй інше." :
        "Не вдалося завантажити фонограму. Натисни «Готовий» ще раз.");
    }
  } finally {
    readyPending = false;
    render();
  }
};

$("start").onclick = () => {
  if (!canStart()) return;
  const at = clock() + 3500;
  if (schedule(at)) connection.send({ type: "start", song: state.song.id, at });
};

$("stop").onclick = () => {
  connection.send({ type: "stop" });
  endPlayback();
  message("Пісню зупинено.");
};

$("retry").onclick = () => openConnection();
$("video-resume").onclick = () => video.resume();
$("unlock").onclick = async () => {
  try {
    await Promise.all([audio.unlock(), remotePlayback?.play()]);
    $("unlock").hidden = true;
  } catch { message("Звук заблоковано. Перевір налаштування відтворення в браузері."); }
};

function leave() {
  connection?.close();
  resetPartner();
  video.clear();
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  state.me = blankSeat();
  state.active = false;
}

$("leave").onclick = () => {
  leave();
  if (!host) location.assign("./");
  else {
    render();
    $("enter").focus();
  }
};

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  leave();
});
$("music-volume").oninput = updateVolumes;
$("voice-volume").oninput = updateVolumes;

function openVideoForm(track) {
  selectedTrack = track;
  const terms = track ? [track.artistName, track.trackName].filter(Boolean).join(" ") : $("search-query").value.trim();
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", [terms, "karaoke instrumental"].filter(Boolean).join(" "));
  $("find-backing").href = url.href;
  $("video-title").textContent = track ? track.trackName : "Додати караоке";
  $("video-url").value = "";
  $("video-status").textContent = "";
  $("sync-hint").textContent = track?.syncedLyrics ? "Сайт підлаштує рядки під тривалість мінусовки." :
    track?.plainLyrics ? "Час появи рядків буде орієнтовним." : "";
  $("video-form").hidden = false;
  $("video-url").focus();
}

$("open-video-form").onclick = () => openVideoForm();
$("song-search").onsubmit = async (event) => {
  event.preventDefault();
  const query = $("search-query").value.trim();
  if (query.length < 2) {
    $("search-status").textContent = "Введи хоча б дві літери.";
    return;
  }
  if (youtubeId(query) || backingAudioUrl(query)) {
    openVideoForm();
    $("video-url").value = query;
    return;
  }
  searchRequest?.abort();
  const request = new AbortController();
  searchRequest = request;
  const timer = setTimeout(() => request.abort(), 10000);
  $("search-results").replaceChildren();
  $("search-status").textContent = "Шукаємо пісні…";
  $("video-form").hidden = true;
  try {
    const tracks = await searchTracks(query, request.signal);
    if (request !== searchRequest) return;
    trackResults = tracks;
    $("search-status").textContent = tracks.length ? "Обери потрібну версію пісні." :
      "Пісень не знайдено. Спробуй іншу назву або додай посилання на караоке.";
    for (const track of tracks) {
      const button = songButton({
        title: track.trackName, genre: [track.artistName, track.syncedLyrics ? "Текст з таймкодами" :
          track.plainLyrics ? "Текст без таймкодів" : ""].filter(Boolean).join(" · "),
        duration: track.duration, icon: "♪", color: track.syncedLyrics ? "#a7baff" : "#ffcb9d",
      });
      button.onclick = () => openVideoForm(track);
      $("search-results").append(button);
    }
  } catch {
    if (request === searchRequest) $("search-status").textContent = "Пошук тимчасово недоступний. Спробуй знову або додай посилання на караоке.";
  } finally {
    clearTimeout(timer);
  }
};

$("video-form").onsubmit = (event) => {
  event.preventDefault();
  const source = $("video-url").value;
  const videoId = youtubeId(source);
  const audioUrl = backingAudioUrl(source);
  if (!videoId && !audioUrl) {
    $("video-status").textContent = "Встав посилання на відео з YouTube або пряме HTTPS-посилання на аудіофайл.";
    return;
  }
  const query = $("search-query").value;
  const title = youtubeId(query) || backingAudioUrl(query) ? "" : query;
  const song = externalSong(selectedTrack, { videoId, audioUrl }, title, trackResults);
  if (!song) {
    $("video-status").textContent = "Не вдалося підготувати цю версію пісні.";
    return;
  }
  changeSong(song, state.active);
  $("video-status").textContent = state.active ? "Пісню обрано для обох." : "Для нової кімнати обрано «" + song.title + "».";
  if (state.active) $("room-title").focus();
  else $("enter").focus();
};

function songButton(song) {
  const button = document.createElement("button");
  button.className = "song";
  button.type = "button";
  button.style.setProperty("--cover", song.color);
  button.innerHTML = '<span class="cover" aria-hidden="true"></span><span class="song-copy"><span class="song-title"></span><span class="song-meta"></span></span><span class="song-action" aria-hidden="true">↗</span>';
  button.querySelector(".cover").textContent = song.icon;
  button.querySelector(".song-title").textContent = song.title;
  button.querySelector(".song-meta").textContent = [song.genre, song.duration > 0 ? duration(song.duration) : ""].filter(Boolean).join(" · ");
  return button;
}

for (const song of songs) {
  const button = songButton(song);
  button.dataset.song = song.id;
  button.onclick = () => {
    changeSong(song, state.active && host);
    if (!state.active && host) $("catalog-status").textContent = "Для нової кімнати обрано «" + song.title + "».";
  };
  $("song-list").append(button);
}

if (hasInvite) {
  $("landing").classList.add("invitation");
  $("hero-title").textContent = validInvite ? "Тебе кличуть співати." : "Посилання недійсне.";
  $("hero-description").textContent = validInvite ? "Приєднуйся до кімнати. Твоя партія буде червоною." : "Попроси друга надіслати нове запрошення.";
  $("enter").textContent = validInvite ? "Приєднатися до дуету ↗" : "На головну ↗";
  if (!validInvite) $("enter").onclick = () => location.assign("./");
  $("catalog-link").onclick = (event) => {
    event.preventDefault();
    $("catalog").scrollIntoView();
  };
}

window.addEventListener("hashchange", () => {
  const next = new URLSearchParams(location.hash.slice(1));
  if ((next.get("room") || "") !== roomId || (next.get("key") || "") !== inviteKey) location.reload();
});

render();
