// A comparison addressed as a resource: git://<absolute-path>@<base>~<head>, with an optional ?old=<absolute-path> for
// the other name a rename gives the old side. A side is a git revision or one of :index/:ours/:theirs/:worktree/:empty;
// the head is always a revision or token without a '~', so the last '~' separates the pair even when the base carries
// ancestry like HEAD~3.
export interface GitUri { path: string; base: string; head: string; oldPath?: string }

export const buildGitUri = (path: string, base: string, head: string, oldPath?: string) =>
  `git://${path}@${base}~${head}${oldPath ? `?old=${oldPath}` : ''}`;

export const parseGitUri = (uri: string): GitUri | undefined => {
  if (!uri.startsWith('git://')) return undefined;
  const [rest, query] = uri.slice('git://'.length).split('?');
  const at = rest.lastIndexOf('@');
  const sep = rest.lastIndexOf('~');
  if (at < 0 || sep < at) return undefined;
  const base = rest.slice(at + 1, sep);
  const head = rest.slice(sep + 1);
  if (!base || !head) return undefined;
  return { path: rest.slice(0, at), base, head, oldPath: query?.startsWith('old=') ? query.slice(4) : undefined };
};
