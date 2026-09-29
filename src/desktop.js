import './desktop.css';
import { CURSOR_STYLES, CURSOR_SIZE } from './cursors.js';
import { compareWindowOrder, windowFrame } from './window-frame.js';

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
    this.cursorImages = new Map();

    container.classList.add('virtual-desktop');
    if (!container.hasAttribute('tabindex')) container.tabIndex = 0;
    container.addEventListener('keydown', this.onKeyDown);
    container.addEventListener('keyup', this.onKeyUp);
    container.addEventListener('focusin', () => this.onInput({ type: 'app-focus' }));
    container.addEventListener('focusout', (event) => {
      if (!container.contains(event.relatedTarget)) this.onInput({ type: 'app-blur' });
    });
    const host = container.ownerDocument.defaultView;
    host.addEventListener('blur', () => this.onInput({ type: 'app-blur' }));
    host.addEventListener('focus', () => this.onInput({ type: 'app-focus' }));
    container.ownerDocument.addEventListener('visibilitychange', () =>
      this.onInput({
        type: container.ownerDocument.hidden ? 'app-blur' : 'app-focus',
      }),
    );
  }

  onKeyDown = (event) => this.#sendKey(event, 'keydown');
  onKeyUp = (event) => this.#sendKey(event, 'keyup');

  setCursor(css, handle) {
    if (typeof css === 'object' && css !== null) {
      const { width, height, hotX, hotY, pixels } = css;
      if (
        width !== CURSOR_SIZE ||
        height !== CURSOR_SIZE ||
        !Number.isInteger(hotX) ||
        !Number.isInteger(hotY) ||
        hotX < 0 ||
        hotY < 0 ||
        hotX >= width ||
        hotY >= height ||
        !(pixels instanceof Uint8Array) ||
        pixels.length !== width * height * 4 ||
        !Number.isInteger(handle) ||
        handle < 0x63000000 ||
        handle > 0x630003fc ||
        handle % 4
      )
        throw Error('Invalid desktop cursor image');
      if (!this.cursorImages.has(handle)) {
        const canvas = this.container.ownerDocument.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d'),
          data = context.createImageData(width, height);
        data.data.set(pixels);
        context.putImageData(data, 0, 0);
        this.cursorImages.set(
          handle,
          `url("${canvas.toDataURL('image/png')}") ${hotX} ${hotY}, default`,
        );
      }
      this.container.style.setProperty('--guest-cursor', this.cursorImages.get(handle));
      return;
    }
    if (css !== 'none' && ![...CURSOR_STYLES.values()].includes(css))
      throw Error('Unsupported desktop cursor');
    this.container.style.setProperty('--guest-cursor', css);
  }

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

  #topLevel(window) {
    while (window?.isControl) window = this.windows.get(window.parentId);
    return window;
  }

  #available(window) {
    while (window) {
      if (!window.visible || window.enabled === false) return false;
      if (!window.isControl) return true;
      window = this.windows.get(window.parentId);
    }
    return false;
  }

  #descendantOf(window, id) {
    while (window) {
      if (window.id === id) return true;
      window = window.isControl ? this.windows.get(window.parentId) : null;
    }
    return false;
  }

  #restack() {
    const ordered = [...this.windows.values()].filter((w) => !w.isControl).sort(compareWindowOrder);
    ordered.forEach((w, i) => {
      w.element.style.zIndex = String(ordered.length - i);
    });
    const parents = new Set(
      [...this.windows.values()].filter((w) => w.isControl).map((w) => w.parentId),
    );
    for (const parent of parents) {
      const children = [...this.windows.values()]
        .filter((w) => w.isControl && w.parentId === parent)
        .sort(compareWindowOrder);
      children.forEach((w, i) => {
        w.container.style.zIndex = String(children.length - i);
      });
    }
  }

  stack(windowId, zOrder, topmost) {
    const window = this.windows.get(windowId);
    if (!window || !Number.isFinite(zOrder)) return;
    window.zOrder = zOrder;
    window.topmost = !!topmost;
    this.nextZIndex = Math.max(this.nextZIndex, zOrder);
    this.#restack();
  }

  #focus(window, { focusElement = false, preserveOrder = false } = {}) {
    if (this.syncingFocus) return;
    const parent = this.#topLevel(window);
    if (!parent || !this.#available(window)) return;
    this.syncingFocus = true;
    try {
      if (window.isControl) {
        if (focusElement) window.element.focus({ preventScroll: true });
      } else this.container.focus({ preventScroll: true });
    } finally {
      this.syncingFocus = false;
    }
    if (!preserveOrder) parent.zOrder = ++this.nextZIndex;
    this.#restack();
    for (const other of this.windows.values())
      if (!other.isControl) other.element.classList.toggle('is-focused', other === parent);
    this.activeWindowId = window.id;
    if (!preserveOrder) this.#emit(window.id, 'focus');
  }

  focus(windowId, { preserveOrder = false } = {}) {
    if (!windowId && preserveOrder) {
      const active = this.windows.get(this.activeWindowId);
      active?.element.blur();
      this.activeWindowId = null;
      return true;
    }
    const window = this.windows.get(windowId);
    if (!window || !this.#available(window)) return false;
    this.#focus(window, { focusElement: true, preserveOrder });
    return true;
  }

  #applyGeometry(window) {
    const { border, title, resizable } = window.frame ?? windowFrame();
    window.element.style.left = `${window.x}px`;
    window.element.style.top = `${window.y}px`;
    window.element.style.width = `${window.width + 2 * border}px`;
    window.element.style.height = `${window.height + title + 2 * border}px`;
    window.element.style.borderWidth = `${border}px`;
    window.element.classList.toggle('is-borderless', !border && !title);
    window.titlebar.hidden = !title;
    window.resizeHandle.hidden = !resizable;
    window.viewport.style.width = `${window.width}px`;
    window.viewport.style.height = `${window.height}px`;
  }

  #applyIcon(window, icon) {
    if (icon === undefined) return;
    const valid =
      icon &&
      Number.isInteger(icon.width) &&
      Number.isInteger(icon.height) &&
      icon.width > 0 &&
      icon.height > 0 &&
      icon.width <= 256 &&
      icon.height <= 256;
    window.iconCanvas.hidden = !valid;
    if (!valid) return;
    const bytes = icon.pixels instanceof Uint8Array ? icon.pixels : new Uint8Array(icon.pixels);
    if (bytes.byteLength !== icon.width * icon.height * 4) {
      window.iconCanvas.hidden = true;
      return;
    }
    window.iconCanvas.width = icon.width;
    window.iconCanvas.height = icon.height;
    const image = window.iconContext.createImageData(icon.width, icon.height);
    image.data.set(bytes);
    window.iconContext.putImageData(image, 0, 0);
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

    const iconCanvas = document.createElement('canvas');
    iconCanvas.className = 'virtual-desktop-window-icon';
    iconCanvas.hidden = true;
    iconCanvas.setAttribute('aria-hidden', 'true');

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

    titlebar.append(iconCanvas, title, close);

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
      iconCanvas,
      iconContext: iconCanvas.getContext('2d'),
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
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.#sendMouse(window, 'wheel', event);
      },
      { passive: false },
    );
    canvas.addEventListener('mousemove', (event) => this.#sendMouse(window, 'mousemove', event));
    canvas.addEventListener('mousedown', (event) => {
      this.#focus(window);
      canvas.focus({ preventScroll: true });
      this.#sendMouse(window, 'mousedown', event);
    });
    canvas.addEventListener('mouseup', (event) => this.#sendMouse(window, 'mouseup', event));

    this.container.append(element);
    this.#applyGeometry(window);
    this.#applyIcon(window, state.icon);
    this.#setVisibility(window, state.visible !== false);
    return window;
  }

  #createControl(state) {
    const parent = this.windows.get(state.parentId);
    if (!parent) throw new Error(`Child control ${state.id} references an unknown parent window`);
    const controlType = state.controlType;
    if (!['static', 'button', 'edit'].includes(controlType))
      throw new Error(`Unsupported child control type: ${controlType}`);

    let element;
    if (controlType === 'button') {
      const buttonType = state.controlStyle?.buttonType ?? 'push';
      // A group box is a labelled frame, not a clickable control.
      if (buttonType === 'group-box') {
        element = document.createElement('fieldset');
        element.className = 'virtual-desktop-control virtual-desktop-control-groupbox';
        const legend = document.createElement('legend');
        element.append(legend);
        control.legend = legend;
      } else {
        const toggling = !!state.controlStyle?.toggle || !!state.controlStyle?.triState;
        element = document.createElement('button');
        element.type = 'button';
        element.className =
          'virtual-desktop-control virtual-desktop-control-button' +
          (toggling ? ' virtual-desktop-control-toggle' : '');
        if (state.controlStyle?.flat) element.classList.add('virtual-desktop-control-flat');
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!element.disabled && !element.hidden)
            this.#emit(control.id, 'command', { notification: 0 });
        });
      }
    } else if (controlType === 'edit') {
      // ES_MULTILINE needs a text area; a single-line edit is an input. The
      // element is chosen at creation because the style cannot change later.
      const multiline = !!state.controlStyle?.multiline;
      element = document.createElement(multiline ? 'textarea' : 'input');
      if (!multiline) element.type = 'text';
      element.autocomplete = 'off';
      element.spellcheck = false;
      element.className =
        'virtual-desktop-control virtual-desktop-control-edit' +
        (multiline ? ' virtual-desktop-control-edit-multiline' : '');
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
    element.addEventListener('mousemove', (event) => this.#sendMouse(control, 'mousemove', event));
    for (const type of ['keydown', 'keyup'])
      element.addEventListener(type, (event) => {
        event.stopPropagation();
        this.#sendKey(event, type, control.id, false);
      });

    // A separate client layer can host native child windows even when the
    // control itself is an HTML input, which cannot contain DOM children.
    const container = document.createElement('div');
    container.className = 'virtual-desktop-control-container';
    const viewport = document.createElement('div');
    viewport.className = 'virtual-desktop-control-client';
    container.append(element, viewport);
    const control = {
      ...state,
      isControl: true,
      controlType,
      parentId: state.parentId,
      parent,
      element,
      container,
      viewport,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      visible: true,
      enabled: true,
    };
    // Native newly created child windows start below their existing siblings.
    parent.viewport.prepend(container);
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
      } else if (control.legend) {
        // A group box shows its caption in the legend, not as body text.
        control.legend.textContent =
          (noPrefix ?? control.noPrefix ?? false)
            ? control.titleText
            : stripCaptionMnemonics(control.titleText);
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
      control.container.hidden = !control.visible;
    }
    if (state.enabled !== undefined) {
      control.enabled = !!state.enabled;
      control.container.inert = !control.enabled;
      if ('disabled' in control.element) control.element.disabled = !control.enabled;
    }
    if (state.controlBorder !== undefined) {
      const border = state.controlBorder;
      control.controlBorder = border;
      control.element.style.border = border
        ? `${border}px ${border === 2 ? 'inset' : 'solid'} #888`
        : control.controlType === 'button'
          ? ''
          : '0';
    }
    const controlStyle = state.controlStyle ?? {};
    if (control.controlType === 'button' && state.controlStyle) {
      const style = state.controlStyle;
      control.buttonType = style.buttonType ?? control.buttonType;
      control.toggle = !!style.toggle || !!style.triState;
      control.triState = !!style.triState;
      // The native control reports a three-state button's indeterminate state
      // through aria-checked="mixed"; a checkbox uses the checked attribute.
      if (control.toggle) {
        const checked = (style.checkState ?? state.checkState ?? 0) === 1;
        control.element.setAttribute('aria-checked', checked ? 'true' : 'false');
        if (control.triState)
          control.element.setAttribute(
            'aria-checked',
            (style.checkState ?? state.checkState ?? 0) === 2 ? 'mixed' : checked ? 'true' : 'false',
          );
        control.element.classList.toggle('virtual-desktop-control-checked', checked);
      }
      control.element.classList.toggle('virtual-desktop-control-flat', !!style.flat);
      // A BS_PUSHLIKE checkbox/radio renders (and behaves) like a push button.
      control.pushLike = !!style.pushLike;
      if (control.pushLike) control.element.classList.add('virtual-desktop-control-pushlike');
      // BS_LEFT/BS_RIGHT/BS_CENTER and BS_TOP/BS_BOTTOM/BS_VCENTER control where
      // the caption sits inside the button rectangle.
      const horizontal = style.horizontalAlign;
      const vertical = style.verticalAlign;
      if (horizontal === 'left' || horizontal === 'right' || horizontal === 'center')
        control.element.style.justifyContent =
          horizontal === 'left' ? 'flex-start' : horizontal === 'right' ? 'flex-end' : 'center';
      if (vertical === 'top' || vertical === 'bottom' || vertical === 'center')
        control.element.style.alignItems =
          vertical === 'top' ? 'flex-start' : vertical === 'bottom' ? 'flex-end' : 'center';
      // BS_MULTILINE lets a long caption wrap instead of being clipped.
      control.multilineCaption = !!style.multilineCaption;
      if (control.multilineCaption) control.element.style.whiteSpace = 'normal';
      else if (style.multilineCaption === false) control.element.style.whiteSpace = '';
    }
    const textAlign = state.textAlign ?? controlStyle.textAlign ?? controlStyle.alignment;
    if (textAlign !== undefined) control.element.style.textAlign = textAlign ?? '';
    const readOnly = state.readOnly ?? controlStyle.readOnly;
    if (control.controlType === 'edit' && readOnly !== undefined)
      control.element.readOnly = !!readOnly;
    if (control.controlType === 'edit') {
      const multiline = !!(state.controlStyle?.multiline ?? control.multiline);
      control.multiline = multiline;
      control.uppercase = !!(state.controlStyle?.uppercase ?? control.uppercase);
      control.lowercase = !!(state.controlStyle?.lowercase ?? control.lowercase);
      control.number = !!(state.controlStyle?.number ?? control.number);
      if (state.controlStyle?.password !== undefined)
        control.element.type = state.controlStyle.password ? 'password' : 'text';
      if (state.controlStyle?.verticalScroll !== undefined)
        control.element.style.overflowY = state.controlStyle.verticalScroll ? 'scroll' : '';
      if (state.controlStyle?.horizontalScroll !== undefined)
        control.element.style.overflowX = state.controlStyle.horizontalScroll ? 'scroll' : '';
      // A multiline edit wraps by default; ES_AUTOHSCROLL turns wrapping off.
      if (multiline)
        control.element.style.whiteSpace = state.controlStyle?.autoHScroll
          ? 'pre'
          : 'pre-wrap';
    }
    if (state.font !== undefined) control.element.style.font = state.font?.css ?? '';

    control.isControl = true;
    control.controlType = state.controlType ?? control.controlType;
    control.parentId = state.parentId ?? control.parentId;
    if (state.controlStyle !== undefined) control.controlStyle = state.controlStyle;
    if (state.font !== undefined) control.font = state.font;
    control.parent = this.windows.get(control.parentId) ?? control.parent;
    control.zOrder = state.zOrder ?? control.zOrder ?? 0;
    this.#applyControlGeometry(control);
  }

  #applyControlGeometry(control) {
    Object.assign(control.container.style, {
      left: `${control.x}px`,
      top: `${control.y}px`,
      width: `${control.width}px`,
      height: `${control.height}px`,
    });
    Object.assign(control.element.style, { left: '0', top: '0', width: '100%', height: '100%' });
    control.viewport.style.inset = `${control.controlBorder ?? 0}px`;
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
    const rect = (window.isControl ? window.element : window.canvas).getBoundingClientRect();
    this.#emit(window.id, type, {
      x: Math.round(event.clientX - rect.left),
      y: Math.round(event.clientY - rect.top),
      buttons: event.buttons,
      button: event.button,
      movementX: event.movementX,
      movementY: event.movementY,
      wheelDelta:
        type === 'wheel'
          ? -Math.round(
              event.deltaY *
                (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? window.height : 1),
            )
          : undefined,
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
        (removed?.container ?? removed?.element)?.remove();
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
      this.#restack();
      if (
        !control.visible &&
        this.#descendantOf(this.windows.get(this.activeWindowId), control.id)
      ) {
        const parent = this.windows.get(control.parentId);
        this.activeWindowId = null;
        if (parent && this.#available(parent)) this.#focus(parent, { focusElement: true });
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
      frame: state.frame ?? window.frame,
      topmost: state.topmost ?? window.topmost ?? false,
      zOrder: state.zOrder ?? window.zOrder ?? ++this.nextZIndex,
    });
    window.titleElement.textContent = window.titleText;
    this.#applyIcon(window, state.icon);
    if (state.enabled !== undefined) {
      window.enabled = !!state.enabled;
      window.element.inert = !window.enabled;
    }
    window.titleElement.title = window.titleText;
    window.titlebar.querySelector('button').setAttribute('aria-label', `Close ${window.titleText}`);
    if (state.visible !== undefined) {
      this.#setVisibility(window, state.visible);
      const active = this.windows.get(this.activeWindowId);
      if (!state.visible && this.#descendantOf(active, state.id)) {
        this.activeWindowId = null;
        const next = [...this.windows.values()]
          .filter((item) => !item.isControl && item.visible)
          .at(-1);
        if (next) this.#focus(next);
      }
    }
    this.#applyGeometry(window);
    this.windows.set(state.id, window);
    this.nextZIndex = Math.max(this.nextZIndex, window.zOrder);
    this.#restack();
  }

  frame({ windowId, width, height, pixels, bitmap, renderer, graphicsApi, graphicsFrames, graphicsDraws }) {
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
        // Presenting the frame count alone cannot distinguish "nothing was
        // drawn" from "everything was cleared"; publish the draw count too.
        // Publishing the draw count alongside the frame count lets a caller
        // distinguish "nothing was drawn" from "everything was cleared".
        if (graphicsDraws !== undefined)
          window.canvas.dataset.graphicsDraws = String(graphicsDraws);
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
    this.container.style.removeProperty('--guest-cursor');
    this.cursorImages.clear();
    this.windows.clear();
    this.activeWindowId = null;
    this.drag = null;
    this.nextZIndex = 1;
    this.container.replaceChildren();
  }
}
