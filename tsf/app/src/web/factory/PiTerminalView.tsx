import { useEffect, useRef, useState } from "react";
import { RotateCcw, TerminalSquare } from "lucide-react";
import { Alert, Button, EmptyState } from "@pw/ui/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function PiTerminalView() {
  const host = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(() => new URLSearchParams(location.search).get("terminal") === "1");
  const [session, setSession] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!started || !host.current) return;
    const terminal = new Terminal({ cursorBlink: true, theme: { background: "#080b0c", foreground: "#d7dedb" }, fontSize: 16 });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    fit.fit();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/pi-terminal`);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => terminal.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
    socket.onclose = () => terminal.write("\r\n\x1b[90mTerminal closed.\x1b[0m\r\n");
    socket.onerror = () => setError("Could not open the Pi terminal.");
    // Keystrokes go as binary frames, the terminal size as a text frame, so the server can tell them apart.
    const encoder = new TextEncoder();
    const sendSize = () => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ resize: [terminal.cols, terminal.rows] }));
    socket.onopen = () => { fit.fit(); sendSize(); };
    const input = terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(encoder.encode(data)));
    const sized = terminal.onResize(sendSize);
    const resize = new ResizeObserver(() => { fit.fit(); });
    resize.observe(host.current);
    return () => { input.dispose(); sized.dispose(); resize.disconnect(); socket.close(); terminal.dispose(); };
  }, [started, session]);
  if (!started) return <div className="tsf-focus-empty"><EmptyState icon={TerminalSquare} title="Pi terminal">Launch an interactive Pi session in this project.</EmptyState><Button variant="primary" onClick={() => setStarted(true)}>Launch Pi</Button></div>;
  return <div className="tsf-terminal-view">{error && <Alert tone="error" soft>{error}</Alert>}<Button className="tsf-terminal-restart" size="sm" variant="secondary" icon={RotateCcw} onClick={() => { setError(null); setSession((value) => value + 1); }}>Restart Pi</Button><div className="tsf-terminal" ref={host} /></div>;
}
