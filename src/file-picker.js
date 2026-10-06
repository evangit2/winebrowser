import { normalizePath } from './package.js';
import {
  OFN,
  baseName,
  parentPath,
  matchesFileFilter,
  fileDialogDirectories,
  fileDialogSelection,
  fileDialogPathLabel,
} from './file-dialog-model.js';
let pending = Promise.resolve();
export function showFilePicker(dialog, request, active = () => true, stop = () => {}) {
  const result = pending.then(() => {
    if (!active()) return null;
    return new Promise((resolve) => {
      const field = (name) => dialog.querySelector(`#file-picker-${name}`);
      const files = request.files.map((f) => ({ ...f })),
        imports = [];
      let directories = request.directories.slice(),
        answer = null,
        selectedNames = [],
        confirmed = false,
        generation = 0,
        closed = false;
      dialog.dataset.requestToken = String(request.token);
      dialog.style.resize = request.flags & 0x800000 ? 'both' : 'none';
      field('title').textContent = request.title;
      field('ok').textContent = request.save ? 'Save' : 'Open';
      field('name').value = request.initial;
      field('filter').replaceChildren(...request.filters.map((f) => new Option(f.label, f.index)));
      field('filter').value = request.filters.some((f) => f.index === request.filterIndex)
        ? request.filterIndex
        : request.filters[0].index;
      field('readonly').checked = !!(request.flags & OFN.READONLY);
      field('readonly-label').hidden = request.save || !!(request.flags & OFN.HIDEREADONLY);
      field('import').value = '';
      field('import').multiple = !request.save && !!(request.flags & OFN.ALLOWMULTISELECT);
      field('error').textContent = '';
      field('confirmation').hidden = true;
      const invalidate = () => {
        confirmed = false;
        field('confirmation').hidden = true;
        field('error').textContent = '';
      };
      function renderDirectories(directory) {
        field('directory').replaceChildren(
          ...directories.map((p) => new Option(fileDialogPathLabel(p), p)),
        );
        field('directory').value = directories.includes(directory) ? directory : '';
      }
      function renderFiles() {
        const directory = field('directory').value,
          pattern =
            request.filters.find((f) => f.index === +field('filter').value)?.pattern ?? '*.*';
        const list = field('list');
        list.replaceChildren();
        list.multiple = !request.save && !!(request.flags & OFN.ALLOWMULTISELECT);
        for (const dir of directories.filter((p) => p && parentPath(p) === directory)) {
          const option = new Option('📁 ' + baseName(dir), dir);
          option.dataset.directory = 'true';
          list.add(option);
        }
        for (const file of files
          .filter(
            (f) => parentPath(f.path) === directory && matchesFileFilter(baseName(f.path), pattern),
          )
          .sort((a, b) => a.path.localeCompare(b.path)))
          list.add(new Option(baseName(file.path), file.path));
        selectedNames = [];
      }
      field('directory').onchange = () => {
        invalidate();
        renderFiles();
      };
      field('filter').onchange = () => {
        invalidate();
        renderFiles();
      };
      field('name').oninput = () => {
        invalidate();
        selectedNames = [];
      };
      field('list').onchange = () => {
        invalidate();
        const options = [...field('list').selectedOptions].filter((o) => !o.dataset.directory);
        selectedNames = options.map((o) => baseName(o.value));
        field('name').value =
          selectedNames.length > 1
            ? selectedNames.map((s) => `"${s}"`).join(' ')
            : (selectedNames[0] ?? '');
      };
      field('list').ondblclick = () => {
        const item = field('list').selectedOptions[0];
        if (item?.dataset.directory) {
          field('directory').value = item.value;
          invalidate();
          renderFiles();
        } else field('form').requestSubmit();
      };
      field('up').onclick = () => {
        field('directory').value = parentPath(field('directory').value);
        invalidate();
        renderFiles();
      };
      field('import').onchange = async () => {
        // The dialog element is reused. An event queued for a dismissed
        // picker can start after a new picker opens; its generation counter
        // alone cannot distinguish the new element's open state.
        if (closed || !active() || !dialog.open) return;
        const current = ++generation,
          browserFiles = [...field('import').files];
        field('ok').disabled = true;
        try {
          if (
            imports.length + browserFiles.length > 2048 ||
            imports.reduce((n, f) => n + f.bytes.length, 0) +
              browserFiles.reduce((n, f) => n + f.size, 0) >
              128 * 1024 * 1024
          )
            throw Error('Select at most 2,048 files totaling 128 MiB.');
          const staged = [];
          const used = new Set(files.map((f) => f.path));
          for (const file of browserFiles) {
            if (/[\\/:\0<>"|?*]/.test(file.name) || !file.name.trim())
              throw Error('Invalid file name.');
            let path = request.importPrefix + normalizePath(file.name),
              count = 1;
            while (used.has(path))
              path = request.importPrefix + `${++count}-` + normalizePath(file.name);
            used.add(path);
            staged.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
          }
          if (closed || !active() || !dialog.open || generation !== current) return;
          imports.push(...staged);
          files.push(...staged.map((f) => ({ path: f.path, size: f.bytes.length })));
          directories = fileDialogDirectories(files, request.directories);
          renderDirectories(request.importPrefix.slice(0, -1));
          renderFiles();
          selectedNames = staged.map((f) => baseName(f.path));
          for (const option of field('list').options)
            option.selected = staged.some((f) => f.path === option.value);
          field('name').value =
            selectedNames.length > 1
              ? selectedNames.map((s) => `"${s}"`).join(' ')
              : (selectedNames[0] ?? '');
          invalidate();
        } catch (e) {
          if (!closed && active() && dialog.open) field('error').textContent = e.message;
        } finally {
          if (!closed && generation === current) field('ok').disabled = false;
        }
      };
      function submit() {
        if (closed || !active() || !dialog.open) return;
        const folder = [...field('list').selectedOptions].find((o) => o.dataset.directory);
        if (folder && !field('name').value) {
          field('directory').value = folder.value;
          invalidate();
          renderFiles();
          return;
        }
        const value = {
          directory: field('directory').value,
          names: selectedNames.length ? selectedNames : [field('name').value],
          filterIndex: +field('filter').value,
          readonly: field('readonly').checked,
          imports,
          confirmed,
        };
        const result = fileDialogSelection(request, value, files, directories);
        if (result.error) {
          field('error').textContent = result.error;
          return;
        }
        if (result.confirmation && !confirmed) {
          field('confirmation').hidden = false;
          field('confirm-text').textContent = result.confirmation;
          field('confirm-yes').focus();
          return;
        }
        answer = value;
        dialog.close();
      }
      field('form').onsubmit = (event) => {
        event.preventDefault();
        submit();
      };
      field('confirm-yes').onclick = () => {
        confirmed = true;
        submit();
      };
      field('confirm-no').onclick = () => {
        invalidate();
        field('name').focus();
      };
      field('cancel').onclick = () => dialog.close();
      field('stop').onclick = () => {
        dialog.close();
        stop();
      };
      dialog.oncancel = (e) => {
        e.preventDefault();
        dialog.close();
      };
      dialog.onclose = () => {
        closed = true;
        generation++;
        resolve(answer);
      };
      field('ok').disabled = false;
      renderDirectories(request.directory);
      renderFiles();
      dialog.showModal();
      field('name').focus();
      field('name').select();
    });
  });
  pending = result.catch(() => null);
  return result;
}
