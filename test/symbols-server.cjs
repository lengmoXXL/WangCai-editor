// LSP stub with a fixed document-symbol response supplied by the test.
const symbols = JSON.parse(process.argv[2]);

const reply = (message, result) => {
  const text = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
};
const handle = (message) => {
  if (message.id === undefined) return;
  if (message.method === 'initialize') reply(message, { capabilities: { documentSymbolProvider: true } });
  else if (message.method === 'textDocument/documentSymbol') reply(message, symbols);
  else reply(message, null);
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
