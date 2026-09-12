import './style.css';
import { audioQueueNeedsReset } from './audio-scheduling.js';

const $ = (id) => document.getElementById(id);
let worker,
  entries = [],
  audio,
  outputUrls = [],
  running = false;
let nextAudioTime = 0,
  loadWait,
  runWait,
  suiteMode = false,
  suiteAudioReady = false,
  manifest;
let stdout = '',
  requests = [];
const activeTones = new Set();

function log(text) {
  $('logs').textContent = ($('logs').textContent + '\n' + text).slice(-24000);
}
function status(text, state) {
  $('status').textContent = text;
  $('state').textContent = state;
}
function stopAudio(suspend = true) {
  for (const tone of activeTones) {
    try {
      tone.stop();
    } catch {}
  }
  activeTones.clear();
  nextAudioTime = 0;
  if (suspend) audio?.suspend();
}
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
        : `${item.pe.imports.length} imports supported · PE32 x86 · ${(item.pe.imageSize / 1024).toFixed(0)} KB image`);
}
function reply(source, message, value) {
  message.response = value;
  source.postMessage({ type: 'reply', token: message.token, value });
}

function createWorker() {
  worker?.terminate();
  stopAudio(false);
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const instance = worker;
  worker.onerror = (event) => {
    log(event.message);
    status('Worker failed', 'ERROR');
    loadWait?.reject(Error(event.message));
    runWait?.reject(Error(event.message));
    loadWait = runWait = null;
    ready();
  };
  worker.onmessage = async ({ data: message }) => {
    if (worker !== instance) return;
    if (message.type === 'loaded') {
      entries = message.executables;
      running = false;
      $('stop').disabled = true;
      $('exe').replaceChildren(...entries.map((item) => new Option(item.path, item.path)));
      $('selection').hidden = false;
      status(`${message.files} package files loaded`, 'LOADED');
      select();
      loadWait?.resolve(message);
      loadWait = null;
    }
    if (message.type === 'stdout') {
      stdout += message.text;
      $('output').textContent = stdout.slice(-64000);
    }
    if (message.type === 'frame') {
      const canvas = $('display');
      canvas.hidden = false;
      if (canvas.width !== message.width) canvas.width = message.width;
      if (canvas.height !== message.height) canvas.height = message.height;
      canvas
        .getContext('2d')
        .putImageData(new ImageData(message.pixels, message.width, message.height), 0, 0);
    }
    if (message.type === 'log') log(message.text);
    if (message.type === 'error') {
      log(message.text);
      $('output').textContent += `\n${message.text}`;
      status('Stopped: unsupported or invalid program', 'ERROR');
      loadWait?.reject(Error(message.text));
      runWait?.reject(Error(message.text));
      loadWait = runWait = null;
      ready();
    }
    if (message.type === 'request') {
      requests.push(message);
      if (message.kind === 'messagebox') {
        if (suiteMode) {
          reply(instance, message, 1);
        } else {
          $('dialog-title').textContent = message.title;
          $('dialog-text').textContent = message.text;
          $('messagebox').showModal();
          $('dialog-ok').onclick = () => {
            $('messagebox').close();
            reply(instance, message, 1);
          };
        }
      }
      if (message.kind === 'beep') {
        let value = 0;
        if ((suiteMode && suiteAudioReady) || (!suiteMode && $('audio-enabled').checked)) {
          audio ??= new AudioContext();
          if (audio.state !== 'running' && !suiteMode) {
            try {
              await audio.resume();
            } catch (error) {
              log('Audio unavailable: ' + error.message);
            }
          }
          if (audio.state === 'running') {
            const oscillator = audio.createOscillator();
            const gain = audio.createGain();
            oscillator.frequency.value = message.frequency;
            gain.gain.value = suiteMode ? 0 : 0.12;
            oscillator.connect(gain).connect(audio.destination);
            if (audioQueueNeedsReset(nextAudioTime, audio.currentTime))
              nextAudioTime = audio.currentTime;
            const start = Math.max(audio.currentTime, nextAudioTime);
            nextAudioTime = start + message.duration / 1000;
            activeTones.add(oscillator);
            oscillator.start(start);
            oscillator.stop(start + message.duration / 1000);
            await new Promise((resolve) => (oscillator.onended = resolve));
            activeTones.delete(oscillator);
            oscillator.disconnect();
            gain.disconnect();
            value = 1;
          }
        }
        reply(instance, message, value);
      }
      if (message.kind === 'pcm') {
        let value = 0;
        if ((suiteMode && suiteAudioReady) || (!suiteMode && $('audio-enabled').checked)) {
          audio ??= new AudioContext();
          try {
            await audio.resume();
            if (audio.state === 'running') {
              const buffer = audio.createBuffer(
                message.samples.length,
                message.frames,
                message.sampleRate,
              );
              message.samples.forEach((samples, channel) => buffer.copyToChannel(samples, channel));
              const source = audio.createBufferSource(),
                gain = audio.createGain();
              source.buffer = buffer;
              gain.gain.value = suiteMode ? 0 : 1;
              source.connect(gain).connect(audio.destination);
              activeTones.add(source);
              const ended = new Promise((resolve) => (source.onended = resolve));
              source.start();
              await ended;
              activeTones.delete(source);
              source.disconnect();
              gain.disconnect();
              value = 1;
            }
          } catch (error) {
            log('PCM playback unavailable: ' + error.message);
          }
        }
        reply(instance, message, value);
      }
    }
    if (message.type === 'done') {
      window.__lastRun = message;
      status(`Exited with code ${message.exitCode}`, 'EXITED');
      $('metrics').textContent =
        `${message.compiledBlocks} Wasm blocks · ${message.instructions} x86 instructions · ${message.apiCalls} API calls · ${message.elapsedMs.toFixed(1)} ms`;
      $('outputs').replaceChildren();
      for (const output of message.outputs) {
        const link = document.createElement('a');
        link.textContent = `Download ${output.path}`;
        link.download = output.path.split('/').at(-1);
        link.href = URL.createObjectURL(new Blob([output.bytes]));
        outputUrls.push(link.href);
        $('outputs').append(link);
      }
      ready();
      runWait?.resolve(message);
      runWait = null;
    }
  };
}

async function load(file) {
  if (file.size > 64 * 1024 * 1024) throw Error('Package exceeds 64 MB');
  createWorker();
  entries = [];
  running = true;
  $('run').disabled = true;
  $('stop').disabled = true;
  $('selection').hidden = true;
  $('output').textContent = '';
  $('outputs').replaceChildren();
  outputUrls.forEach(URL.revokeObjectURL);
  outputUrls = [];
  stdout = '';
  requests = [];
  window.__lastRun = null;
  $('display').hidden = true;
  status('Opening package…', 'LOADING');
  const loaded = new Promise((resolve, reject) => {
    loadWait = { resolve, reject };
  });
  const bytes = await file.arrayBuffer();
  if (worker) worker.postMessage({ type: 'load', name: file.name, bytes }, [bytes]);
  return loaded;
}

async function runCurrent(args = []) {
  const source = worker;
  if (!source || !$('exe').value) throw Error('Load a package and select an executable first');
  running = true;
  $('run').disabled = true;
  $('stop').disabled = false;
  window.__lastRun = null;
  $('display').hidden = true;
  stdout = '';
  requests = [];
  $('output').textContent = '';
  status('Running in worker…', 'RUNNING');
  const completed = new Promise((resolve, reject) => {
    runWait = { resolve, reject };
  });
  source.postMessage({ type: 'run', exe: $('exe').value, args });
  return completed;
}

async function loadSelected(file) {
  try {
    await load(file);
  } catch (error) {
    log(error.message);
    status(error.message, 'ERROR');
    ready();
  }
}
$('file').onchange = () => {
  const file = $('file').files[0];
  $('file').value = '';
  if (file) loadSelected(file);
};
$('drop').ondragover = (event) => {
  event.preventDefault();
  $('drop').classList.add('drag');
};
$('drop').ondragleave = () => $('drop').classList.remove('drag');
$('drop').ondrop = (event) => {
  event.preventDefault();
  $('drop').classList.remove('drag');
  if (event.dataTransfer.files[0]) loadSelected(event.dataTransfer.files[0]);
};
$('exe').onchange = select;
function readArgs() {
  let args;
  try {
    args = JSON.parse($('args').value);
  } catch {
    throw Error('Arguments must be valid JSON');
  }
  if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string'))
    throw Error('Arguments must be a JSON array of strings');
  return args;
}
async function prepareAudio() {
  if (!$('audio-enabled').checked) return;
  audio ??= new AudioContext();
  try {
    await audio.resume();
  } catch (error) {
    log('Audio unavailable: ' + error.message);
  }
}
$('run').onclick = async () => {
  await prepareAudio();
  try {
    await runCurrent(readArgs());
  } catch (error) {
    log(error.message);
    status(error.message, 'ERROR');
    ready();
  }
};
$('stop').onclick = () => {
  worker?.terminate();
  worker = null;
  entries = [];
  $('messagebox').close();
  $('selection').hidden = true;
  stopAudio();
  runWait?.resolve(null);
  loadWait?.reject(Error('Stopped'));
  runWait = loadWait = null;
  status('Worker terminated; reopen a package to restart', 'STOPPED');
  ready();
};
$('messagebox').addEventListener('cancel', (event) => event.preventDefault());
$('dialog-stop').onclick = () => $('stop').click();

function bytesEqual(actual, expected) {
  const a = actual instanceof Uint8Array ? actual : new Uint8Array(actual);
  const b = expected instanceof Uint8Array ? expected : new TextEncoder().encode(expected);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
async function expectedStdout(fixture) {
  const expected = fixture.expected.stdout;
  if (expected !== undefined) return expected;
  if (fixture.expected.stdoutFrom) {
    const asset = fixture.expected.stdoutFrom.split(/\s+/)[0];
    const directory = fixture.exe.split('/').slice(0, -1).join('/');
    const response = await fetch(`${import.meta.env.BASE_URL}demos/${directory}/${asset}`);
    if (!response.ok) throw Error(`Expected stdout asset unavailable: ${asset}`);
    return new TextDecoder().decode(await response.arrayBuffer());
  }
  return undefined;
}
async function compareFixture(fixture, result, text, events) {
  const expected = fixture.expected;
  const checks = [];
  const check = (label, passed) => {
    checks.push(`${passed ? 'PASS' : 'FAIL'} ${label}`);
  };
  if (expected.exitCode !== undefined)
    check(`exit ${expected.exitCode}`, result.exitCode === expected.exitCode);
  const stdoutExpected = await expectedStdout(fixture);
  if (stdoutExpected !== undefined)
    check('stdout bytes', bytesEqual(new TextEncoder().encode(text), stdoutExpected));
  if (expected.createdFiles) {
    const actualFiles = new Map(
      result.outputs.map((output) => [output.path.split('/').at(-1), output.bytes]),
    );
    const names = Object.keys(expected.createdFiles);
    check(
      'output file set',
      names.length === actualFiles.size && names.every((name) => actualFiles.has(name)),
    );
    for (const [name, contents] of Object.entries(expected.createdFiles))
      check(`${name} bytes`, actualFiles.has(name) && bytesEqual(actualFiles.get(name), contents));
  }
  if (expected.messageBoxA) {
    const dialogs = events.filter((event) => event.kind === 'messagebox');
    const value = dialogs[0];
    check(
      'MessageBoxA args',
      dialogs.length === 1 &&
        value?.title === expected.messageBoxA.title &&
        value?.text === expected.messageBoxA.text,
    );
  }
  if (expected.beepHz !== undefined || expected.beepMilliseconds !== undefined) {
    const beeps = events.filter((event) => event.kind === 'beep');
    const value = beeps[0];
    check(
      'Beep parameters + host success',
      beeps.length === 1 &&
        value?.frequency === expected.beepHz &&
        value?.duration === expected.beepMilliseconds &&
        value?.response === 1,
    );
  }
  if (fixture.exeSha256) {
    const path = `${import.meta.env.BASE_URL}demos/${fixture.exe}`;
    const response = await fetch(path);
    if (!response.ok) throw Error(`Fixture executable unavailable: ${fixture.exe}`);
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer())),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    check('fixture SHA-256', digest === fixture.exeSha256);
  }
  return checks;
}

async function runSuite() {
  if (!manifest || running) return;
  suiteMode = true;
  try {
    audio ??= new AudioContext();
    await audio.resume();
    suiteAudioReady = audio.state === 'running';
  } catch (error) {
    log('Muted WebAudio test unavailable: ' + error.message);
  }
  $('run-suite').disabled = true;
  $('suite-results').replaceChildren();
  $('suite-status').textContent = `Running ${manifest.fixtures.length} fixtures`;
  const allPassed = [];
  try {
    for (const fixture of manifest.fixtures) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = fixture.name;
      const resultCell = document.createElement('td');
      resultCell.textContent = 'RUNNING';
      const checksCell = document.createElement('td');
      checksCell.textContent = '';
      row.append(name, resultCell, checksCell);
      $('suite-results').append(row);
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}demos/${fixture.zip}`);
        if (!response.ok) throw Error(`Fixture package missing: ${fixture.zip}`);
        const packageBytes = await response.arrayBuffer();
        if (fixture.zipSha256) {
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', packageBytes))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
          if (digest !== fixture.zipSha256)
            throw Error('Fixture ZIP SHA-256 differs from manifest');
        }
        await load(new File([packageBytes], fixture.zip));
        if (!entries.some((item) => item.path === fixture.exe))
          throw Error(`Executable missing: ${fixture.exe}`);
        $('exe').value = fixture.exe;
        select();
        const args = fixture.args ?? [];
        if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string'))
          throw Error('Fixture args must be an array of strings');
        const runResult = await runCurrent(args);
        if (!runResult) throw Error('Execution stopped');
        const checks = await compareFixture(fixture, runResult, stdout, requests);
        const failed = checks.some((line) => line.startsWith('FAIL'));
        checksCell.textContent = checks.join(' · ') || 'No expected outputs in manifest';
        resultCell.textContent = failed ? 'FAIL' : 'PASS';
        resultCell.className = failed ? 'fail' : 'pass';
        allPassed.push(!failed);
      } catch (error) {
        resultCell.textContent = 'FAIL';
        resultCell.className = 'fail';
        checksCell.textContent = error.message;
        allPassed.push(false);
        log(`${fixture.name}: ${error.message}`);
      }
    }
    const passed = allPassed.filter(Boolean).length;
    $('suite-status').textContent = `${passed}/${allPassed.length} passed`;
  } finally {
    suiteMode = false;
    suiteAudioReady = false;
    if (audio) audio.suspend();
    $('run-suite').disabled = false;
    ready();
  }
}
$('run-suite').onclick = runSuite;

async function initialize() {
  const capabilities = {
    isolated: crossOriginIsolated,
    wasm: typeof WebAssembly === 'object',
    workers: typeof Worker === 'function',
    sab: typeof SharedArrayBuffer === 'function',
    opfs: !!navigator.storage?.getDirectory,
  };
  $('platform').textContent = capabilities.isolated ? 'ISOLATED / WASM READY' : 'ISOLATION MISSING';
  log(JSON.stringify(capabilities));
  const response = await fetch(`${import.meta.env.BASE_URL}demos/manifest.json`);
  if (!response.ok) throw Error('Fixture manifest unavailable');
  manifest = await response.json();
  $('demos').replaceChildren(
    ...manifest.fixtures.map((fixture) => {
      const button = document.createElement('button');
      button.textContent = `Load ${fixture.name}`;
      button.dataset.demo = fixture.name;
      button.onclick = async () => {
        try {
          const packageResponse = await fetch(`${import.meta.env.BASE_URL}demos/${fixture.zip}`);
          if (!packageResponse.ok) throw Error(`Fixture package unavailable: ${fixture.zip}`);
          await load(new File([await packageResponse.arrayBuffer()], fixture.zip));
        } catch (error) {
          status(error.message, 'ERROR');
          log(error.message);
          ready();
        }
      };
      return button;
    }),
  );
}
initialize()
  .then(() => {
    $('run-suite').disabled = false;
  })
  .catch((error) => {
    status(error.message, 'ERROR');
    log(error.message);
  });
