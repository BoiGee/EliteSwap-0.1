import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square, Trash2, Play, Pause } from "lucide-react";
import { AUDIO_MAX_DURATION_MS } from "@/lib/forum";

export interface RecordedClip {
  blob: Blob;
  duration_ms: number;
  url: string;
}

export default function VoiceRecorder({
  onChange,
}: { onChange: (clip: RecordedClip | null) => void }) {
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    if (recRef.current?.state === "recording") recRef.current.stop();
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (clip?.url) URL.revokeObjectURL(clip.url);
  }, []);

  async function start() {
    if (clip) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const duration_ms = Date.now() - startRef.current;
        const c = { blob, duration_ms, url };
        setClip(c);
        onChange(c);
      };
      rec.start();
      recRef.current = rec;
      startRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const ms = Date.now() - startRef.current;
        setElapsedMs(ms);
        if (ms >= AUDIO_MAX_DURATION_MS) stop();
      }, 200);
    } catch (e) {
      alert("Microphone access denied");
    }
  }

  function stop() {
    if (recRef.current?.state === "recording") recRef.current.stop();
    if (timerRef.current) window.clearInterval(timerRef.current);
    setRecording(false);
  }

  function reset() {
    if (clip?.url) URL.revokeObjectURL(clip.url);
    setClip(null);
    setElapsedMs(0);
    onChange(null);
  }

  function togglePlay() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play(); setPlaying(true); }
  }

  const seconds = Math.floor((recording ? elapsedMs : clip?.duration_ms ?? 0) / 1000);

  return (
    <div className="flex items-center gap-2 p-2 rounded-md border border-border bg-muted/20">
      {!clip && !recording && (
        <Button type="button" size="sm" variant="outline" onClick={start}>
          <Mic className="w-4 h-4 mr-1" /> Record voice note
        </Button>
      )}
      {recording && (
        <>
          <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-xs font-mono">{seconds}s / 120s</span>
          <Button type="button" size="sm" variant="destructive" onClick={stop}>
            <Square className="w-4 h-4 mr-1" /> Stop
          </Button>
        </>
      )}
      {clip && !recording && (
        <>
          <Button type="button" size="icon" variant="ghost" onClick={togglePlay}>
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </Button>
          <audio
            ref={audioRef}
            src={clip.url}
            onEnded={() => setPlaying(false)}
            className="hidden"
          />
          <span className="text-xs font-mono">{seconds}s</span>
          <Button type="button" size="icon" variant="ghost" onClick={reset}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );
}
