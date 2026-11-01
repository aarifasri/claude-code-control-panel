// Hide secret-looking values in command lines and URLs before they reach the browser (invariant I6).

const SECRET_FLAG = /^--?[\w-]*(key|token|secret|password|passwd|pwd|auth|bearer|credential)[\w-]*$/i;
const SECRET_ASSIGN = /^([\w-]*(key|token|secret|password|passwd|pwd|auth|bearer|credential)[\w-]*=).+$/i;
// Long random-looking strings (API keys, JWTs), but not paths, URLs or package names.
const LONG_OPAQUE = /^[A-Za-z0-9_\-.+/=]{32,}$/;

function redactUrl(word: string): string {
  try {
    const url = new URL(word);
    if (url.username || url.password) { url.username = '***'; url.password = ''; }
    for (const k of [...url.searchParams.keys()]) url.searchParams.set(k, '***');
    return url.toString().replace(/%2A%2A%2A/g, '***');
  } catch {
    return word;
  }
}

export function redactCommandLine(line: string): string {
  const words = line.split(' ');
  return words
    .map((word, i) => {
      if (/^https?:\/\//i.test(word)) return redactUrl(word);
      const assign = SECRET_ASSIGN.exec(word);
      if (assign) return `${assign[1]}***`;
      if (i > 0 && SECRET_FLAG.test(words[i - 1]!) && word !== '') return '***';
      if (LONG_OPAQUE.test(word) && !word.includes('/') && !word.includes('@')) return '***';
      return word;
    })
    .join(' ');
}
