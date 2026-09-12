import './desktop.css';

const TITLEBAR_HEIGHT = 28;
const MIN_CLIENT_WIDTH = 64;
const MIN_CLIENT_HEIGHT = 48;

/**
 * A small DOM-backed virtual desktop for displaying guest windows and routing
 * their input events to the runtime.
 */
export class VirtualDesktop {
  constructor(container, onInput = () => {}) {
    if (!(container instanceof HTMLElement))
      throw new TypeError('Desktop container must be an element');
    if (typeof onInput !== 'function')
      throw new TypeError('Desktop input handler must be a function');

    this.container = container;
    this.onInput = onInput;
    this.windows = new Map();
    this.activeWindowId = null;
    this.nextZIndex = 1;
    this.drag = null;

    container.classList.add('virtual-desktop');
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    container.addEventListener('keydown', this.onKeyDown);
    container.addEventListener('keyup', this.onKeyUp);
  }

  onKeyDown = (event) => this.#sendKey(event, 'keydown');
  onKeyUp = (event) => this.#sendKey(event, 'keyup');

  #sendKey(event, type) {
    if (this.activeWindowId === null || event.isComposing) return;
    this.onInput({
      windowId: this.activeWindowId,
      type,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode || event.which || 0,
      repeat: event.repeat,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
    if (event.key.startsWith('Arrow') || event.key === ' ') event.preventDefault();
  }

  #emit(windowId, type, values = {}) {
    this.onInput({ windowId, type, ...values });
  }

  #focus(window) {
    this.container.focus({ preventScroll: true });
    if (this.activeWindowId === window.id) return;
    this.activeWindowId = window.id;
    window.element.style.zIndex = String(++this.nextZIndex);
    for (const other of this.windows.values())
      other.element.classList.toggle('is-focused', other === window);
    this.#emit(window.id, 'focus');
  }

  #applyGeometry(window) {
    window.element.style.left = `${window.x}px`;
    window.element.style.top = `${window.y}px`;
    window.element.style.width = `${window.width + 2}px`;
    window.element.style.height = `${window.height + TITLEBAR_HEIGHT + 2}px`;
    window.viewport.style.width = `${window.width}px`;
    window.viewport.style.height = `${window.height}px`;
  }

  #createWindow(state) {
    const element = document.createElement('section');
    element.className = 'virtual-desktop-window';
    element.dataset.windowId = String(state.id);

    const titlebar = document.createElement('header');
    titlebar.className = 'virtual-desktop-titlebar';

    const title = document.createElement('span');
    title.className = 'virtual-desktop-title';
    title.textContent = state.title ?? String(state.id);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'virtual-desktop-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${title.textContent}`);
    close.addEventListener('pointerdown', (event) => event.stopPropagation());
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.#focus(window);
      this.#emit(window.id, 'close');
    });

    titlebar.append(title, close);

    const viewport = document.createElement('div');
    viewport.className = 'virtual-desktop-viewport';

    const canvas = document.createElement('canvas');
    canvas.className = 'virtual-desktop-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', `${title.textContent} guest display`);
    viewport.append(canvas);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'virtual-desktop-resize';
    resizeHandle.setAttribute('aria-hidden', 'true');
    element.append(titlebar, viewport, resizeHandle);

    const window = {
      ...state,
      x: Number.isFinite(state.x) ? state.x : 0,
      y: Number.isFinite(state.y) ? state.y : 0,
      width: Math.max(1, Number(state.width) || 320),
      height: Math.max(1, Number(state.height) || 200),
      element,
      titlebar,
      titleElement: title,
      viewport,
      canvas,
      context: canvas.getContext('2d', { alpha: false }),
      resizeHandle,
    };

    titlebar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      this.#focus(window);
      event.preventDefault();
      titlebar.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'move',
        window,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: window.x,
        y: window.y,
      };
    });
    titlebar.addEventListener('pointermove', (event) => this.#moveDrag(event));
    titlebar.addEventListener('pointerup', (event) => this.#endDrag(event));
    titlebar.addEventListener('pointercancel', (event) => this.#endDrag(event));

    resizeHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.#focus(window);
      event.preventDefault();
      resizeHandle.setPointerCapture(event.pointerId);
      this.drag = {
        kind: 'resize',
        window,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: window.width,
        height: window.height,
      };
    });
    resizeHandle.addEventListener('pointermove', (event) => this.#moveDrag(event));
    resizeHandle.addEventListener('pointerup', (event) => this.#endDrag(event));
    resizeHandle.addEventListener('pointercancel', (event) => this.#endDrag(event));

    element.addEventListener('pointerdown', () => this.#focus(window));
    canvas.addEventListener('focus', () => this.#focus(window));
    canvas.addEventListener('pointerdown', (event) => canvas.setPointerCapture(event.pointerId));
    canvas.addEventListener('mousemove', (event) => this.#sendMouse(window, 'mousemove', event));
    canvas.addEventListener('mousedown', (event) => {
      this.#focus(window);
      canvas.focus({ preventScroll: true });
      this.#sendMouse(window, 'mousedown', event);
    });
    canvas.addEventListener('mouseup', (event) => this.#sendMouse(window, 'mouseup', event));

    this.container.append(element);
    this.#applyGeometry(window);
    this.#setVisibility(window, state.visible !== false);
    return window;
  }

  #moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (drag.kind === 'move') {
      drag.window.x = drag.x + dx;
      drag.window.y = drag.y + dy;
    } else {
      drag.window.width = Math.max(MIN_CLIENT_WIDTH, drag.width + dx);
      drag.window.height = Math.max(MIN_CLIENT_HEIGHT, drag.height + dy);
    }
    this.#applyGeometry(drag.window);
  }

  #endDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.#moveDrag(event);
    this.drag = null;
    if (drag.kind === 'move') {
      this.#emit(drag.window.id, 'move', { x: drag.window.x, y: drag.window.y });
    } else {
      this.#emit(drag.window.id, 'resize', {
        width: drag.window.width,
        height: drag.window.height,
      });
    }
  }

  #sendMouse(window, type, event) {
    const rect = window.canvas.getBoundingClientRect();
    this.#emit(window.id, type, {
      x: Math.round(event.clientX - rect.left),
      y: Math.round(event.clientY - rect.top),
      buttons: event.buttons,
      button: event.button,
    });
  }

  #setVisibility(window, visible) {
    window.visible = visible;
    window.element.hidden = !visible;
  }

  update(message) {
    if (!message || !['create', 'update', 'destroy'].includes(message.operation))
      throw new TypeError('Window update requires create, update, or destroy operation');
    const state = message.window;
    if (!state || state.id === undefined || state.id === null)
      throw new TypeError('Window update requires a window id');
    const existing = this.windows.get(state.id);
    if (message.operation === 'destroy') {
      existing?.element.remove();
      this.windows.delete(state.id);
      if (this.activeWindowId === state.id) {
        this.activeWindowId = null;
        const next = [...this.windows.values()].filter((window) => window.visible).at(-1);
        if (next) this.#focus(next);
      }
      return;
    }

    const window = existing ?? this.#createWindow(state);
    Object.assign(window, {
      titleText: state.title ?? window.titleElement.textContent,
      x: Number.isFinite(state.x) ? state.x : window.x,
      y: Number.isFinite(state.y) ? state.y : window.y,
      width: Number.isFinite(state.width) ? Math.max(1, state.width) : window.width,
      height: Number.isFinite(state.height) ? Math.max(1, state.height) : window.height,
    });
    window.titleElement.textContent = window.titleText;
    window.titleElement.title = window.titleText;
    window.titlebar.querySelector('button').setAttribute('aria-label', `Close ${window.titleText}`);
    if (state.visible !== undefined) {
      this.#setVisibility(window, state.visible);
      if (!state.visible && this.activeWindowId === state.id) {
        this.activeWindowId = null;
        const next = [...this.windows.values()].filter((item) => item.visible).at(-1);
        if (next) this.#focus(next);
      }
    }
    this.#applyGeometry(window);
    this.windows.set(state.id, window);
  }

  frame({ windowId, width, height, pixels }) {
    const window = this.windows.get(windowId);
    if (!window || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      return false;
    const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    if (bytes.byteLength !== width * height * 4) return false;
    if (!window.imageData || window.canvas.width !== width || window.canvas.height !== height) {
      window.canvas.width = width;
      window.canvas.height = height;
      window.imageData = window.context.createImageData(width, height);
    }
    window.imageData.data.set(bytes);
    window.context.putImageData(window.imageData, 0, 0);
    return true;
  }

  reset() {
    this.windows.clear();
    this.activeWindowId = null;
    this.drag = null;
    this.nextZIndex = 1;
    this.container.replaceChildren();
  }
}
