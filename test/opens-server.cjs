// LSP stub that counts its own starts in a file and says the name of every file it is told about, so a case can wait for
// the server behind one file to have read it.
const { appendFileSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { basename, join } = require('node:path');

// A single-byte append also records simultaneous starts in different project roots.
const counted = join(homedir(), 'lsp-starts');
appendFileSync(counted, '.');
const attempt = statSync(counted).size;
// Expose each failed start in the status tooltip through its exit code.
if (attempt <= Number(process.argv[2] ?? 0)) process.exit(attempt);

const send = (body) => {
  const text = JSON.stringify({ jsonrpc: '2.0', ...body });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
};
const handle = (message) => {
  if (message.method === 'initialize') send({ id: message.id, result: { capabilities: {} } });
  else if (message.method === 'textDocument/didOpen') {
    const { uri, version, text } = message.params.textDocument;
    const line = text.trimEnd().split('\n').length - 1;
    send({ method: 'window/showMessage', params: { type: 3, message: basename(uri) } });
    send({ method: 'textDocument/publishDiagnostics', params: { uri, version, diagnostics: [{
      range: { start: { line, character: 0 }, end: { line, character: 3 } }, severity: 2, message: 'shared diagnostic',
    }] } });
    send({ method: 'textDocument/publishDiagnostics', params: { uri, version: version - 1, diagnostics: [] } });
  }
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
