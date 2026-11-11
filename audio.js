export class DuetAudio {
  #context;
  #music;
  #voice;
  #buffer;
  #source;
  #partner;
  #selected;
  #startAt = 0;

  get ready() { return !!this.#buffer && this.#context?.state === "running"; }
  get position() { return this.#source ? this.#context.currentTime - this.#startAt : null; }

  async unlock() {
    if (!this.#context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.#context = new AudioContext({ latencyHint: "interactive" });
      this.#music = this.#context.createGain();
      this.#voice = this.#context.createGain();
      this.#music.connect(this.#context.destination);
      this.#voice.connect(this.#context.destination);
    }
    await this.#context.resume();
  }

  async load(song) {
    if (this.#selected === song.id && this.#buffer) return;
    this.#selected = song.id;
    this.#buffer = null;
    const response = await fetch(new URL("./audio/" + song.id + ".mp3", import.meta.url));
    if (!response.ok) throw new Error("Backing track unavailable");
    const buffer = await this.#context.decodeAudioData(await response.arrayBuffer());
    if (this.#selected === song.id) this.#buffer = buffer;
  }

  volume(music, voice) {
    if (!this.#context) return;
    this.#music.gain.setValueAtTime(music, this.#context.currentTime);
    this.#voice.gain.setValueAtTime(voice, this.#context.currentTime);
  }

  partner(stream) {
    this.#partner?.disconnect();
    this.#partner = stream ? this.#context.createMediaStreamSource(stream) : null;
    this.#partner?.connect(this.#voice);
  }

  play(delay) {
    if (!this.ready) throw new Error("Audio unavailable");
    this.stop();
    const source = this.#context.createBufferSource();
    source.buffer = this.#buffer;
    source.connect(this.#music);
    this.#startAt = this.#context.currentTime + delay;
    source.start(Math.max(this.#context.currentTime, this.#startAt), Math.max(0, -delay));
    this.#source = source;
  }

  stop() {
    if (!this.#source) return;
    this.#source.stop();
    this.#source.disconnect();
    this.#source = null;
  }
}
