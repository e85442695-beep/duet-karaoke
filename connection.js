export const clock = () => performance.timeOrigin + performance.now();

const PEER_OPTIONS = {
  secure: true,
  config: {
    iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }],
    sdpSemantics: "unified-plan",
  },
};
const MAX_SILENCE = 12000;

export class DuetConnection {
  #peer;
  #data;
  #media;
  #deadline;
  #pulse;
  #mediaDeadline;
  #lastHeard = 0;
  #stream;
  #update;
  #message;
  #room;
  #host;
  #closing = false;
  #reconnect;

  constructor(room, host, update, message) {
    this.#room = room;
    this.#host = host;
    this.#update = update;
    this.#message = message;
  }

  connect() {
    const Peer = window.peerjs?.Peer || window.Peer;
    if (!Peer) throw new Error("PeerJS unavailable");
    const peer = this.#host ? new Peer(this.#room.id, PEER_OPTIONS) : new Peer(PEER_OPTIONS);
    this.#peer = peer;
    this.#deadline = setTimeout(() => this.#failed(), MAX_SILENCE);
    peer.on("open", () => {
      if (this.#closing) return;
      if (this.#host) {
        if (!this.#data?.open) {
          clearTimeout(this.#deadline);
          this.#update("waiting");
        }
      } else if (!this.#data) {
        this.#bind(peer.connect(this.#room.id, {
          serialization: "json",
          reliable: true,
          metadata: { key: this.#room.key },
        }));
      }
    });
    peer.on("connection", (data) => {
      if (this.#closing) return data.close();
      if (!this.#host || data.metadata?.key !== this.#room.key) return data.close();
      if (this.#data) {
        data.on("open", () => {
          data.send({ type: "full" });
          setTimeout(() => data.close(), 650);
        });
        return;
      }
      clearTimeout(this.#deadline);
      this.#bind(data);
      this.#deadline = setTimeout(() => this.#drop("waiting"), MAX_SILENCE);
    });
    peer.on("call", (call) => {
      if (this.#host || !this.#data?.open || call.peer !== this.#data.peer ||
          call.metadata?.key !== this.#room.key || !this.#stream || this.#media) {
        call.close();
        return;
      }
      this.#bindMedia(call);
      call.answer(this.#stream);
    });
    peer.on("disconnected", () => {
      if (this.#closing) return;
      if (!this.#data?.open) this.#update("signaling");
      this.#reconnect = setTimeout(() => {
        if (!this.#closing && !peer.destroyed && peer.disconnected) peer.reconnect();
      }, 1400);
    });
    peer.on("error", (error) => {
      if (this.#closing) return;
      if (error.type === "peer-unavailable" && !this.#host) this.#drop("unavailable");
      else if (!this.#data?.open && ["browser-incompatible", "invalid-id", "invalid-key", "unavailable-id", "server-error", "socket-error", "socket-closed", "ssl-unavailable"].includes(error.type)) this.#failed();
    });
  }

  #bind(data) {
    this.#data = data;
    data.on("open", () => {
      if (data !== this.#data) return;
      this.#lastHeard = performance.now();
      if (this.#host) {
        clearTimeout(this.#deadline);
        this.send({ type: "welcome" });
        this.#update("joined");
      }
      this.#pulse = setInterval(() => {
        if (performance.now() - this.#lastHeard > MAX_SILENCE) this.#drop("lost");
        else this.send({ type: "pulse" });
      }, 2400);
    });
    data.on("data", (message) => {
      if (data !== this.#data || !message || typeof message !== "object") return;
      this.#lastHeard = performance.now();
      if (message.type === "full" && !this.#host) return this.#drop("full");
      if (message.type === "leave") return this.#drop("lost");
      if (message.type === "welcome" && !this.#host) {
        clearTimeout(this.#deadline);
        this.#update("joined");
        return;
      }
      if (message.type === "pulse") return;
      this.#message(message);
    });
    data.on("error", () => {
      if (data === this.#data) this.#drop("lost");
    });
    data.on("close", () => {
      if (data === this.#data) this.#drop("lost");
    });
  }

  setStream(stream) { this.#stream = stream; }

  call() {
    if (!this.#host || !this.#stream || !this.#data?.open || this.#media) return;
    this.#bindMedia(this.#peer.call(this.#data.peer, this.#stream, { metadata: { key: this.#room.key } }));
  }

  #bindMedia(call) {
    if (!call) return this.#drop("voice-failed");
    this.#media = call;
    this.#mediaDeadline = setTimeout(() => this.#drop("voice-failed"), MAX_SILENCE);
    call.on("stream", (stream) => {
      if (call !== this.#media) return;
      clearTimeout(this.#mediaDeadline);
      this.#update("voice", stream);
    });
    call.on("error", () => {
      if (call === this.#media) this.#drop("voice-failed");
    });
    call.on("close", () => {
      if (call === this.#media) this.#drop("voice-failed");
    });
    const rtc = call.peerConnection;
    rtc?.addEventListener("connectionstatechange", () => {
      if (call !== this.#media) return;
      if (rtc.connectionState === "failed") this.#drop("voice-failed");
    });
  }

  send(message) {
    if (!this.#data?.open) return false;
    this.#data.send(message);
    return true;
  }

  #failed() {
    this.close();
    this.#update("signaling-failed");
  }

  #drop(reason) {
    const data = this.#data;
    const media = this.#media;
    this.#data = null;
    this.#media = null;
    clearInterval(this.#pulse);
    clearTimeout(this.#deadline);
    clearTimeout(this.#mediaDeadline);
    media?.close();
    data?.close();
    if (!this.#closing) this.#update(reason);
  }

  close() {
    this.#closing = true;
    clearTimeout(this.#reconnect);
    this.send({ type: "leave" });
    this.#drop("closed");
    this.#peer?.destroy();
  }
}
