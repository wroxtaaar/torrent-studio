import React, { useEffect, useRef, useState } from "react";

export default function SeedrReactTest() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);

  const log = (message: string) =>
    setEvents((prev) => [...prev.slice(-79), `${new Date().toLocaleTimeString()} | ${message}`]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const names = ["loadstart","loadedmetadata","loadeddata","canplay","canplaythrough","play","playing","pause","waiting","stalled","suspend","seeking","seeked","ended"];
    const handlers = names.map((name) => {
      const handler = () => log(`${name} | readyState=${video.readyState} networkState=${video.networkState} currentTime=${video.currentTime.toFixed(3)}`);
      video.addEventListener(name, handler);
      return [name, handler] as const;
    });
    const onError = () => {
      const error = video.error;
      log(`MEDIA ERROR | code=${error?.code ?? "unknown"} message=${error?.message || "none"}`);
    };
    video.addEventListener("error", onError);
    return () => {
      handlers.forEach(([name, handler]) => video.removeEventListener(name, handler));
      video.removeEventListener("error", onError);
    };
  }, []);

  const load = () => {
    const video = videoRef.current;
    const nextUrl = url.trim();
    if (!video || !nextUrl) return;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.src = nextUrl;
    video.load();
    log("React test assigned direct Seedr URL");
  };

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24, fontFamily: "system-ui", color: "#e5e7eb" }}>
      <h1>Seedr → React &lt;video&gt; Test</h1>
      <p style={{ color: "#94a3b8" }}>
        Same direct Seedr URL, rendered through React. No Torrent Studio API, qBittorrent, proxy, FFmpeg, or HLS.
      </p>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste the direct Seedr URL"
        style={{ width: "100%", boxSizing: "border-box", padding: 12, background: "#0f172a", color: "#fff", border: "1px solid #334155", borderRadius: 8 }}
      />
      <button onClick={load} style={{ margin: "12px 0", padding: "10px 16px", border: 0, borderRadius: 8, fontWeight: 700 }}>
        Load / Play Test URL
      </button>
      <video ref={videoRef} controls playsInline preload="metadata" style={{ width: "100%", maxHeight: "70vh", background: "#000", borderRadius: 12 }} />
      <pre style={{ marginTop: 16, padding: 14, background: "#020617", borderRadius: 10, whiteSpace: "pre-wrap", overflow: "auto", fontSize: 12 }}>
        {events.length ? events.join("\n") : "Waiting for test…"}
      </pre>
    </main>
  );
}
