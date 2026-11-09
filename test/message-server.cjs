// LSP stub that says one line over the editor as it comes up, the way a server reports its progress.
const said = process.argv[2];

const frame = (body) => `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
const reply = (id, result) => process.stdout.write(frame(JSON.stringify({ jsonrpc: '2.0', id, result })));
const say = () => process.stdout.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'window/showMessage', params: { type: 3, message: said } })));

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString());
    buffer = buffer.subarray(bodyStart + length);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') {
      reply(message.id, { capabilities: {} });
      say();
    } else reply(message.id, null);
  }
});