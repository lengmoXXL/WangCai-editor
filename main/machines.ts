import type { ExecOptions, ExecResult, Machine, MachineConnection } from '@lengmoxxl/sdk';
import type { MainContext } from '@lengmoxxl/sdk/channel';

// A single SDK exec reply holds 8 MiB. Page large command output on its own machine.
export async function withCommandOutput<T>(connection: MachineConnection, program: string, args: string[], options: ExecOptions,
  read: (result: Pick<ExecResult, 'code' | 'stderr'>, chunks: AsyncIterable<Buffer>) => Promise<T>) {
  const run = async (tool: string, argv: string[]) => {
    const { code, stdout, stderr } = await connection.subprocess.exec(tool, argv, options);
    if (code !== 0) throw new Error(Buffer.from(stderr).toString().trim() || `${tool} failed (${code})`);
    return Buffer.from(stdout);
  };
  // Acquire the name first so an SDK timeout can kill the command without losing its cleanup path.
  const path = (await run('mktemp', ['/tmp/wangcai-editor.XXXXXXXXXX'])).toString().trimEnd();
  const blockSize = 1024 * 1024;
  let remove = true;
  try {
    const result = await connection.subprocess.exec('/bin/sh', ['-c', `output=$1; size=$2; shift 2
"$@" > "$output"
code=$?
head -c "$size" "$output" || exit 2
if [ "$(wc -c < "$output")" -lt "$size" ]; then rm -f "$output" || exit 2; fi
exit "$code"`, 'sh', path, String(blockSize), program, ...args], options);
    remove = result.code !== 0 || result.stdout.length >= blockSize;
    async function* chunks() {
      let part = Buffer.from(result.stdout);
      for (let block = 1; part.length; block++) {
        yield part;
        if (part.length < blockSize) return;
        part = await run('dd', [`if=${path}`, `bs=${blockSize}`, `skip=${block}`, 'count=1']);
      }
    }
    return await read(result, chunks());
  } finally {
    if (remove) await connection.subprocess.exec('rm', ['-f', path], options).catch(() => undefined);
  }
}

// App-launched daemons may lack the PATH needed by a server’s shebang interpreter.
export async function locate(connection: MachineConnection, candidates: string[][], cwd: string) {
  for (const [program, ...args] of candidates) {
    const { stdout, code } = await connection.subprocess.exec('/bin/sh', ['-c',
      'PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; printf "%s\\0" "$PATH"; command -v "$1"', 'sh', program], { cwd });
    if (code !== 0) continue;
    const [envPath, found] = Buffer.from(stdout).toString().replace(/\n$/, '').split('\0');
    return { program: found, envPath, args };
  }
}

export function machineAccess(context: MainContext, signal: AbortSignal) {
  const held = new Set<() => void>();

  // A watch or a server keeps its own connection reference after the request returns.
  const withConnection = async <T>(machine: Machine, run: (connection: MachineConnection, keep: () => () => void) => Promise<T>) => {
    // The SDK keeps its abort listener after a connection settles. Give each attempt its own signal.
    const connection = await context.connect(machine, AbortSignal.any([signal]));
    const release = () => { if (held.delete(release)) connection.disconnect(); };
    held.add(release);
    let kept = false;
    try {
      signal.throwIfAborted();
      return await run(connection, () => { kept = true; return release; });
    } finally {
      if (!kept) release();
    }
  };

  return { withConnection, disconnect() { for (const release of held) release(); } };
}
