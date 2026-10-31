type Pausable = { pause(): void };

// A response owns its object URL only while its request generation is current.
export class MeetingAudioPlayback {
  private generation = 0;
  private url: string | null = null;
  player: Pausable | null = null;

  constructor(private readonly revoke: (url: string) => void = URL.revokeObjectURL) {}

  request(): number {
    this.invalidate();
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  install(generation: number, url: string, player: Pausable): boolean {
    if (!this.isCurrent(generation)) {
      player.pause();
      this.revoke(url);
      return false;
    }
    this.url = url;
    this.player = player;
    return true;
  }

  invalidate(): void {
    this.generation++;
    this.player?.pause();
    if (this.url) this.revoke(this.url);
    this.player = null;
    this.url = null;
  }
}
