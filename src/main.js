import './style.css';
import { audioQueueNeedsReset } from './audio-scheduling.js';
const $ = (id) => document.getElementById(id);
let worker,
  entries = [],
  audio,
  outputUrls = [],
  running = false,
  nextAudioTime = 0;
const activeTones = new Set();
function stopAudio() {
  for (const tone of activeTones) {
    try {
      tone.stop();
    } catch {}
  }
  activeTones.clear();
  nextAudioTime = 0;
  audio?.suspend();
}
const log = (text) => {
  $('logs').textContent = ($('logs').textContent + '\n' + text).slice(-24000);
};
const status = (text, state) => {
  $('status').textContent = text;
  $('state').textContent = state;
};
const capabilities = {
  isolated: crossOriginIsolated,
  wasm: typeof WebAssembly === 'object',
  workers: typeof Worker === 'function',
  sab: typeof SharedArrayBuffer === 'function',
  opfs: !!navigator.storage?.getDirectory,
  gpu: !!navigator.gpu,
};
$('platform').textContent = capabilities.isolated
  ? 'ISOLATED / WASM READY'
  : 'CROSS-ORIGIN ISOLATION MISSING';
log(JSON.stringify(capabilities));
function ready() {
  running = false;
  $('stop').disabled = true;
  select();
}
function select() {
  const item = entries.find((e) => e.path === $('exe').value);
  $('run').disabled = running || !item || !!item.error || !!item.pe?.unsupported.length;
  $('details').textContent = !item
    ? ''
    : item.error ||
      (item.pe.unsupported.length
        ? 'Missing APIs: ' + item.pe.unsupported.join(', ')
        : `${item.pe.imports.length} imports supported · x86 PE32 · ${(item.pe.imageSize / 1024).toFixed(0)} KB mapped image`);
}
function createWorker() {
  worker?.terminate();
  stopAudio();
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (e) => {
    log(e.message);
    status('Worker failed', 'ERROR');
    ready();
  };
  const instance = worker;
  worker.onmessage = async ({ data: m }) => {
    if (worker !== instance) return;
    if (m.type === 'loaded') {
      entries = m.executables;
      $('exe').replaceChildren(...entries.map((e) => new Option(e.path, e.path)));
      $('selection').hidden = false;
      status(`${m.files} files opened`, 'LOADED');
      ready();
    }
    if (m.type === 'stdout')
      $('output').textContent = ($('output').textContent + m.text).slice(-64000);
    if (m.type === 'log') log(m.text);
    if (m.type === 'error') {
      log(m.text);
      $('output').textContent += '\n' + m.text;
      status('Stopped: unsupported or invalid program', 'ERROR');
      ready();
    }
    if (m.type === 'request') {
      const source = instance;
      if (m.kind === 'messagebox') {
        $('dialog-title').textContent = m.title;
        $('dialog-text').textContent = m.text;
        $('messagebox').showModal();
        $('dialog-ok').onclick = () => {
          $('messagebox').close();
          source.postMessage({ type: 'reply', token: m.token, value: 1 });
        };
      }
      if (m.kind === 'beep') {
        let value = 0;
        if (audio?.state === 'running') {
          const osc = audio.createOscillator(),
            gain = audio.createGain();
          osc.frequency.value = m.frequency;
          gain.gain.value = 0.12;
          osc.connect(gain).connect(audio.destination);
          if (audioQueueNeedsReset(nextAudioTime, audio.currentTime))
            nextAudioTime = audio.currentTime;
          const start = Math.max(audio.currentTime, nextAudioTime);
          nextAudioTime = start + m.duration / 1000;
          activeTones.add(osc);
          {
            osc.start(start);
            osc.stop(start + m.duration / 1000);
            await new Promise((r) => (osc.onended = r));
            activeTones.delete(osc);
            osc.disconnect();
            gain.disconnect();
            value = 1;
          }
        }
        source.postMessage({ type: 'reply', token: m.token, value });
      }
    }
    if (m.type === 'done') {
      window.__lastRun = m;
      status(`Exited with code ${m.exitCode}`, 'EXITED');
      $('metrics').textContent =
        `${m.compiledBlocks} Wasm blocks · ${m.instructions} x86 instructions · ${m.apiCalls} API calls · ${m.elapsedMs.toFixed(1)} ms including host waits`;
      $('outputs').replaceChildren();
      for (const o of m.outputs) {
        const a = document.createElement('a');
        a.textContent = '↓ ' + o.path;
        a.download = o.path.split('/').at(-1);
        a.href = URL.createObjectURL(new Blob([o.bytes]));
        outputUrls.push(a.href);
        $('outputs').append(a);
      }
      ready();
    }
  };
}
async function load(file) {
  if (file.size > 64 * 1024 * 1024) {
    status('Package exceeds 64 MB', 'ERROR');
    return;
  }
  createWorker();
  entries = [];
  running = true;
  $('run').disabled = true;
  $('stop').disabled = false;
  $('selection').hidden = true;
  $('output').textContent = '';
  $('outputs').replaceChildren();
  outputUrls.forEach(URL.revokeObjectURL);
  outputUrls = [];
  window.__lastRun = null;
  status('Opening package…', 'LOADING');
  const source = worker;
  const bytes = await file.arrayBuffer();
  if (worker === source) source.postMessage({ type: 'load', name: file.name, bytes }, [bytes]);
}
$('file').onchange = () => {
  const selected = $('file').files[0];
  $('file').value = '';
  if (selected)
    load(selected).catch((e) => {
      log(e.message);
      ready();
    });
};
$('drop').ondragover = (e) => {
  e.preventDefault();
  $('drop').classList.add('drag');
};
$('drop').ondragleave = () => $('drop').classList.remove('drag');
$('drop').ondrop = (e) => {
  e.preventDefault();
  $('drop').classList.remove('drag');
  if (e.dataTransfer.files[0])
    load(e.dataTransfer.files[0]).catch((e) => {
      status(e.message, 'ERROR');
      ready();
    });
};
$('exe').onchange = select;
for (const button of document.querySelectorAll('[data-demo]'))
  button.onclick = async () => {
    try {
      const response = await fetch(`/demos/${button.dataset.demo}.zip`);
      if (!response.ok) throw Error('Demo package unavailable');
      await load(new File([await response.arrayBuffer()], button.dataset.demo + '.zip'));
    } catch (e) {
      status(e.message, 'ERROR');
      ready();
    }
  };
$('run').onclick = async () => {
  const source = worker;
  running = true;
  $('run').disabled = true;
  audio ??= new AudioContext();
  try {
    await audio.resume();
  } catch (e) {
    log('Audio unavailable: ' + e.message);
  }
  if (worker !== source) return;
  window.__lastRun = null;
  $('run').disabled = true;
  $('stop').disabled = false;
  $('output').textContent = '';
  status('Running in worker…', 'RUNNING');
  worker.postMessage({ type: 'run', exe: $('exe').value });
};
$('stop').onclick = () => {
  worker?.terminate();
  worker = null;
  entries = [];
  $('messagebox').close();
  $('selection').hidden = true;
  stopAudio();
  status('Worker terminated; reopen a package to restart', 'STOPPED');
  ready();
};
$('messagebox').addEventListener('cancel', (e) => e.preventDefault());

$('dialog-stop').onclick = () => $('stop').click();
