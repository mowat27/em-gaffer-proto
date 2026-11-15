// Fails fast, with the culprit named, when the API or web port from skeleton.json is already taken.
import {readFileSync} from 'node:fs';
import net from 'node:net';

const {apiPort, webPort} = JSON.parse(readFileSync('skeleton.json', 'utf8'));
const free = (port) => new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port);
});
const busy = [];
for (const [name, port] of [['API', apiPort], ['web', webPort]]) if (!(await free(port))) busy.push(`${name} port ${port}`);
if (busy.length) {
    console.error(`In use: ${busy.join(', ')}. Is the app already running (\`just down\`)? Otherwise see lsof -nP -iTCP -sTCP:LISTEN, or change the ports in skeleton.json and run \`just env\`.`);
    process.exit(1);
}
