import './desktop.css';

const TITLEBAR_HEIGHT = 28;
const MIN_CLIENT_WIDTH = 64;
const MIN_CLIENT_HEIGHT = 48;

function stripCaptionMnemonics(text) {
  let rendered = '';
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== '&' || index === text.length - 1) {
      rendered += text[index];
    } else if (text[index + 1] === '&') {
      rendered += '&';
      index++;
    } else {
      index++;
      rendered += text[index];
    }
  }
  return rendered;
}

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

  #sendKey(event, type, windowId = this.activeWindowId, routeGameKeys = true) {
    if (windowId === null || event.isComposing) return;
    this.onInput({
      windowId,
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
    if (routeGameKeys && (event.key.startsWith('Arrow') || event.key === ' '))
      event.preventDefault();
  }

  #emit(windowId, type, values = {}) {
    this.onInput({ windowId, type, ...values });
  }

  #focus(window, { focusElement = false } = {}) {
    const parent = window.isControl ? this.windows.get(window.parentId) : window;
    if (!parent) return;
    if (window.isControl) {
      if (focusElement) window.element.focus({ preventScroll: true });
    } else this.container.focus({ preventScroll: true });
    parent.element.style.zIndex = String(++this.nextZIndex);
    for (const other of this.windows.values())
      if (!other.isControl) other.element.classList.toggle('is-focused', other === parent);
    if (this.activeWindowId === window.id) return;
    this.activeWindowId = window.id;
    this.#emit(window.id, 'focus');
  }

  focus(windowId) {
    const window = this.windows.get(windowId);
    const parent = window?.isControl ? this.windows.get(window.parentId) : null;
    if (!window || !window.visible || (window.isControl && !parent?.visible)) return false;
    this.#focus(window, { focusElement: true });
    return true;
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

  #createControl(state) {
    const parent = this.windows.get(state.parentId);
    if (!parent || parent.isControl)
      throw new Error(`Child control ${state.id} references an unknown parent window`);
    const controlType = state.controlType;
    if (!['static', 'button', 'edit'].includes(controlType))
      throw new Error(`Unsupported child control type: ${controlType}`);

    let element;
    if (controlType === 'button') {
      element = document.createElement('button');
      element.type = 'button';
      element.className = 'virtual-desktop-control virtual-desktop-control-button';
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!element.disabled && !element.hidden)
          this.#emit(control.id, 'command', { notification: 0 });
      });
    } else if (controlType === 'edit') {
      element = document.createElement('input');
      element.type = 'text';
      element.autocomplete = 'off';
      element.spellcheck = false;
      element.className = 'virtual-desktop-control virtual-desktop-control-edit';
      element.addEventListener('input', () =>
        this.#emit(control.id, 'text', { text: element.value }),
      );
    } else {
      element = document.createElement('div');
      element.className = 'virtual-desktop-control virtual-desktop-control-static';
      element.tabIndex = -1;
      element.setAttribute('aria-readonly', 'true');
    }

    element.dataset.windowId = String(state.id);
    element.dataset.parentId = String(state.parentId);
    element.dataset.controlType = controlType;
    element.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      this.#focus(control);
    });
    element.addEventListener('focus', () => this.#focus(control));
    for (const type of ['keydown', 'keyup'])
      element.addEventListener(type, (event) => {
        event.stopPropagation();
        this.#sendKey(event, type, control.id, false);
      });

    const control = {
      ...state,
      isControl: true,
      controlType,
      parentId: state.parentId,
      parent,
      element,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      visible: true,
      enabled: true,
    };
    parent.viewport.append(element);
    this.#applyControlState(control, state);
    return control;
  }

  #applyControlState(control, state) {
    if (state.title !== undefined) control.titleText = String(state.title);
    const noPrefix = state.noPrefix ?? state.controlStyle?.noPrefix;
    if (state.title !== undefined || (noPrefix !== undefined && noPrefix !== control.noPrefix)) {
      if (control.controlType === 'edit') {
        // Avoid disrupting caret selection during incremental WM_SETTEXT echo.
        if (control.element.value !== control.titleText) control.element.value = control.titleText;
      } else {
        control.element.textContent =
          (noPrefix ?? control.noPrefix ?? false)
            ? control.titleText
            : stripCaptionMnemonics(control.titleText);
      }
      control.element.title = control.titleText;
    }
    if (noPrefix !== undefined) control.noPrefix = !!noPrefix;
    if (Number.isFinite(state.x)) control.x = state.x;
    if (Number.isFinite(state.y)) control.y = state.y;
    if (Number.isFinite(state.width)) control.width = Math.max(0, state.width);
    if (Number.isFinite(state.height)) control.height = Math.max(0, state.height);
    if (state.visible !== undefined) {
      control.visible = !!state.visible;
      control.element.hidden = !control.visible;
    }
    if (state.enabled !== undefined) {
      control.enabled = !!state.enabled;
      if ('disabled' in control.element) control.element.disabled = !control.enabled;
    }
    if (state.controlBorder !== undefined) {
      const border = state.controlBorder;
      control.element.style.border = border
        ? `${border}px ${border === 2 ? 'inset' : 'solid'} #888`
        : control.controlType === 'button'
          ? ''
          : '0';
    }
    const controlStyle = state.controlStyle ?? {};
    const textAlign = state.textAlign ?? controlStyle.textAlign ?? controlStyle.alignment;
    if (textAlign !== undefined) control.element.style.textAlign = textAlign ?? '';
    const readOnly = state.readOnly ?? controlStyle.readOnly;
    if (control.controlType === 'edit' && readOnly !== undefined)
      control.element.readOnly = !!readOnly;
    if (state.font !== undefined) control.element.style.font = state.font?.css ?? '';

    control.isControl = true;
    control.controlType = state.controlType ?? control.controlType;
    control.parentId = state.parentId ?? control.parentId;
    if (state.controlStyle !== undefined) control.controlStyle = state.controlStyle;
    if (state.font !== undefined) control.font = state.font;
    control.parent = this.windows.get(control.parentId) ?? control.parent;
    this.#applyControlGeometry(control);
  }

  #applyControlGeometry(control) {
    Object.assign(control.element.style, {
      left: `${control.x}px`,
      top: `${control.y}px`,
      width: `${control.width}px`,
      height: `${control.height}px`,
    });
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
      const removedIds = new Set([state.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const window of this.windows.values())
          if (removedIds.has(window.parentId) && !removedIds.has(window.id)) {
            removedIds.add(window.id);
            changed = true;
          }
      }
      for (const id of removedIds) {
        const removed = this.windows.get(id);
        removed?.element.remove();
        this.windows.delete(id);
      }
      if (removedIds.has(this.activeWindowId)) {
        this.activeWindowId = null;
        const next = [...this.windows.values()]
          .filter((window) => !window.isControl && window.visible)
          .at(-1);
        if (next) this.#focus(next);
      }
      return;
    }

    if (state.parentId && state.controlType) {
      const control = existing ?? this.#createControl(state);
      this.#applyControlState(control, state);
      this.windows.set(state.id, control);
      if (!control.visible && this.activeWindowId === control.id) {
        const parent = this.windows.get(control.parentId);
        this.activeWindowId = null;
        if (parent?.visible) this.#focus(parent, { focusElement: true });
      }
      return;
    }

    const window = existing ?? this.#createWindow(state);
    window.isControl = false;
    Object.assign(window, {
      titleText: state.title ?? window.titleElement.textContent,
      x: Number.isFinite(state.x) ? state.x : window.x,
      y: Number.isFinite(state.y) ? state.y : window.y,
      width: Number.isFinite(state.width) ? Math.max(1, state.width) : window.width,
      height: Number.isFinite(state.height) ? Math.max(1, state.height) : window.height,
    });
    window.titleElement.textContent = window.titleText;
    if (state.enabled !== undefined) {
      window.enabled = !!state.enabled;
      window.element.inert = !window.enabled;
    }
    window.titleElement.title = window.titleText;
    window.titlebar.querySelector('button').setAttribute('aria-label', `Close ${window.titleText}`);
    if (state.visible !== undefined) {
      this.#setVisibility(window, state.visible);
      const active = this.windows.get(this.activeWindowId);
      if (!state.visible && (this.activeWindowId === state.id || active?.parentId === state.id)) {
        this.activeWindowId = null;
        const next = [...this.windows.values()]
          .filter((item) => !item.isControl && item.visible)
          .at(-1);
        if (next) this.#focus(next);
      }
    }
    this.#applyGeometry(window);
    this.windows.set(state.id, window);
  }

  frame({ windowId, width, height, pixels, bitmap, renderer, graphicsApi, graphicsFrames }) {
    const window = this.windows.get(windowId);
    if (
      !window ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1
    ) {
      bitmap?.close();
      return false;
    }
    if (bitmap) {
      try {
        if (bitmap.width !== width || bitmap.height !== height) return false;
        if (window.canvas.width !== width || window.canvas.height !== height) {
          window.canvas.width = width;
          window.canvas.height = height;
          window.imageData = null;
        }
        window.context.drawImage(bitmap, 0, 0);
        window.canvas.dataset.renderer = renderer ?? 'bitmap';
        window.canvas.dataset.graphicsApi = graphicsApi ?? (renderer === 'webgpu' ? 'd3d9' : '');
        window.canvas.dataset.graphicsFrames = String(graphicsFrames ?? 0);
        return true;
      } finally {
        bitmap.close();
      }
    }
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
