// Spike: send JS lines to the app's shots socket. Usage: bun drive.mjs <socket> '<js>' ['<js>' ...]
import net from "node:net";

const [sock, ...lines] = process.argv.slice(2);
const c = net.createConnection(sock);
let buf = "";
const pending = [...lines];
c.on("connect", () => c.write(pending[0] + "\n"));
c.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    console.log(buf.slice(0, i));
    buf = buf.slice(i + 1);
    pending.shift();
    if (pending.length) c.write(pending[0] + "\n");
    else c.end();
  }
});
c.on("error", (e) => { console.error(e.message); process.exit(1); });
