// LSP stub that counts its own starts in a file and says the name of every file it is told about, so a case can wait for
// the server behind one file to have read it.
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');

const counted = process.argv[2];
writeFileSync(counted, String((existsSync(counted) ? Number(readFileSync(counted, 'utf8')) : 0) + 1));

const send = (body) => {
  const text = JSON.stringify({ jsonrpc: '2.0', ...body });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
};
const handle = (message) => {
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  else if (message.method === 'textDocument/didOpen') send({ method: 'window/showMessage', params: { type: 3, message: basename(message.params.textDocument.uri) } });
  else if (message.id !== undefined) send({ id: message.id, result: null });
};

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
    handle(message);
  }
});