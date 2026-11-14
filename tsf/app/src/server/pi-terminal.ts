import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../core/paths.ts";
import { WebSocketServer, type WebSocket } from "ws";

// Python's stdlib `pty` is used because node-pty cannot fork on this macOS/Node runtime.
// fd 3 is a control pipe: lines of "<cols> <rows>" set the pty's window size, which sends SIGWINCH to Pi.
const PTY_BRIDGE = String.raw`import fcntl, os, pty, select, struct, sys, termios
command = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0: os.execvp(command[0], command)
control, pending = 3, b""
while True:
  ready, _, _ = select.select([fd, sys.stdin.buffer, control], [], [])
  if fd in ready:
    try: data = os.read(fd, 65536)
    except OSError: break
    if not data: break
    sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
  if sys.stdin.buffer in ready:
    data = os.read(sys.stdin.fileno(), 65536)
    if not data: break
    os.write(fd, data)
  if control in ready:
    data = os.read(control, 4096)
    if not data: break
    pending += data
    while b"\n" in pending:
      line, pending = pending.split(b"\n", 1)
      try:
        cols, rows = (int(n) for n in line.split())
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
      except (ValueError, OSError): pass
`;

/** Attach a local, interactive Pi session endpoint backed by a real OS pseudo-terminal. */
export function attachPiTerminal(server: Server): () => void {
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/api/pi-terminal") return;
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    const root = resolveProjectRoot();
    const userPi = join(process.env.HOME ?? "", "bin", "pi");
    const command = existsSync(userPi) ? ["/bin/bash", userPi] : ["pi"];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/usr/bin/python3", ["-c", PTY_BRIDGE, ...command], {
        cwd: root,
        env: { ...process.env, PI_CODING_AGENT_DIR: `${root}/builder/pi-agent` },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      ws.send(`\u001b[31mCould not start Pi: ${error instanceof Error ? error.message : String(error)}\u001b[0m\r\n`);
      ws.close(); sockets.delete(ws); return;
    }
    const output = (data: Buffer) => { if (ws.readyState === ws.OPEN) ws.send(data); };
    child.stdout!.on("data", output);
    child.stderr!.on("data", output);
    // Binary frames are keystrokes. Text frames are control messages: {"resize":[cols,rows]}.
    const control = child.stdio[3] as NodeJS.WritableStream | null;
    ws.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      if (isBinary) {
        child.stdin?.write(bytes);
        return;
      }
      try {
        const [cols, rows] = JSON.parse(bytes.toString("utf8")).resize ?? [];
        if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) control?.write(`${cols} ${rows}\n`);
      } catch {
        /* not a control message */
      }
    });
    const close = () => { if (!child.killed) child.kill("SIGTERM"); sockets.delete(ws); };
    ws.on("close", close);
    child.on("close", () => { if (ws.readyState === ws.OPEN) ws.close(); sockets.delete(ws); });
  });
  return () => { for (const ws of sockets) ws.close(); wss.close(); };
}
