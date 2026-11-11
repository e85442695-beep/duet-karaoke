import { songs } from "./songs.js";
import { DuetAudio } from "./audio.js";
import { clock, DuetConnection } from "./connection.js";

const $ = (id) => document.getElementById(id);
const audio = new DuetAudio();
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
  return host && state.joined && state.voice && state.me.ready && state.other.ready && audio.ready;
}

function render() {
  $("landing").hidden = state.active;
  $("room").hidden = !state.active;
  $("leave").hidden = !state.active;
  $("catalog-link").hidden = state.active;
  $("copy").hidden = !host;
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
  for (const button of $("song-list").children) {
    const selected = button.dataset.song === state.song.id;
    button.setAttribute("aria-pressed", selected);
    button.disabled = state.active && !host;
    button.querySelector(".song-action").textContent = selected ? "✓" : "↗";
  }
  renderLyrics();
}

function renderLyrics() {
  const position = audio.position;
  const song = state.song;
  const first = song.lines[0];
  let part = first.part;
  let label = "До початку";
  let line = first.text;
  let next = song.lines[1]?.text || "";
  if (position !== null && position < 0) {
    label = "Починаємо за";
    line = String(Math.max(1, Math.ceil(-position)));
    next = "Перший рядок · " + first.text;
  } else if (position !== null && position < song.intro) {
    label = "Вступ";
    line = "Приготуйся співати";
    next = "Перший рядок · " + first.text;
  } else if (position !== null) {
    const index = song.lines.findIndex((cue) => position >= cue.start && position < cue.start + cue.duration);
    if (index >= 0) {
      const cue = song.lines[index];
      const upcoming = song.lines[index + 1];
      part = cue.part;
      label = (part === ownPart ? "Твоя партія" : "Партія друга") + (part === "blue" ? " · синя" : " · червона");
      line = cue.text;
      next = upcoming ? "Далі · " + upcoming.text : "Останній рядок";
    } else {
      label = "Фінал";
      line = "Останні такти";
      next = "";
    }
  } else if (finished) {
    label = "Пісня завершилась";
    line = "Дякуємо за дует!";
    next = host ? "Можна повторити або обрати іншу пісню." : "Ведучий може почати знову або обрати іншу пісню.";
  } else {
    next = (host ? "Ви починаєте синьою партією" : "Друг починає синьою партією") + " · " + next;
  }
  const lyrics = [part, label, line, next].join("\n");
  if (lyrics !== lastLyrics) {
    $("lyric-stage").dataset.part = part;
    $("part-label").textContent = label;
    $("current-line").textContent = line;
    $("next-line").textContent = next;
    lastLyrics = lyrics;
  }
  const elapsed = finished ? song.duration : Math.min(song.duration, Math.max(0, position ?? 0));
  $("stage-time").textContent = duration(elapsed) + " / " + duration(song.duration);
  $("progress").max = song.duration;
  $("progress").value = elapsed;
}

function tick() {
  if (!playback) return;
  if (audio.position >= state.song.duration) {
    endPlayback(true);
    message("Пісня завершилась.");
    return;
  }
  renderLyrics();
  frame = requestAnimationFrame(tick);
}

function endPlayback(completed = false) {
  cancelAnimationFrame(frame);
  audio.stop();
  playback = null;
  finished = completed;
  render();
}

function schedule(startAt) {
  try {
    const delay = (startAt - clock() - (host ? 0 : clockSample.offset)) / 1000;
    if (delay < -1 || delay > 8) throw new Error("Clock unavailable");
    audio.play(delay);
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
  state.song = song;
  state.me.ready = false;
  state.other.ready = false;
  endPlayback();
  if (sync) connection?.send({ type: "song", id: song.id });
  if (state.active) {
    sendSeat();
    message(state.joined ? "Пісню змінено. Підтвердьте готовність." : "Запроси друга за посиланням.");
  }
  render();
}

function updateVolumes() {
  audio.volume($("music-volume").valueAsNumber / 100, $("voice-volume").valueAsNumber / 100);
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
      const song = songs.find(({ id }) => id === data.id);
      if (!host && song) changeSong(song);
      break;
    }
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
    if (host) connection.send({ type: "song", id: state.song.id });
    else {
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
    await audio.load(selected);
    if (!state.active || !state.voice || connection !== currentConnection || selected !== state.song) return;
    state.me.ready = true;
    sendSeat();
    message(host ? "Коли друг буде готовий, можна починати." : "Ти готовий. Ведучий запустить пісню.");
  } catch {
    if (state.active) message("Не вдалося завантажити фонограму. Натисни «Готовий» ще раз.");
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
$("unlock").onclick = async () => {
  try {
    await Promise.all([audio.unlock(), remotePlayback?.play()]);
    $("unlock").hidden = true;
  } catch { message("Звук заблоковано. Перевір налаштування відтворення в браузері."); }
};

function leave() {
  connection?.close();
  resetPartner();
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

for (const song of songs) {
  const button = document.createElement("button");
  button.className = "song";
  button.type = "button";
  button.dataset.song = song.id;
  button.style.setProperty("--cover", song.color);
  button.innerHTML = '<span class="cover" aria-hidden="true"></span><span class="song-copy"><span class="song-title"></span><span class="song-meta"></span></span><span class="song-action" aria-hidden="true"></span>';
  button.querySelector(".cover").textContent = song.icon;
  button.querySelector(".song-title").textContent = song.title;
  button.querySelector(".song-meta").textContent = song.genre + " · " + duration(song.duration);
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
}

render();
