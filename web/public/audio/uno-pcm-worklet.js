// Runs on the audio thread. Send small transferable chunks; never play microphone audio.
class UnoPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'stop') {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }
  flush() {
    if (!this.length) return;
    const samples = this.buffer.slice(0, this.length);
    this.port.postMessage({ type: 'samples', samples }, [samples.buffer]);
    this.length = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const frames = channels[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.buffer[this.length++] = sample / channels.length;
      if (this.length === this.buffer.length) this.flush();
    }
    return true;
  }
}
registerProcessor('uno-pcm-capture', UnoPcmCapture);
