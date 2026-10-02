import { WINE_API_SET_SCHEMA } from './wine-api-set-schema.js';

// Wine's v6 namespace hashes through the last hyphen, excluding the revision.
// Major/minor contract versions and literal file paths remain distinct.
const contracts = new Map(
  Object.entries(WINE_API_SET_SCHEMA).map(([name, target]) => [
    name.slice(0, name.lastIndexOf('-')),
    { name, target },
  ]),
);
export function apiSetContract(name) {
  const lower = name.toLowerCase().replace(/\.dll$/, '');
  if (!/^(?:api|ext)-[a-z0-9-]+-\d+$/.test(lower)) return;
  return contracts.get(lower.slice(0, lower.lastIndexOf('-')));
}

export function resolveApiSet(name) {
  return apiSetContract(name)?.target ?? name;
}
