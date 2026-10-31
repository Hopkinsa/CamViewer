import { useEffect, useRef, useState } from "react";
import { RotateCcw, Scan } from "lucide-react";
import type { Media, Settings } from "../shared/types";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface MotionSettings {
  sensitivity: number;
  padding: number;
  border: number;
  color: string;
  fill: string;
  opacity: number;
}
const defaults: MotionSettings = {
  sensitivity: 55,
  padding: 10,
  border: 2,
  color: "#e64b45",
  fill: "#e64b45",
  opacity: 0.1,
};

export function MotionPlayer({ media }: { media: Media }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState<MotionSettings>(defaults);
  const loaded = useRef(false);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(1);
  useEffect(() => {
    void window.camviewer?.settings().then((settings) => {
      setSettings(settings.motion ?? defaults);
      loaded.current = true;
    });
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    const timer = setTimeout(() => {
      void window.camviewer
        ?.settings()
        .then((settingsSnapshot) =>
          window.camviewer!.saveSettings({
            ...settingsSnapshot,
            motion: settings,
          } as Settings),
        )
        .catch((failure) => setError(String(failure)));
    }, 500);
    return () => clearTimeout(timer);
  }, [settings]);
  useEffect(() => {
    if (!enabled) {
      setBoxes([]);
      return;
    }
    let disposed = false;
    let last = 0;
    let frame = 0;
    let ready = false;
    let pending = false;
    const worker = new Worker(new URL("./motion-worker.ts", import.meta.url), {
      type: "module",
    });
    const reset = () => {
      worker.postMessage({ reset: true });
      setBoxes([]);
    };
    const player = video.current!;
    const pause = () => {
      cancelAnimationFrame(frame);
      reset();
    };
    const analyze = (timestamp: number) => {
      if (disposed || player.paused || player.ended || document.hidden) {
        if (!disposed) frame = requestAnimationFrame(analyze);
        return;
      }
      if (
        timestamp - last > 100 &&
        player.readyState >= 2 &&
        player.videoWidth &&
        ready &&
        !pending
      ) {
        last = timestamp;
        const width = Math.min(480, player.videoWidth);
        const height = Math.round(
          (width * player.videoHeight) / player.videoWidth,
        );
        const target = canvas.current!;
        target.width = width;
        target.height = height;
        const context = target.getContext("2d", { willReadFrequently: true })!;
        try {
          context.drawImage(player, 0, 0, width, height);
          const image = context.getImageData(0, 0, width, height);
          pending = true;
          worker.postMessage({ image, settings }, [image.data.buffer]);
        } catch (failure) {
          setError(`Motion analysis unavailable: ${String(failure)}`);
          setEnabled(false);
        }
      }
      frame = requestAnimationFrame(analyze);
    };
    player.addEventListener("seeking", reset);
    player.addEventListener("pause", pause);
    player.addEventListener("ended", reset);
    const begin = () => {
      cancelAnimationFrame(frame);
      reset();
      frame = requestAnimationFrame(analyze);
    };
    player.addEventListener("play", begin);
    worker.onmessage = ({ data }) => {
      if (disposed) return;
      if (data.error) {
        setError(`Motion analysis unavailable: ${data.error}`);
        setEnabled(false);
        return;
      }
      if (data.ready) {
        ready = true;
        begin();
      }
      if (data.boxes) {
        pending = false;
        if (canvas.current) canvas.current.dataset.analyzed = "true";
        setBoxes(data.boxes);
      }
    };
    worker.onerror = (event) => {
      if (!disposed) {
        setError(`Motion analysis unavailable: ${event.message}`);
        setEnabled(false);
      }
    };
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      worker.terminate();
      player.removeEventListener("seeking", reset);
      player.removeEventListener("pause", pause);
      player.removeEventListener("ended", reset);
      player.removeEventListener("play", begin);
    };
  }, [enabled, settings, media.id]);
  return (
    <div className="motion-player">
      <div
        className="video-picture"
        style={{ aspectRatio: `${media.width || 16} / ${media.height || 9}` }}
      >
        <video
          ref={video}
          crossOrigin="anonymous"
          src={media.url}
          controls
          playsInline
          onError={() =>
            setError(
              "This video cannot be decoded by Chromium. Keep the original and use a supported codec.",
            )
          }
        />
        {enabled && (
          <div className="motion-layer" aria-hidden="true">
            {boxes.map((box, index) => (
              <span
                key={index}
                style={{
                  left: `${box.x}%`,
                  top: `${box.y}%`,
                  width: `${box.width}%`,
                  height: `${box.height}%`,
                  border: `${settings.border}px solid ${settings.color}`,
                  background:
                    settings.fill +
                    Math.round(settings.opacity * 255)
                      .toString(16)
                      .padStart(2, "0"),
                }}
              />
            ))}
          </div>
        )}
      </div>
      <div className="motion-toolbar">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <Scan size={15} />
          Motion
        </label>
        <select
          aria-label="Playback speed"
          value={rate}
          onChange={(event) => {
            const value = Number(event.target.value);
            setRate(value);
            if (video.current) video.current.playbackRate = value;
          }}
        >
          {[0.25, 0.5, 1, 1.5, 2].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
      </div>
      {enabled && (
        <div className="motion-settings">
          {(["sensitivity", "padding", "border", "opacity"] as const).map(
            (key) => (
              <label key={key}>
                {key}
                <input
                  aria-label={`Motion ${key}`}
                  type="range"
                  min={key === "border" ? 1 : 0}
                  max={
                    key === "opacity"
                      ? 0.5
                      : key === "padding"
                        ? 40
                        : key === "border"
                          ? 8
                          : 100
                  }
                  step={key === "opacity" ? 0.01 : 1}
                  value={settings[key]}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      [key]: Number(event.target.value),
                    })
                  }
                />
              </label>
            ),
          )}
          <label>
            Outline
            <input
              type="color"
              value={settings.color}
              onChange={(event) =>
                setSettings({ ...settings, color: event.target.value })
              }
            />
          </label>
          <label>
            Fill
            <input
              type="color"
              value={settings.fill}
              onChange={(event) =>
                setSettings({ ...settings, fill: event.target.value })
              }
            />
          </label>
          <button
            className="icon small"
            title="Reset motion settings"
            onClick={() => setSettings(defaults)}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <canvas ref={canvas} hidden />
    </div>
  );
}
