import { buildDialog, readDialogTemplate } from './win32-dialogs.js';
import { registerHostWindowProcedure, windowApis } from './win32-windows.js';
import { readPEResource } from './pe-resources.js';
import { decodeAnsi, encodeAnsi } from './encoding.js';
const DOWN = 1,
  WHOLE = 2,
  MATCH = 4,
  NEXT = 8,
  REPLACE = 16,
  ALL = 32,
  TERM = 64;
const HELP = 128,
  HOOK = 256,
  TEMPLATE = 512,
  HANDLE = 8192;
const SUPPORTED = 0x1ffff,
  RETURNS = 0x7f;
const FIND = 1152,
  REPLACEMENT = 1153,
  WHOLE_CHECK = 1040,
  MATCH_CHECK = 1041,
  UP = 1056,
  DOWN_RADIO = 1057,
  DIRECTION = 1072,
  HELP_BUTTON = 1038;
const ok = (result = 0) => ({ result: result >>> 0, argc: 1 });
function fail(r, common, win32 = 87) {
  r.commonDialogError = common;
  r.lastError = win32;
  return ok();
}
const child = (r, id, control) =>
  [...r.windows.windows.values()].find((w) => w.parentId === id && w.controlId === control);
function boundedString(r, pointer, capacity, wide) {
  r.check(pointer, capacity * (wide ? 2 : 1), true);
  for (let i = 0; i < capacity; i++) {
    const code = wide ? r.view.getUint16(pointer + i * 2, true) : r.data[pointer + i];
    if (!code) {
      if (!wide) return decodeAnsi(r.data.subarray(pointer, pointer + i));
      let value = '';
      for (let k = 0; k < i; k++)
        value += String.fromCharCode(r.view.getUint16(pointer + k * 2, true));
      return value;
    }
  }
  throw Error('Unterminated Find/Replace buffer');
}
function writeBuffer(r, pointer, capacity, value, wide) {
  r.check(pointer, capacity * (wide ? 2 : 1), true);
  if (wide) {
    value = value.slice(0, capacity - 1);
    for (let i = 0; i <= value.length; i++)
      r.view.setUint16(pointer + i * 2, i === value.length ? 0 : value.charCodeAt(i), true);
  } else {
    const bytes = encodeAnsi(value).bytes.subarray(0, capacity - 1);
    r.data.set(bytes, pointer);
    r.data[pointer + bytes.length] = 0;
  }
}
function standardTemplate(replace) {
  const items = [];
  const add = (className, id, text, x, y, width, height, style = 0x50010000) =>
    items.push({ className, id, text, x, y, width, height, style, exStyle: 0 });
  add('STATIC', -1, 'Find what:', 8, 10, 60, 12, 0x50000000);
  add('EDIT', FIND, '', 70, 8, 140, 14, 0x50810080);
  if (replace) {
    add('STATIC', -1, 'Replace with:', 8, 32, 60, 12, 0x50000000);
    add('EDIT', REPLACEMENT, '', 70, 30, 140, 14, 0x50810080);
  }
  add('BUTTON', 1, 'Find Next', 220, 8, 70, 16, 0x50010001);
  if (replace) {
    add('BUTTON', 1024, 'Replace', 220, 30, 70, 16);
    add('BUTTON', 1025, 'Replace All', 220, 52, 70, 16);
  }
  add('BUTTON', 2, 'Cancel', 220, replace ? 74 : 30, 70, 16);
  add('BUTTON', HELP_BUTTON, 'Help', 220, replace ? 96 : 52, 70, 16);
  const y = replace ? 56 : 34;
  add('BUTTON', WHOLE_CHECK, 'Match whole word', 8, y, 112, 14, 0x50010003);
  add('BUTTON', MATCH_CHECK, 'Match case', 8, y + 20, 112, 14, 0x50010003);
  if (!replace) {
    add('BUTTON', DIRECTION, 'Direction', 128, 32, 82, 50, 0x50000007);
    add('BUTTON', UP, 'Up', 134, 46, 30, 14, 0x50030009);
    add('BUTTON', DOWN_RADIO, 'Down', 170, 46, 38, 14, 0x50010009);
  }
  return {
    title: replace ? 'Replace' : 'Find',
    x: 30,
    y: 30,
    cx: 300,
    cy: replace ? 120 : 90,
    style: 0x80c800c0,
    exStyle: 0,
    className: '',
    items,
  };
}
async function updateActions(r, state) {
  const enabled = !!child(r, state.id, FIND)?.title;
  for (const id of [1, ...(state.replace ? [1024, 1025] : [])]) {
    const button = child(r, state.id, id);
    if (button && button.enabled !== enabled) {
      button.enabled = enabled;
      r.windows.emit(button);
    }
  }
}
function options(r, state) {
  const checked = (id) => child(r, state.id, id)?.checkState === 1;
  return (
    (state.replace || checked(DOWN_RADIO) ? DOWN : 0) |
    (checked(WHOLE_CHECK) ? WHOLE : 0) |
    (checked(MATCH_CHECK) ? MATCH : 0)
  );
}
async function notify(r, state, action) {
  if (state.terminating) return;
  const flags = (r.read32(state.pointer + 12) & ~RETURNS) | options(r, state) | action;
  r.write32(state.pointer + 12, flags);
  if (action === TERM) state.terminating = true;
  if (r.windows.windows.has(state.owner))
    await r.windows.send(state.owner, state.message, 0, state.pointer);
}
async function procedure(r, a, wide) {
  const id = a(0),
    message = a(1),
    wp = a(2),
    lp = a(3),
    window = r.windows.windows.get(id),
    state = window?.findReplace;
  const defaultProc = () => windowApis[`user32.dll!DefWindowProc${wide ? 'W' : 'A'}`](r, a);
  if (!state) return defaultProc();
  if (message === 0x110) return { result: 1, argc: 4 };
  if (state.hook) {
    const handled = await r.callGuest(state.hook, [id, message, wp, lp]);
    if (handled && message !== 2) return { result: handled, argc: 4 };
  }
  if (message === 0x111) {
    const control = wp & 0xffff,
      code = wp >>> 16;
    if (control === FIND && code === 0x300) {
      await updateActions(r, state);
      return { result: 1, argc: 4 };
    }
    if (code === 0) {
      if (control === 2) {
        await notify(r, state, TERM);
        if (r.windows.windows.has(id)) await r.windows.destroy(id);
        return { result: 1, argc: 4 };
      }
      if ([1, 1024, 1025].includes(control)) {
        const value = child(r, id, FIND)?.title ?? '';
        if (value && (control === 1 || state.replace)) {
          writeBuffer(r, state.find, state.findLength, value, state.wide);
          if (control !== 1)
            writeBuffer(
              r,
              state.replacement,
              state.replaceLength,
              child(r, id, REPLACEMENT)?.title ?? '',
              state.wide,
            );
          await notify(r, state, control === 1 ? NEXT : control === 1024 ? REPLACE : ALL);
        }
        return { result: 1, argc: 4 };
      }
      if (control === HELP_BUTTON && state.flags & HELP) {
        r.write32(
          state.pointer + 12,
          (r.read32(state.pointer + 12) & ~RETURNS) | options(r, state),
        );
        await r.windows.send(state.owner, state.helpMessage, id, state.pointer);
        return { result: 1, argc: 4 };
      }
    }
  }
  if (message === 0x10) {
    await r.windows.send(id, 0x111, 2, 0);
    return { result: 1, argc: 4 };
  }
  if (message === 2) {
    state.terminating = true;
    return { result: 0, argc: 4 };
  }
  return defaultProc();
}
async function registerClass(r, wide) {
  const name = `WineBrowserFindDialog${wide ? 'W' : 'A'}`,
    key = name.toLowerCase();
  if (r.windows.classes.has(key)) return name;
  const proc = registerHostWindowProcedure(r, `find-replace:${wide}`, {
    kind: 'window-proc',
    name,
    wide,
    invoke: (r, a) => procedure(r, a, wide),
  });
  const p = r.allocate(40),
    text = r.allocString(name, wide);
  try {
    r.data.fill(0, p, p + 40);
    r.write32(p + 4, proc);
    r.write32(p + 12, 30);
    r.write32(p + 16, r.pe.imageBase);
    r.write32(p + 28, 16);
    r.write32(p + 36, text);
    const result = windowApis[`user32.dll!RegisterClass${wide ? 'W' : 'A'}`](r, () => p);
    if (!result.result) throw Error('Find dialog class registration failed');
  } finally {
    r.free(p);
    r.free(text);
  }
  return name;
}
export async function createFindDialog(r, a, wide, replace) {
  r.commonDialogError = 0;
  const pointer = a(0) >>> 0;
  if (!pointer) return fail(r, 2);
  r.check(pointer, 4);
  if (r.read32(pointer) !== 40) return fail(r, 1);
  r.check(pointer, 40, true);
  const owner = r.read32(pointer + 4),
    instance = r.read32(pointer + 8),
    flags = r.read32(pointer + 12),
    find = r.read32(pointer + 16),
    replacement = r.read32(pointer + 20);
  const findLength = r.view.getUint16(pointer + 24, true),
    replaceLength = r.view.getUint16(pointer + 26, true),
    hook = flags & HOOK ? r.read32(pointer + 32) : 0;
  if (!owner || !r.windows.windows.has(owner)) return fail(r, 0xffff, 1400);
  if (!find || !findLength || (replace && (!replacement || !replaceLength))) return fail(r, 0x4001);
  if (flags & ~SUPPORTED) return fail(r, 2, 120);
  if (flags & HOOK && !hook) return fail(r, 11);
  let findText,
    replaceText = '';
  try {
    findText = boundedString(r, find, findLength, wide);
    if (replace) replaceText = boundedString(r, replacement, replaceLength, wide);
  } catch {
    return fail(r, 0x4001);
  }
  let template = standardTemplate(replace);
  if (flags & HANDLE) {
    if (!instance) return fail(r, 4);
    // Global memory handles currently alias the allocated guest address, as
    // GlobalLock does. Parse a bounded copy; ownership stays with the caller.
    const size = r.allocationSize(instance);
    if (!size) return fail(r, 7, 6);
    r.check(instance, size);
    template = readDialogTemplate(r.data.slice(instance, instance + Math.min(size, 0x10000)));
    if (!template) return fail(r, 6);
  } else if (flags & TEMPLATE) {
    if (!instance) return fail(r, 4);
    const module = [...r.graph.modules.values()].find((m) => m.base === instance),
      p = r.read32(pointer + 36);
    if (!p) return fail(r, 3);
    const name = p <= 0xffff ? p : wide ? r.wideString(p) : r.string(p);
    const bytes = module ? readPEResource(module.bytes, 5, name) : null;
    template = bytes ? readDialogTemplate(bytes) : null;
    if (!template) return fail(r, 6);
  }
  const className = await registerClass(r, wide),
    cls = r.windows.classes.get(className.toLowerCase());
  if (!template.className || ['#32770', 32770, 0x8002].includes(template.className))
    template = { ...template, className };
  const built = await buildDialog(r, template, owner, cls.proc, instance || r.pe.imageBase, wide);
  if (built.error) return fail(r, 0xffff, built.error);
  const window = r.windows.windows.get(built.dialog.id),
    state = {
      id: window.id,
      pointer,
      owner,
      flags,
      find,
      replacement,
      findLength,
      replaceLength,
      wide,
      replace,
      hook,
      terminating: false,
      message: r.windows.registerWindowMessage('commdlg_FindReplace'),
      helpMessage: r.windows.registerWindowMessage('commdlg_help'),
    };
  window.findReplace = state;
  if (!child(r, state.id, FIND) || (replace && !child(r, state.id, REPLACEMENT))) {
    state.terminating = true;
    await r.windows.destroy(state.id);
    return fail(r, 6);
  }
  const setText = (id, value, length) => {
    const control = child(r, state.id, id);
    control.title = value;
    control.textLimit = Math.min(32767, length - 1);
    r.windows.emit(control);
  };
  setText(FIND, findText, findLength);
  if (replace) setText(REPLACEMENT, replaceText, replaceLength);
  const set = (id, checked, hide, disabled) => {
    const control = child(r, state.id, id);
    if (!control) return;
    control.checkState = checked ? 1 : 0;
    control.visible = !hide;
    control.enabled = !disabled;
    r.windows.emit(control);
  };
  set(WHOLE_CHECK, flags & WHOLE, flags & 0x10000, flags & 0x1000);
  set(MATCH_CHECK, flags & MATCH, flags & 0x8000, flags & 0x800);
  set(UP, !(flags & DOWN), flags & 0x4000, flags & 0x400);
  set(DOWN_RADIO, flags & DOWN, flags & 0x4000, flags & 0x400);
  set(DIRECTION, false, flags & 0x4000, flags & 0x400);
  set(HELP_BUTTON, false, !(flags & HELP), false);
  await updateActions(r, state);
  const first = child(r, state.id, FIND).id;
  const defaultFocus = hook ? await r.callGuest(hook, [state.id, 0x110, first, pointer]) : 1;
  if (!r.windows.windows.has(state.id)) return ok(0);
  await windowApis['user32.dll!ShowWindow'](r, (i) => [state.id, 5][i]);
  if (defaultFocus) await r.windows.setFocus(first);
  return ok(state.id);
}
export const findDialogApis = {
  'comdlg32.dll!FindTextA': (r, a) => createFindDialog(r, a, false, false),
  'comdlg32.dll!FindTextW': (r, a) => createFindDialog(r, a, true, false),
  'comdlg32.dll!ReplaceTextA': (r, a) => createFindDialog(r, a, false, true),
  'comdlg32.dll!ReplaceTextW': (r, a) => createFindDialog(r, a, true, true),
};
