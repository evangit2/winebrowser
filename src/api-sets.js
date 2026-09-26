// UCRT contract destinations from Wine db11d0fe6a169c457e23d007e20404643d067aa8,
// dlls/apisetschema/apisetschema.spec. Contracts alias a real DLL; they do not
// supply implementations or fabricate successful calls when it is unavailable.
const CRT_CONTRACTS = new Set(
  'conio convert environment filesystem heap locale math multibyte private process runtime stdio string time utility'
    .split(' ')
    .map((name) => `api-ms-win-crt-${name}-l1-1-0.dll`),
);

export function resolveApiSet(name) {
  return CRT_CONTRACTS.has(name.toLowerCase()) ? 'ucrtbase.dll' : name;
}
