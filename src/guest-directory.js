// Shared package directory enumeration and DOS-style wildcard matching.
export function virtualNames(r, prefix) {
  const names = new Map();
  for (const name of r.files.keys()) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    names.set(slash < 0 ? rest : rest.slice(0, slash), slash >= 0);
  }
  // Directories created at run time are not files, so track them separately.
  for (const directory of r.virtualDirectories ?? [])
    if (directory.startsWith(prefix) && directory.length > prefix.length) {
      const rest = directory.slice(prefix.length).replace(/\/$/, '');
      if (rest && !rest.includes('/')) names.set(rest, true);
    }
  return names;
}

export function matchWildcard(pattern, name) {
  const lowerName = name.toLowerCase();
  const sources = pattern.toLowerCase();
  // Classic two-pointer backtracking: no regex means no pathological compile
  // cost on a long name, and `*` never needs a greedy rewrite.
  let p = 0,
    n = 0,
    star = -1,
    resume = 0;
  while (n < lowerName.length) {
    if (p < sources.length && (sources[p] === '?' || sources[p] === lowerName[n])) {
      p++;
      n++;
    } else if (p < sources.length && sources[p] === '*') {
      star = p++;
      resume = n;
    } else if (star >= 0) {
      p = star + 1;
      n = ++resume;
    } else return false;
  }
  while (p < sources.length && sources[p] === '*') p++;
  return p === sources.length;
}
