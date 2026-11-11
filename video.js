let api;

function youtubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (api) return api;
  api = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      api = undefined;
      script.remove();
      reject(new Error("YouTube API unavailable"));
    };
    const timeout = setTimeout(fail, 12000);
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      resolve(window.YT);
    };
    script.onerror = () => {
      clearTimeout(timeout);
      fail();
    };
    script.src = "https://www.youtube.com/iframe_api";
    document.head.append(script);
  });
  return api;
}

export class VideoTrack {
  #container;
  #notify;
  #player;
  #loading;
  #cancelLoad;
  #timer;
  #watchdog;
  #id;
  #volume = 75;
  #primed = false;
  #startAt = null;
  #running = false;
  #error = false;

  constructor(container, notify) {
    this.#container = container;
    this.#notify = notify;
  }

  get duration() { return this.#player?.getDuration?.() || 0; }
  get ready() { return this.#primed && !this.#error; }
  get ended() { return this.#running && this.#player?.getPlayerState?.() === 0; }
  get playing() { return this.#running && this.#player?.getPlayerState?.() === 1; }
  get position() {
    if (this.#startAt === null) return null;
    const elapsed = (performance.now() - this.#startAt) / 1000;
    if (elapsed < 0) return elapsed;
    return this.#running ? this.#player.getCurrentTime() : 0;
  }

  async load(id) {
    if (id === this.#id && this.#loading && !this.#error) return this.#loading;
    this.clear();
    this.#id = id;
    this.#container.hidden = false;
    const current = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Video timed out")), 14000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Video unavailable"));
      };
      this.#cancelLoad = fail;
      youtubeApi().then((YT) => {
        if (this.#loading !== current) return;
        const iframe = document.createElement("iframe");
        const url = new URL("https://www.youtube.com/embed/" + id);
        url.search = new URLSearchParams({
          enablejsapi: "1", origin: location.origin, playsinline: "1", rel: "0",
        });
        iframe.src = url.href;
        iframe.title = "Мінусовка на YouTube";
        iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
        this.#container.append(iframe);
        this.#player = new YT.Player(iframe, {
          events: {
            onReady: (event) => {
              if (this.#loading !== current) return;
              this.#primed = true;
              event.target.setVolume(this.#volume);
              clearTimeout(timer);
              resolve();
            },
            onStateChange: (event) => {
              if (this.#loading !== current) return;
              if (event.data === 1 && this.#startAt !== null) {
                clearTimeout(this.#watchdog);
                this.#notify("playing");
              }
              this.#notify("position");
            },
            onAutoplayBlocked: () => {
              if (this.#loading === current && this.#startAt !== null) this.#notify("blocked");
            },
            onError: () => {
              if (this.#loading !== current) return;
              this.#error = true;
              fail();
              this.#notify("error");
            },
          },
        });
      }).catch(fail);
    });
    this.#loading = current;
    try {
      await current;
    } catch (error) {
      if (this.#loading === current) this.#error = true;
      throw error;
    }
  }

  setVolume(volume) {
    this.#volume = volume;
    if (this.#primed) this.#player.setVolume(volume);
  }

  play(delay) {
    if (!this.ready) throw new Error("Video unavailable");
    this.stop();
    this.#startAt = performance.now() + delay * 1000;
    this.#timer = setTimeout(() => this.resume(), Math.max(0, delay * 1000));
  }

  resume() {
    if (this.#startAt === null || !this.ready) return;
    this.#running = true;
    const elapsed = Math.max(0, (performance.now() - this.#startAt) / 1000);
    this.#player.seekTo(elapsed < 0.15 ? 0 : elapsed, true);
    this.#player.playVideo();
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      if (!this.playing && !this.ended && !this.#error) this.#notify("blocked");
    }, 5000);
  }

  align(position) {
    if (this.playing && position >= 0 && position < this.duration && Math.abs(this.position - position) > 1.5) {
      this.#player.seekTo(position, true);
    }
  }

  stop() {
    clearTimeout(this.#timer);
    clearTimeout(this.#watchdog);
    this.#startAt = null;
    this.#running = false;
    if (this.#primed) this.#player.pauseVideo();
  }

  clear() {
    this.stop();
    this.#cancelLoad?.();
    this.#cancelLoad = undefined;
    this.#loading = undefined;
    this.#player?.destroy();
    this.#player = undefined;
    this.#id = undefined;
    this.#primed = false;
    this.#error = false;
    this.#container.replaceChildren();
    this.#container.hidden = true;
  }
}
