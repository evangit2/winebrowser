import './desktop.css';
import { paintRect } from './gdi-raster.js';
import { stripCaptionMnemonics } from './caption-text.js';
import { CURSOR_STYLES } from './cursors.js';
import { cursorPresentation } from './desktop-cursor.js';
import { compareWindowOrder, windowFrame } from './window-frame.js';
import { createReportControl, applyReportControl } from './desktop-report.js';

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
    this.cursorImages = new Map();
    this.cursorOverlay = null;
    this.cursorPoint = null;
    container.ownerDocument.addEventListener('pointermove', (event) => {
      this.cursorPoint = { x: event.clientX, y: event.clientY, target: event.target };
      this.#positionCursorOverlay();
    });
    container.addEventListener('pointerleave', () => {
      this.cursorPoint = null;
      this.#positionCursorOverlay();
    });

    container.ownerDocument.addEventListener('pointerdown', (event) => {
      if (
        this.openMenu &&
        !this.openMenu.window.menuBar.contains(event.target) &&
        !this.openMenu.popup.contains(event.target)
      )
        this.#closeMenu();
    });
    container.ownerDocument.addEventListener(
      'pointerdown',
      (event) => {
        for (const combo of this.windows.values()) {
          if (!combo.nativeCombo || !combo.listState?.dropped) continue;
          const popup = [...this.windows.values()].find((w) => w.comboHostId === combo.id);
          if (!combo.container.contains(event.target) && !popup?.container.contains(event.target))
            this.#emit(combo.id, 'combo-dismiss');
        }
      },
      { capture: true },
    );
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

  onKeyDown = (event) => {
    if (!this.#menuKey(event)) this.#sendKey(event, 'keydown');
  };
  onKeyUp = (event) => this.#sendKey(event, 'keyup');

  setCursor(css, handle) {
    if (typeof css === 'object' && css !== null) {
      const { width, height, hotX, hotY, pixels } = css;
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 256 ||
        height > 256 ||
        !Number.isInteger(hotX) ||
        !Number.isInteger(hotY) ||
        hotX < 0 ||
        hotY < 0 ||
        hotX > 0xffffffff ||
        hotY > 0xffffffff ||
        !(pixels instanceof Uint8Array) ||
        pixels.length !== width * height * 4 ||
        !Number.isInteger(handle) ||
        handle < 1 ||
        handle > 0xffffffff ||
        handle % 4
      )
        throw Error('Invalid desktop cursor image');
      if (!this.cursorImages.has(handle)) {
        const { normal, inverse, inversion } = cursorPresentation(css);
        const make = (bytes) => {
          const canvas = this.container.ownerDocument.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d'),
            data = context.createImageData(width, height);
          data.data.set(bytes);
          context.putImageData(data, 0, 0);
          return canvas;
        };
        const canvas = make(normal);
        if (inversion || width > 128 || height > 128 || hotX >= width || hotY >= height) {
          const nodes = inversion ? [canvas, make(inverse)] : [canvas];
          for (const [index, node] of nodes.entries()) {
            node.dataset.nativeCursor = index ? 'inversion' : 'image';
            Object.assign(node.style, {
              position: 'fixed',
              zIndex: '2147483647',
              pointerEvents: 'none',
              display: 'none',
              ...(index ? { mixBlendMode: 'difference' } : {}),
            });
          }
          this.cursorImages.set(handle, { css: 'none', nodes, hotX: hotX | 0, hotY: hotY | 0 });
        } else
          this.cursorImages.set(handle, {
            css: `url("${canvas.toDataURL('image/png')}") ${hotX} ${hotY}, default`,
          });
      }
      this.#removeCursorOverlay();
      const presentation = this.cursorImages.get(handle);
      this.container.style.setProperty('--guest-cursor', presentation.css);
      if (presentation.nodes) {
        this.cursorOverlay = presentation;
        for (const node of presentation.nodes) this.container.ownerDocument.body.append(node);
        this.#positionCursorOverlay();
      }
      return;
    }
    if (css !== 'none' && ![...CURSOR_STYLES.values()].includes(css))
      throw Error('Unsupported desktop cursor');
    this.#removeCursorOverlay();
    this.container.style.setProperty('--guest-cursor', css);
  }

  releaseCursor(handle) {
    this.cursorImages.delete(handle);
  }

  #removeCursorOverlay() {
    if (this.cursorOverlay) for (const node of this.cursorOverlay.nodes) node.remove();
    this.cursorOverlay = null;
  }

  #positionCursorOverlay() {
    const overlay = this.cursorOverlay,
      point = this.cursorPoint;
    if (!overlay) return;
    const visible =
      point &&
      this.container.contains(point.target) &&
      this.container.ownerDocument.defaultView.getComputedStyle(point.target).cursor === 'none';
    for (const node of overlay.nodes) {
      node.style.display = visible ? 'block' : 'none';
      if (point) {
        const scale = this.container.ownerDocument.defaultView.devicePixelRatio || 1;
        node.style.left = Math.round((point.x - overlay.hotX) * scale) / scale + 'px';
        node.style.top = Math.round((point.y - overlay.hotY) * scale) / scale + 'px';
      }
    }
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
        w.container.style.zIndex = w.comboPopup ? '10000' : String(children.length - i);
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
        if (focusElement) (window.listEdit ?? window.element).focus({ preventScroll: true });
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
    window.titlebar.hidden = !(title - (window.frame?.menu ?? 0));
    window.resizeHandle.hidden = !resizable;
    window.viewport.style.width = `${window.width}px`;
    window.viewport.style.height = `${window.height}px`;
    for (const popup of this.windows.values())
      if (popup.comboPopup) this.#applyControlGeometry(popup);
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

  #closeMenu(restoreFocus = true, command = 0) {
    const open = this.openMenu;
    if (!open) return;
    open.popup.remove();
    open.button?.setAttribute('aria-expanded', 'false');
    this.openMenu = null;
    if (open.reply) open.reply(command);
    else this.#emit(open.window.id, 'menu-close');
    if (restoreFocus) open.window.canvas.focus({ preventScroll: true });
  }

  showPopupMenu({ owner, x, y, items }) {
    this.#closeMenu(false);
    const window = this.windows.get(owner);
    if (!window || !this.#available(window)) return Promise.resolve(0);
    const root = document.createElement('nav');
    root.className = 'virtual-desktop-menubar virtual-desktop-context-menu';
    root.style.left = `${x - window.x - (window.frame?.border ?? 1)}px`;
    root.style.top = `${y - window.y - (window.frame?.border ?? 1)}px`;
    const list = this.#menuList(window, items);
    list.classList.add('virtual-desktop-menu-popup');
    root.append(list);
    window.element.append(root);
    this.#focus(window);
    const result = new Promise((reply) => {
      this.openMenu = { window, popup: root, reply };
    });
    list.querySelector('button:not(:disabled)')?.focus();
    return result;
  }

  #openMenu(window, button, items) {
    this.#closeMenu(false);
    const popup = this.#menuList(window, items);
    popup.classList.add('virtual-desktop-menu-popup');
    button.parentElement.append(popup);
    button.setAttribute('aria-expanded', 'true');
    this.openMenu = { window, button, popup };
    this.#focus(window);
    this.#emit(window.id, 'menu-open');
    popup.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  #menuList(window, items) {
    const list = document.createElement('div');
    list.setAttribute('role', 'menu');
    for (const item of items) {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.setAttribute('role', 'separator');
        list.append(separator);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'virtual-desktop-menu-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = !item.enabled;
      if (item.default) button.style.fontWeight = 'bold';
      const [caption, shortcut = ''] = item.text.split('\t');
      const role = item.radio ? 'menuitemradio' : item.checked ? 'menuitemcheckbox' : 'menuitem';
      button.setAttribute('role', role);
      if (role !== 'menuitem') button.setAttribute('aria-checked', String(item.checked));
      button.dataset.mnemonic = /(?<!&)&([^&])/.exec(caption)?.[1].toLowerCase() ?? '';
      const label = document.createElement('span');
      label.textContent = stripCaptionMnemonics(caption);
      const mark = document.createElement('span');
      mark.textContent = item.checked ? (item.radio ? '●' : '✓') : '';
      mark.setAttribute('aria-hidden', 'true');
      const hint = document.createElement('span');
      hint.textContent = item.submenu ? '›' : shortcut;
      hint.setAttribute('aria-hidden', 'true');
      button.append(mark, label, hint);
      row.append(button);
      if (item.submenu) {
        const nested = this.#menuList(window, item.submenu);
        nested.classList.add('virtual-desktop-menu-nested');
        nested.hidden = true;
        row.append(nested);
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
          nested.hidden = !nested.hidden;
          button.setAttribute('aria-expanded', String(!nested.hidden));
          nested.querySelector('button:not(:disabled)')?.focus();
        });
      } else
        button.addEventListener('click', () => {
          const popup = !!this.openMenu?.reply;
          this.#closeMenu(true, item.id);
          if (!popup) this.#emit(window.id, 'menu-command', { command: item.id });
        });
      list.append(row);
    }
    return list;
  }

  #applyMenu(window, items) {
    if (items === undefined) return;
    const signature = JSON.stringify(items);
    if (signature === window.menuSignature) return;
    if (this.openMenu?.window === window) this.#closeMenu();
    window.menuSignature = signature;
    window.menuBar.replaceChildren();
    window.menuBar.hidden = !items?.length;
    for (const item of items ?? []) {
      const row = document.createElement('div');
      row.className = 'virtual-desktop-menu-root';
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = !item.enabled;
      button.textContent = stripCaptionMnemonics(item.text);
      button.dataset.mnemonic = /(?<!&)&([^&])/.exec(item.text)?.[1].toLowerCase() ?? '';
      if (item.submenu) {
        button.setAttribute('aria-haspopup', 'menu');
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', () => {
          if (this.openMenu?.button === button) this.#closeMenu();
          else this.#openMenu(window, button, item.submenu);
        });
      } else
        button.addEventListener('click', () =>
          this.#emit(window.id, 'menu-command', { command: item.id }),
        );
      row.append(button);
      window.menuBar.append(row);
    }
  }

  #menuKey(event) {
    const open = this.openMenu;
    if (open) {
      if (event.key === 'Escape') {
        this.#closeMenu();
        event.preventDefault();
        return true;
      }
      const buttons = [...open.popup.querySelectorAll('button:not(:disabled)')].filter(
        (b) => !b.closest('[hidden]'),
      );
      const current = buttons.indexOf(event.target);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
        event.preventDefault();
        return true;
      }
      const match = buttons.find((b) => b.dataset.mnemonic === event.key.toLowerCase());
      if (match && event.key.length === 1) {
        match.click();
        event.preventDefault();
        return true;
      }
      // Menu navigation stays in the browser until a command is selected.
      return true;
    }
    if (event.altKey && event.key.length === 1) {
      const window = this.#topLevel(this.windows.get(this.activeWindowId));
      const button = [...(window?.menuBar.querySelectorAll('button') ?? [])].find(
        (b) => b.dataset.mnemonic === event.key.toLowerCase() && !b.disabled,
      );
      if (button) {
        button.click();
        event.preventDefault();
        return true;
      }
    }
    return false;
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
    const menuBar = document.createElement('nav');
    menuBar.className = 'virtual-desktop-menubar';
    menuBar.setAttribute('role', 'menubar');
    menuBar.setAttribute('aria-label', `${title.textContent} menu`);
    menuBar.hidden = true;
    element.append(titlebar, menuBar, viewport, resizeHandle);

    const window = {
      ...state,
      x: Number.isFinite(state.x) ? state.x : 0,
      y: Number.isFinite(state.y) ? state.y : 0,
      width: Math.max(1, Number(state.width) || 320),
      height: Math.max(1, Number(state.height) || 200),
      element,
      titlebar,
      menuBar,
      titleElement: title,
      iconCanvas,
      iconContext: iconCanvas.getContext('2d'),
      viewport,
      canvas,
      context: canvas.getContext('2d', { alpha: false }),
      resizeHandle,
    };

    // Events bubble from native child controls. Deliver a file drop to the
    // nearest accepting window, using that window's client coordinates.
    const dropTarget = (event) => {
      let target =
        this.windows.get(Number(event.target.closest('[data-window-id]')?.dataset.windowId)) ??
        window;
      while (target && !target.acceptFiles) target = this.windows.get(target.parentId);
      return target && this.#available(target) ? target : null;
    };
    viewport.addEventListener('dragover', (event) => {
      if (dropTarget(event) && [...(event.dataTransfer?.types ?? [])].includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    viewport.addEventListener('drop', async (event) => {
      const target = dropTarget(event),
        files = [...(event.dataTransfer?.files ?? [])];
      if (!target || !files.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (files.length > 2048 || files.reduce((sum, f) => sum + f.size, 0) > 128 * 1024 * 1024)
        return;
      const rect = (target.isControl ? target.element : target.canvas).getBoundingClientRect();
      const border =
        target.controlType === 'custom' || target.tabList ? (target.controlBorder ?? 0) : 0;
      const x = Math.round(event.clientX - rect.left - border),
        y = Math.round(event.clientY - rect.top - border);
      try {
        const inputs = await Promise.all(
          files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
        );
        if (this.windows.get(target.id) === target && target.acceptFiles && this.#available(target))
          this.#emit(target.id, 'drop-files', { x, y, files: inputs });
      } catch (error) {
        console.error('Could not read dropped files', error);
      }
    });

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
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
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
      this.#sendMouse(window, event.detail === 2 ? 'dblclick' : 'mousedown', event);
    });
    canvas.addEventListener('mouseup', (event) => this.#sendMouse(window, 'mouseup', event));

    this.container.append(element);
    this.#applyGeometry(window);
    this.#applyIcon(window, state.icon);
    this.#applyMenu(window, state.menu);
    this.#setVisibility(window, state.visible !== false && !state.minimized);
    return window;
  }

  #createControl(state) {
    const parent = this.windows.get(state.parentId);
    if (!parent) throw new Error(`Child control ${state.id} references an unknown parent window`);
    const controlType = state.controlType;
    if (
      ![
        'static',
        'button',
        'edit',
        'treeview',
        'tabcontrol',
        'statusbar',
        'toolbar',
        'progress',
        'listview',
        'combobox',
        'listbox',
        'custom',
      ].includes(controlType)
    )
      throw new Error(`Unsupported child control type: ${controlType}`);

    let element, legend, canvas, listSelect, listEdit, tabList;
    if (controlType === 'button') {
      const buttonType = state.controlStyle?.buttonType ?? 'push';
      // A group box is a labelled frame, not a clickable control.
      if (buttonType === 'group-box') {
        element = document.createElement('fieldset');
        element.className = 'virtual-desktop-control virtual-desktop-control-groupbox';
        legend = document.createElement('legend');
        element.append(legend);
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
          if (!element.disabled && !element.hidden && !control.controlStyle?.ownerDraw)
            this.#emit(control.id, 'command', { notification: 0 });
        });
        if (state.controlStyle?.ownerDraw) {
          canvas = document.createElement('canvas');
          canvas.style.cssText =
            'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
          element.append(canvas);
          element.style.padding = '0';
          element.style.background = 'transparent';
        }
      }
    } else if (
      controlType === 'combobox' &&
      (state.controlStyle?.ownerDraw || state.controlStyle?.nativeCombo)
    ) {
      element = document.createElement('div');
      element.className = 'virtual-desktop-control virtual-desktop-control-native-combo';
      if (!state.controlStyle?.ownerDraw && state.list?.comboType === 3) {
        const text = document.createElement('span');
        text.className = 'virtual-desktop-combo-text';
        element.append(text);
      }
      element.tabIndex = 0;
      element.setAttribute('role', 'combobox');
      element.setAttribute('aria-label', state.title || 'Choices');
      element.setAttribute('aria-haspopup', 'listbox');
      if (state.list?.comboType === 3)
        element.addEventListener('click', (event) => {
          if (control.enabled && !event.detail) this.#emit(control.id, 'combo-toggle');
        });
      if (state.list?.comboType !== 1) {
        const arrow = document.createElement('button');
        arrow.type = 'button';
        arrow.textContent = '▾';
        arrow.className = 'virtual-desktop-combo-arrow';
        arrow.setAttribute('aria-label', `Open ${state.title || 'choices'}`);
        arrow.addEventListener('click', (event) => {
          event.stopPropagation();
          if (control.enabled && !event.detail) this.#emit(control.id, 'combo-toggle');
        });
        element.append(arrow);
      }
      element.addEventListener('pointerdown', (event) => {
        if (
          !control.enabled ||
          event.button !== 0 ||
          control.listState?.comboType === 1 ||
          (control.listState?.comboType === 2 &&
            !event.target.closest('.virtual-desktop-combo-arrow'))
        )
          return;
        event.preventDefault();
        control.comboPointerId = event.pointerId;
        element.setPointerCapture(event.pointerId);
        this.#sendMouse(control, 'mousedown', event);
      });
      element.addEventListener('pointermove', (event) => {
        if (control.comboPointerId === event.pointerId)
          this.#sendMouse(control, 'mousemove', event);
      });
      element.addEventListener('pointerup', (event) => {
        if (control.comboPointerId !== event.pointerId) return;
        control.comboPointerId = null;
        this.#sendMouse(control, 'mouseup', event);
      });
      for (const type of ['pointercancel', 'lostpointercapture'])
        element.addEventListener(type, (event) => {
          if (control.comboPointerId !== event.pointerId) return;
          control.comboPointerId = null;
          this.#emit(control.id, 'combo-dismiss');
        });
    } else if (
      controlType === 'listbox' &&
      (state.list?.ownerDraw ||
        state.list?.multiple ||
        state.list?.nativeKeyboard ||
        state.list?.drag ||
        state.list?.tabStops !== undefined)
    ) {
      element = document.createElement('div');
      tabList = true;
      element.className = 'virtual-desktop-control virtual-desktop-control-tablist';
      element.setAttribute('role', 'listbox');
      element.setAttribute('aria-label', state.title || 'List');
      element.tabIndex = 0;
      const syncListScroll = () => {
        const list = control.listState;
        if (!list) return;
        const top = Math.min(
          list.maxTop ?? Infinity,
          Math.max(
            0,
            control.listOffsets.findLastIndex((y) => y <= element.scrollTop),
          ),
        );
        // Win32 scrolls by whole items. Chromium can scroll an offscreen row
        // into view before dispatching its deferred scroll event. Synchronize
        // that viewport before native pointer hit testing, including tiny lists.
        if (list.nativePointer) element.scrollTop = control.listOffsets[top] ?? 0;
        if (top !== list.top) this.#emit(control.id, 'list-scroll', { top });
      };
      element.addEventListener('scroll', syncListScroll);
      element.addEventListener('pointerdown', (event) => {
        if (control.listState?.nativePointer && control.enabled && event.button === 0) {
          event.preventDefault();
          syncListScroll();
          if (!control.comboPopup) element.focus({ preventScroll: true });
          control.listPointerId = event.pointerId;
          element.setPointerCapture(event.pointerId);
          this.#sendMouse(control, 'mousedown', event);
        } else if (control.listState?.drag && event.button === 0)
          element.setPointerCapture(event.pointerId);
      });
      element.addEventListener('pointerup', (event) => {
        if (control.listPointerId !== event.pointerId) return;
        control.listPointerId = null;
        this.#sendMouse(control, 'mouseup', event);
      });
      element.addEventListener('pointermove', (event) => {
        if (control.listState?.nativePointer) {
          syncListScroll();
          this.#sendMouse(control, 'mousemove', event);
        }
      });
      for (const type of ['pointercancel', 'lostpointercapture'])
        element.addEventListener(type, (event) => {
          if (control.listPointerId !== event.pointerId) return;
          control.listPointerId = null;
          this.#emit(control.id, 'list-cancel');
        });
      element.addEventListener('contextmenu', (event) => {
        if (control.listState?.drag) event.preventDefault();
      });
      for (const type of ['mousedown', 'mouseup'])
        element.addEventListener(type, (event) => {
          if (!control.listState?.drag) return;
          event.stopPropagation();
          if (type === 'mousedown') {
            event.preventDefault();
            element.focus({ preventScroll: true });
          }
          this.#sendMouse(control, type, event);
        });
      element.addEventListener('keydown', (event) => {
        const s = control.listState;
        if (!s?.items.length || s.drag?.dragging || !control.enabled) return;
        if (
          (s.wantKeyboardInput && event.key !== 'Tab') ||
          event.key.length === 1 ||
          [
            'ArrowDown',
            'ArrowUp',
            'ArrowLeft',
            'ArrowRight',
            'Home',
            'End',
            'PageUp',
            'PageDown',
          ].includes(event.key)
        )
          event.preventDefault();
        // Selection belongs to the native control procedure, including parent
        // keyboard callbacks. The shared key listener queues the guest message.
      });
    } else if (['combobox', 'listbox'].includes(controlType)) {
      const comboType = state.list?.comboType ?? 0;
      listSelect = document.createElement('select');
      listSelect.setAttribute(
        'aria-label',
        state.title || (controlType === 'listbox' ? 'List' : 'Choices'),
      );
      listSelect.addEventListener('change', () =>
        this.#emit(control.id, 'list-select', { index: listSelect.selectedIndex }),
      );
      if (controlType === 'combobox' && comboType !== 3) {
        element = document.createElement('div');
        listEdit = document.createElement('input');
        listEdit.type = 'text';
        listEdit.autocomplete = 'off';
        listEdit.setAttribute('aria-label', state.title || 'Value');
        listEdit.addEventListener('input', () =>
          this.#emit(control.id, 'list-text', {
            text: listEdit.value,
            start: listEdit.selectionStart,
            end: listEdit.selectionEnd,
          }),
        );
        for (const type of ['select', 'keyup', 'click'])
          listEdit.addEventListener(type, () => {
            const expected = control.listState?.selection;
            if (
              expected?.start === listEdit.selectionStart &&
              expected?.end === listEdit.selectionEnd
            )
              return;
            this.#emit(control.id, 'list-selection', {
              start: listEdit.selectionStart,
              end: listEdit.selectionEnd,
            });
          });
        element.append(listSelect, listEdit);
      } else element = listSelect;
      element.className =
        'virtual-desktop-control virtual-desktop-control-list' +
        (controlType === 'combobox' ? ' virtual-desktop-control-combo' : '');
      if (comboType === 1) element.classList.add('virtual-desktop-control-combo-simple');
    } else if (controlType === 'progress' || controlType === 'listview') {
      element = createReportControl(controlType);
    } else if (controlType === 'treeview') {
      element = document.createElement('div');
      element.className = 'virtual-desktop-control virtual-desktop-control-tree';
      element.setAttribute('role', 'tree');
      element.setAttribute('aria-label', state.title || 'Categories');
      element.tabIndex = 0;
    } else if (controlType === 'tabcontrol') {
      element = document.createElement('div');
      element.className = 'virtual-desktop-control virtual-desktop-control-tabs';
      element.setAttribute('role', 'tablist');
      element.setAttribute('aria-label', state.title || 'Tabs');
      element.tabIndex = 0;
    } else if (controlType === 'toolbar') {
      element = document.createElement('div');
      element.className = 'virtual-desktop-control virtual-desktop-control-toolbar';
      element.setAttribute('role', 'toolbar');
      element.setAttribute('aria-label', state.title || 'Toolbar');
    } else if (controlType === 'statusbar') {
      element = document.createElement('div');
      element.className = 'virtual-desktop-control virtual-desktop-control-statusbar';
      element.setAttribute('role', 'status');
      element.setAttribute('aria-label', 'Status bar');
      element.style.overflow = 'hidden';
      for (const type of ['mouseup', 'dblclick', 'contextmenu'])
        element.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type === 'contextmenu') event.preventDefault();
          else this.#sendMouse(control, type, event);
        });
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
        this.#emit(control.id, 'text', {
          text: element.value,
          selectionStart: element.selectionStart,
          selectionEnd: element.selectionEnd,
        }),
      );
      for (const type of ['select', 'keyup', 'click'])
        element.addEventListener(type, () => {
          // setSelectionRange also schedules trusted DOM select events. Echoing
          // native ranges back to the worker can overwrite a newer EM_SETSEL
          // while an application is replacing several matches.
          const expected = control.nativeSelection;
          if (expected?.start === element.selectionStart && expected?.end === element.selectionEnd)
            return;
          this.#emit(control.id, 'selection', {
            start: element.selectionStart,
            end: element.selectionEnd,
          });
        });
    } else if (controlType === 'custom') {
      element = canvas = document.createElement('canvas');
      element.className = 'virtual-desktop-control virtual-desktop-control-custom';
      element.tabIndex = 0;
      element.addEventListener('contextmenu', (event) => event.preventDefault());
      element.addEventListener('pointerdown', (event) =>
        element.setPointerCapture(event.pointerId),
      );
      for (const type of ['mousedown', 'mouseup'])
        element.addEventListener(type, (event) => {
          event.stopPropagation();
          if (type === 'mousedown') element.focus({ preventScroll: true });
          this.#sendMouse(
            control,
            type === 'mousedown' && event.detail === 2 ? 'dblclick' : type,
            event,
          );
        });
      element.addEventListener(
        'wheel',
        (event) => {
          event.stopPropagation();
          event.preventDefault();
          this.#sendMouse(control, 'wheel', event);
        },
        { passive: false },
      );
    } else {
      element = document.createElement(state.controlStyle?.ownerDraw ? 'canvas' : 'div');
      if (state.controlStyle?.ownerDraw) canvas = element;
      element.className = 'virtual-desktop-control virtual-desktop-control-static';
      element.tabIndex = -1;
      element.setAttribute('aria-readonly', 'true');
    }

    element.dataset.windowId = String(state.id);
    element.dataset.parentId = String(state.parentId);
    element.dataset.controlType = controlType;
    element.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      if (control.comboPopup) {
        event.preventDefault();
        const host = this.windows.get(control.comboHostId);
        if (host) this.#focus(host);
      } else this.#focus(control);
      if (
        control.controlType === 'button' &&
        control.controlStyle?.ownerDraw &&
        event.button === 0
      ) {
        element.setPointerCapture(event.pointerId);
        this.#sendMouse(control, 'mousedown', event);
      }
    });
    element.addEventListener('pointerup', (event) => {
      if (control.controlType === 'button' && control.controlStyle?.ownerDraw && event.button === 0)
        this.#sendMouse(control, 'mouseup', event);
    });
    element.addEventListener('pointercancel', () => {
      if (control.controlType === 'button' && control.controlStyle?.ownerDraw)
        this.#emit(control.id, 'button-cancel');
    });
    element.addEventListener('focusin', () =>
      this.#focus(control.comboPopup ? this.windows.get(control.comboHostId) : control),
    );
    element.addEventListener('mousemove', (event) => {
      event.stopPropagation();
      if (control.listState?.nativePointer || control.comboPointerId != null) return;
      this.#sendMouse(control, 'mousemove', event);
    });
    for (const type of ['keydown', 'keyup'])
      element.addEventListener(type, (event) => {
        event.stopPropagation();
        if (
          (['treeview', 'tabcontrol'].includes(controlType) &&
            ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
              event.key,
            )) ||
          ((this.#topLevel(control)?.isDialog || control.controlStyle?.subclassed) &&
            ['Tab', 'Enter', 'Escape'].includes(event.key) &&
            !(event.key === 'Enter' && control.multiline && control.controlStyle?.wantReturn))
        )
          event.preventDefault();
        if (
          ((controlType === 'button' && control.controlStyle?.ownerDraw) ||
            control.nativeCombo ||
            control.comboPopup) &&
          [
            ' ',
            'Enter',
            'Escape',
            'F4',
            'ArrowDown',
            'ArrowUp',
            'PageDown',
            'PageUp',
            'Home',
            'End',
          ].includes(event.key)
        )
          event.preventDefault();
        // Chromium on macOS interprets Control+H as delete-backward inside
        // inputs. Native accelerator keys must not also edit browser text.
        // Retain the browser's ordinary selection/clipboard/undo shortcuts.
        if (
          (event.ctrlKey || event.metaKey || event.altKey) &&
          event.key.length === 1 &&
          !['a', 'c', 'v', 'x', 'y', 'z'].includes(event.key.toLowerCase())
        )
          event.preventDefault();
        this.#sendKey(event, type, control.id, controlType === 'custom');
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
      legend,
      listSelect,
      listEdit,
      tabList,
      nativeCombo:
        controlType === 'combobox' &&
        !!(state.controlStyle?.ownerDraw || state.controlStyle?.nativeCombo),
      canvas,
      context: canvas?.getContext('2d', { alpha: false }),
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
    if (state.comboPopup) this.container.append(container);
    else parent.viewport.prepend(container);
    this.#applyControlState(control, state);
    return control;
  }

  #applyList(control, list) {
    if (control.nativeCombo) {
      if (control.listState?.comboPointer && !list.comboPointer && control.comboPointerId != null) {
        const id = control.comboPointerId;
        control.comboPointerId = null;
        if (control.element.hasPointerCapture(id)) control.element.releasePointerCapture(id);
      }
      control.listState = list;
      control.element.setAttribute('aria-expanded', String(!!list.dropped));
      control.element.dataset.comboType = String(list.comboType);
      const text = control.element.querySelector('.virtual-desktop-combo-text');
      if (text) text.textContent = control.titleText ?? '';
      control.element.setAttribute('aria-disabled', String(!control.enabled));
      const arrow = control.element.querySelector('.virtual-desktop-combo-arrow');
      if (arrow) {
        arrow.disabled = !control.enabled;
        arrow.setAttribute('aria-pressed', String(!!list.comboButtonDown));
      }
      return;
    }
    if (control.tabList) {
      control.element.tabIndex = control.enabled ? 0 : -1;
      control.element.setAttribute('aria-disabled', String(!control.enabled));
      this.#applyTabList(control, list);
      if (control.listState?.tracking && !list.tracking && control.listPointerId != null) {
        const pointerId = control.listPointerId;
        control.listPointerId = null;
        if (control.element.hasPointerCapture(pointerId))
          control.element.releasePointerCapture(pointerId);
      }
      control.listState = list;
      return;
    }
    const select = control.listSelect;
    const previous = control.listState;
    if (!previous || JSON.stringify(previous.items) !== JSON.stringify(list.items)) {
      const fragment = document.createDocumentFragment();
      for (const item of list.items) {
        const option = document.createElement('option');
        option.value = String(item.id);
        option.textContent = item.text;
        fragment.append(option);
      }
      select.replaceChildren(fragment);
    }
    select.selectedIndex = list.selected;
    if (control.controlType === 'listbox' || list.comboType === 1)
      select.size = Math.max(
        2,
        Math.floor((control.height - (list.comboType === 1 ? 22 : 0)) / list.itemHeight),
      );
    select.disabled = !control.enabled;
    if (control.listEdit) {
      control.listEdit.disabled = !control.enabled;
      control.listEdit.maxLength = list.textLimit ?? 32767;
      if (list.selection)
        control.listEdit.setSelectionRange(list.selection.start, list.selection.end);
    }
    control.listState = list;
  }

  #applyTabList(control, list) {
    const element = control.element,
      font = getComputedStyle(element).font;
    const measurement = document.createElement('canvas').getContext('2d');
    measurement.font = font;
    const base = Math.max(
      1,
      Math.floor(
        (measurement.measureText('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz').width /
          26 +
          1) /
          2,
      ),
    );
    const stops = (list.tabStops ?? []).map((value) => (value * base) / 4);
    const nextTab = (x) =>
      stops.length === 1
        ? (Math.floor(x / stops[0]) + 1) * stops[0]
        : (stops.find((stop) => stop > x) ?? (Math.floor(x / (8 * base)) + 1) * 8 * base);
    control.listOffsets = [];
    let offset = 0;
    for (const item of list.items) {
      control.listOffsets.push(offset);
      offset += item.height ?? list.itemHeight;
    }
    const scrollTop = element.scrollTop,
      fragment = document.createDocumentFragment();
    element.removeAttribute('aria-activedescendant');
    element.setAttribute('aria-multiselectable', String(!!list.multiple));
    for (const [index, item] of list.items.entries()) {
      const row = document.createElement('div');
      row.className = 'virtual-desktop-tablist-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-label', item.text || `Item ${index + 1}`);
      row.setAttribute(
        'aria-selected',
        String(list.multiple ? item.selected : index === list.selected),
      );
      row.id = `guest-list-${control.id}-${item.id}`;
      if (list.multiple) row.dataset.caret = String(index === list.caret);
      row.style.height = `${item.height ?? list.itemHeight}px`;
      if (index === (list.multiple ? list.caret : list.selected))
        element.setAttribute('aria-activedescendant', row.id);
      let x = 0;
      for (const [column, text] of (list.ownerDraw ? [] : item.text.split('\t')).entries()) {
        if (column) x = nextTab(x);
        const span = document.createElement('span');
        span.textContent = text;
        span.style.left = `${x + 2}px`;
        row.append(span);
        x += measurement.measureText(text).width;
      }
      row.addEventListener('click', (event) => {
        if (control.enabled && !control.listState?.drag && !control.listState?.nativePointer)
          this.#emit(control.id, 'list-select', {
            index,
            shiftKey: event.shiftKey,
            ctrlKey: event.ctrlKey || event.metaKey,
          });
      });
      fragment.append(row);
    }
    if (list.nativePointer || list.ownerDraw) {
      const spacer = document.createElement('div');
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.height = `${Math.max(0, (control.listOffsets[list.maxTop] ?? 0) + element.clientHeight - offset)}px`;
      fragment.append(spacer);
    }
    element.replaceChildren(fragment);
    element.scrollTop = scrollTop;
    if (list.nativePointer || list.ownerDraw || list.multiple)
      element.scrollTop = control.listOffsets[list.top] ?? 0;
    else if (control.listState?.top !== list.top) element.scrollTop = list.top * list.itemHeight;
    else if (control.listState?.selected !== list.selected && list.selected >= 0)
      element.children[list.selected]?.scrollIntoView({ block: 'nearest' });
    element.style.cursor = { 1: 'not-allowed', 2: 'copy', 3: 'move' }[list.drag?.cursor] ?? '';
    control.viewport.querySelector('.virtual-desktop-list-insert')?.remove();
    if (list.drag?.marker >= 0) {
      const marker = document.createElement('div');
      marker.className = 'virtual-desktop-list-insert';
      marker.setAttribute('aria-hidden', 'true');
      marker.style.top = `${(list.drag.marker - list.top) * list.itemHeight}px`;
      control.viewport.append(marker);
    }
  }

  #applyToolbar(control, bar) {
    const focused = control.element.contains(document.activeElement)
      ? document.activeElement.dataset.toolbarCommand
      : undefined;
    const fragment = document.createDocumentFragment();
    for (const item of bar.buttons) {
      if (!item.rect || item.state & 8) continue;
      const [left, top, right, bottom] = item.rect;
      const button = document.createElement(item.style & 1 ? 'div' : 'button');
      button.dataset.toolbarCommand = String(item.command);
      button.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;`;
      if (item.style & 1) {
        button.className = 'virtual-desktop-toolbar-separator';
        button.setAttribute('role', 'separator');
      } else {
        button.type = 'button';
        button.className = 'virtual-desktop-toolbar-button';
        button.disabled = !control.enabled || !(item.state & 4);
        button.title = item.text || item.image?.label || '';
        button.setAttribute('aria-label', item.text || item.image?.label || 'Toolbar button');
        if (item.style & 2) button.setAttribute('aria-pressed', String(!!(item.state & 1)));
        button.classList.toggle('virtual-desktop-toolbar-pressed', !!(item.state & 3));
        button.classList.toggle('virtual-desktop-toolbar-indeterminate', !!(item.state & 16));
        if (item.image) {
          const canvas = document.createElement('canvas');
          canvas.width = item.image.width;
          canvas.height = item.image.height;
          canvas
            .getContext('2d')
            .putImageData(
              new ImageData(new Uint8ClampedArray(item.image.pixels), canvas.width, canvas.height),
              0,
              0,
            );
          button.append(canvas);
        }
        if (item.text && bar.showText) button.append(document.createTextNode(item.text));
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!button.disabled)
            this.#emit(control.id, 'toolbar-command', { command: item.command });
        });
      }
      fragment.append(button);
    }
    control.element.replaceChildren(fragment);
    if (focused !== undefined)
      [...control.element.children]
        .find((e) => e.dataset.toolbarCommand === focused && !e.disabled)
        ?.focus({ preventScroll: true });
  }

  #applyStatusbar(control, bar) {
    const element = control.element;
    element.style.backgroundColor =
      bar.background === 0xff000000
        ? '#c0c0c0'
        : `rgb(${bar.background & 255},${(bar.background >>> 8) & 255},${(bar.background >>> 16) & 255})`;
    element.dataset.simple = String(bar.simple);
    const fragment = document.createDocumentFragment();
    bar.parts.forEach((part, index) => {
      const row = document.createElement('div'),
        [left, top, right, bottom] = part.rect;
      row.dataset.statusPart = String(bar.simple ? 255 : index);
      row.title = part.tip;
      Object.assign(row.style, {
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: `${Math.max(0, right - left)}px`,
        height: `${Math.max(0, bottom - top)}px`,
        boxSizing: 'border-box',
        overflow: 'hidden',
        whiteSpace: 'pre',
        padding: '1px 4px',
        border: part.style & 0x100 ? '0' : `2px ${part.style & 0x200 ? 'outset' : 'inset'} #ddd`,
        direction: part.style & 0x400 ? 'rtl' : 'ltr',
      });
      if (part.style & 0x800 || !part.text.includes('\t')) row.textContent = part.text;
      else {
        const labels = part.text.split('\t').slice(0, 3);
        ['left', 'center', 'right'].forEach((align, i) => {
          const label = document.createElement('span');
          label.textContent = labels[i] ?? '';
          Object.assign(label.style, {
            position: 'absolute',
            left: '4px',
            right: '4px',
            textAlign: align,
          });
          row.append(label);
        });
      }
      fragment.append(row);
    });
    if (bar.sizeGrip && !control.statusGrip) {
      const grip = document.createElement('div');
      control.statusGrip = grip;
      grip.className = 'virtual-desktop-status-grip';
      grip.style.zIndex = '1';
      grip.setAttribute('aria-label', 'Resize window');
      Object.assign(grip.style, {
        position: 'absolute',
        right: '0',
        bottom: '0',
        width: '14px',
        height: '14px',
        cursor: 'nwse-resize',
        touchAction: 'none',
        background:
          'repeating-linear-gradient(135deg, transparent 0 3px, #888 3px 4px, #fff 4px 5px)',
      });
      grip.addEventListener('pointerdown', (event) => {
        const window = this.#topLevel(control);
        if (event.button !== 0 || !this.#available(control) || !window?.frame?.resizable) return;
        event.preventDefault();
        event.stopPropagation();
        this.#focus(window);
        grip.setPointerCapture(event.pointerId);
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
      grip.addEventListener('pointermove', (event) => this.#moveDrag(event));
      grip.addEventListener('pointerup', (event) => this.#endDrag(event));
      grip.addEventListener('pointercancel', (event) => this.#endDrag(event));
    }
    // Keep the grip attached through native layout callbacks so its pointer
    // capture survives continuous resizing while status text changes.
    for (const child of [...element.children]) if (child !== control.statusGrip) child.remove();
    element.append(fragment);
    if (bar.sizeGrip) {
      if (control.statusGrip.parentNode !== element) element.append(control.statusGrip);
    } else control.statusGrip?.remove();
  }

  #applyTree(control, tree) {
    const color = (value) => `rgb(${value & 255},${(value >>> 8) & 255},${(value >>> 16) & 255})`;
    control.element.style.backgroundColor = color(tree.background);
    control.element.style.color = color(tree.color);
    const scrollTop = control.element.scrollTop;
    control.element.removeAttribute('aria-activedescendant');
    const fragment = document.createDocumentFragment();
    for (const item of tree.rows) {
      const row = document.createElement('div');
      row.className = 'virtual-desktop-tree-row';
      row.dataset.treeItem = String(item.id);
      row.id = `guest-tree-${control.id}-${item.id}`;
      if (item.selected) control.element.setAttribute('aria-activedescendant', row.id);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(item.depth + 1));
      row.setAttribute('aria-selected', String(item.selected));
      if (item.hasChildren) row.setAttribute('aria-expanded', String(item.expanded));
      row.style.height = `${tree.itemHeight}px`;
      row.style.paddingLeft = `${item.depth * tree.indent}px`;
      const toggle = document.createElement('span');
      toggle.className = 'virtual-desktop-tree-toggle';
      toggle.textContent = item.hasChildren ? (item.expanded ? '−' : '+') : '';
      toggle.setAttribute('aria-hidden', 'true');
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (control.enabled && item.hasChildren)
          this.#emit(control.id, 'tree-expand', { item: item.id });
      });
      const text = document.createElement('span');
      text.className = 'virtual-desktop-tree-label';
      text.textContent = item.text;
      if (item.bold) text.style.fontWeight = 'bold';
      row.append(toggle, text);
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        if (control.enabled) {
          control.element.focus();
          this.#emit(control.id, 'tree-select', { item: item.id });
        }
      });
      row.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        if (control.enabled && item.hasChildren)
          this.#emit(control.id, 'tree-expand', { item: item.id });
      });
      fragment.append(row);
    }
    control.element.replaceChildren(fragment);
    control.element.scrollTop = scrollTop;
  }

  #applyTabs(control, tabs) {
    const fragment = document.createDocumentFragment();
    for (const [index, item] of tabs.items.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(index === tabs.selected));
      button.id = `guest-tab-${control.id}-${item.id}`;
      button.textContent = item.displayText ?? item.text;
      button.tabIndex = -1;
      button.addEventListener('mousedown', (event) => {
        event.preventDefault();
        control.element.focus({ preventScroll: true });
      });
      button.classList.toggle('is-highlighted', item.highlighted);
      const [left, top, right, bottom] = item.rect;
      Object.assign(button.style, {
        left: `${left}px`,
        top: `${top}px`,
        width: `${right - left}px`,
        height: `${bottom - top}px`,
      });
      button.addEventListener('click', () => {
        if (control.enabled) this.#emit(control.id, 'tab-select', { item: item.id });
      });
      fragment.append(button);
    }
    control.element.replaceChildren(fragment);
    const focused = tabs.items[tabs.focused];
    if (focused)
      control.element.setAttribute(
        'aria-activedescendant',
        `guest-tab-${control.id}-${focused.id}`,
      );
    else control.element.removeAttribute('aria-activedescendant');
  }

  #applyControlState(control, state) {
    control.acceptFiles = state.acceptFiles ?? control.acceptFiles ?? false;
    if (state.controlId !== undefined) control.element.dataset.controlId = String(state.controlId);
    if (state.title !== undefined) control.titleText = String(state.title);
    const noPrefix = state.noPrefix ?? state.controlStyle?.noPrefix;
    if (state.title !== undefined || (noPrefix !== undefined && noPrefix !== control.noPrefix)) {
      if (control.controlType === 'edit') {
        // Avoid disrupting caret selection during incremental WM_SETTEXT echo.
        if (control.element.value !== control.titleText) control.element.value = control.titleText;
      } else if (['listbox', 'combobox'].includes(control.controlType)) {
        if (control.listEdit && control.listEdit.value !== control.titleText)
          control.listEdit.value = control.titleText;
      } else if (['treeview', 'tabcontrol'].includes(control.controlType)) {
        control.element.setAttribute('aria-label', control.titleText || 'Categories');
      } else if (control.controlType === 'statusbar') {
        // The part model owns rendered text; WM_SETTEXT updates part zero.
      } else if (control.canvas) {
        control.element.setAttribute('aria-label', control.titleText);
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
        : control.controlType === 'button' && !control.controlStyle?.ownerDraw
          ? ''
          : '0';
    }
    const controlStyle = state.controlStyle ?? {};
    if (control.controlType === 'static' && !control.canvas) {
      control.element.style.whiteSpace = controlStyle.noWordWrap ? 'pre' : 'pre-wrap';
      control.element.style.display = controlStyle.centerImage ? 'flex' : '';
      control.element.style.alignItems = controlStyle.centerImage ? 'center' : '';
    }
    if (control.controlType === 'button' && state.controlStyle) {
      const style = state.controlStyle;
      control.buttonType = style.buttonType ?? control.buttonType;
      control.toggle = !!style.toggle || !!style.triState;
      control.triState = !!style.triState;
      control.element.dataset.buttonType = control.buttonType;
      if (control.toggle && !style.pushLike)
        control.element.setAttribute(
          'role',
          control.buttonType.includes('radio') ? 'radio' : 'checkbox',
        );
      else control.element.removeAttribute('role');
      if (control.toggle && !style.pushLike)
        control.element.setAttribute('aria-label', stripCaptionMnemonics(control.titleText ?? ''));
      else if (control.canvas)
        control.element.setAttribute('aria-label', stripCaptionMnemonics(control.titleText ?? ''));
      else control.element.removeAttribute('aria-label');
      // The native control reports a three-state button's indeterminate state
      // through aria-checked="mixed"; a checkbox uses the checked attribute.
      if (control.toggle) {
        const checked = (style.checkState ?? state.checkState ?? 0) === 1;
        control.element.setAttribute('aria-checked', checked ? 'true' : 'false');
        if (control.triState)
          control.element.setAttribute(
            'aria-checked',
            (style.checkState ?? state.checkState ?? 0) === 2
              ? 'mixed'
              : checked
                ? 'true'
                : 'false',
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
    if (control.controlType === 'edit') control.element.maxLength = state.textLimit ?? 32767;
    if (control.controlType === 'edit' && state.selection)
      control.nativeSelection = { ...state.selection };
    if (
      control.controlType === 'edit' &&
      state.selection &&
      (control.element.selectionStart !== state.selection.start ||
        control.element.selectionEnd !== state.selection.end)
    )
      control.element.setSelectionRange(state.selection.start, state.selection.end);
    if (control.controlType === 'edit') {
      const multiline = !!(state.controlStyle?.multiline ?? control.multiline);
      control.multiline = multiline;
      control.uppercase = !!(state.controlStyle?.uppercase ?? control.uppercase);
      control.lowercase = !!(state.controlStyle?.lowercase ?? control.lowercase);
      control.number = !!(state.controlStyle?.number ?? control.number);
      if (control.element.tagName === 'INPUT' && state.controlStyle?.password !== undefined)
        control.element.type = state.controlStyle.password ? 'password' : 'text';
      if (state.controlStyle?.verticalScroll !== undefined)
        control.element.style.overflowY = state.controlStyle.verticalScroll ? 'scroll' : '';
      if (state.controlStyle?.horizontalScroll !== undefined)
        control.element.style.overflowX = state.controlStyle.horizontalScroll ? 'scroll' : '';
      // A multiline edit wraps by default; ES_AUTOHSCROLL turns wrapping off.
      if (multiline)
        control.element.style.whiteSpace = state.controlStyle?.autoHScroll ? 'pre' : 'pre-wrap';
    }
    // Native group boxes are transparent to mouse hits over sibling controls.
    const hitStyle = state.controlStyle ?? control.controlStyle;
    control.container.style.pointerEvents =
      hitStyle?.groupBox || hitStyle?.buttonType === 'group-box' ? 'none' : 'auto';
    if (state.controlColors) {
      const color = (value) =>
        `rgb(${value & 255}, ${(value >>> 8) & 255}, ${(value >>> 16) & 255})`;
      const colors = state.controlColors;
      control.element.style.color = color(colors.text);
      control.element.style.backgroundColor = colors.transparent
        ? 'transparent'
        : color(colors.background);
      control.element.style.backgroundImage = '';
      if (colors.pattern || colors.hatch !== undefined) {
        const canvas = document.createElement('canvas');
        const width = colors.pattern?.width ?? 8,
          height = colors.pattern?.height ?? 8;
        canvas.width = width;
        canvas.height = height;
        const pixels = new Uint8ClampedArray(width * height * 4);
        paintRect(
          { width, height, pixels },
          0,
          0,
          width,
          height,
          { color: colors.background, hatch: colors.hatch, pattern: colors.pattern },
          'copy',
          {
            textColor: colors.text,
            backgroundColor: colors.hatchBackground,
            bkMode: colors.backgroundMode,
            brushOriginX: colors.brushOriginX,
            brushOriginY: colors.brushOriginY,
          },
        );
        canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
        control.element.style.backgroundImage = `url(${canvas.toDataURL()})`;
        control.element.style.backgroundColor =
          !colors.pattern && colors.backgroundMode === 1
            ? 'transparent'
            : color(colors.hatchBackground);
      }
    }
    if (state.font !== undefined) control.element.style.font = state.font?.css ?? '';
    if (state.progress || state.report)
      applyReportControl(control.element, state, (type, data) =>
        this.#emit(control.id, type, data),
      );
    if (state.list && (control.listSelect || control.tabList || control.nativeCombo))
      this.#applyList(control, state.list);
    if (control.controlType === 'treeview' && state.tree) this.#applyTree(control, state.tree);
    if (control.controlType === 'tabcontrol' && state.tabs) this.#applyTabs(control, state.tabs);
    if (control.controlType === 'toolbar' && state.toolbar)
      this.#applyToolbar(control, state.toolbar);
    if (control.controlType === 'statusbar' && state.statusbar)
      this.#applyStatusbar(control, state.statusbar);

    control.isControl = true;
    control.controlType = state.controlType ?? control.controlType;
    control.parentId = state.parentId ?? control.parentId;
    if (state.controlStyle !== undefined) control.controlStyle = state.controlStyle;
    if (state.font !== undefined) control.font = state.font;
    const parent = this.windows.get(control.parentId) ?? control.parent;
    if (state.comboPopup !== undefined) control.comboPopup = !!state.comboPopup;
    if (state.comboHostId !== undefined) control.comboHostId = state.comboHostId;
    if (parent && parent !== control.parent && !control.comboPopup)
      parent.viewport.append(control.container);
    control.parent = parent;
    control.zOrder = state.zOrder ?? control.zOrder ?? 0;
    this.#applyControlGeometry(control);
  }

  #applyControlGeometry(control) {
    let x = control.x,
      y = control.y;
    if (control.comboPopup && control.parent) {
      const origin = control.parent.viewport.getBoundingClientRect(),
        desktop = this.container.getBoundingClientRect();
      x += origin.left - desktop.left - this.container.clientLeft;
      y += origin.top - desktop.top - this.container.clientTop;
    }
    Object.assign(control.container.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${control.width}px`,
      height: `${control.height}px`,
    });
    Object.assign(control.element.style, { left: '0', top: '0', width: '100%', height: '100%' });
    control.viewport.style.inset = `${control.controlBorder ?? 0}px`;
    if (!control.comboPopup)
      for (const popup of this.windows.values())
        if (popup.comboPopup) this.#applyControlGeometry(popup);
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
    const border =
      window.controlType === 'custom' || window.tabList ? (window.controlBorder ?? 0) : 0;
    this.#emit(window.id, type, {
      x: Math.round(event.clientX - rect.left - border),
      y: Math.round(event.clientY - rect.top - border),
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey || (window.tabList && event.metaKey),
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
      if (this.openMenu?.window === existing) this.#closeMenu();
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

    if ((state.parentId && state.controlType) || existing?.isControl) {
      let control = existing;
      if (control?.listSelect && state.controlType === 'listbox' && state.list?.drag) {
        const replacement = this.#createControl(state);
        replacement.viewport.append(...control.viewport.childNodes);
        control.container.remove();
        control = replacement;
      }
      control ??= this.#createControl(state);
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
      isDialog: state.isDialog ?? window.isDialog,
      acceptFiles: state.acceptFiles ?? window.acceptFiles ?? false,
      topmost: state.topmost ?? window.topmost ?? false,
      zOrder: state.zOrder ?? window.zOrder ?? ++this.nextZIndex,
    });
    window.titleElement.textContent = window.titleText;
    this.#applyIcon(window, state.icon);
    this.#applyMenu(window, state.menu);
    if (state.enabled !== undefined) {
      window.enabled = !!state.enabled;
      window.element.inert = !window.enabled;
    }
    window.titleElement.title = window.titleText;
    window.titlebar.querySelector('button').setAttribute('aria-label', `Close ${window.titleText}`);
    if (state.visible !== undefined) {
      const visible = state.visible && !state.minimized;
      this.#setVisibility(window, visible);
      const active = this.windows.get(this.activeWindowId);
      if (!visible && this.#descendantOf(active, state.id)) {
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

  frame({
    windowId,
    width,
    height,
    pixels,
    bitmap,
    renderer,
    graphicsApi,
    graphicsFrames,
    graphicsDraws,
    graphicsModelView,
  }) {
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
    // Standard controls keep their native DOM identity and input behavior.
    // A separate transparent client canvas displays guest GDI above them,
    // below child HWNDs, without intercepting any pointer events.
    if (!window.canvas && !window.drawingCanvas) {
      const overlay = document.createElement('canvas');
      overlay.className = 'virtual-desktop-control-drawing';
      overlay.dataset.windowId = String(windowId);
      Object.assign(overlay.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      });
      window.viewport.prepend(overlay);
      window.drawingCanvas = overlay;
      window.drawingContext = overlay.getContext('2d');
    }
    const canvas = window.canvas ?? window.drawingCanvas,
      context = window.context ?? window.drawingContext;
    if (bitmap) {
      try {
        if (bitmap.width !== width || bitmap.height !== height) return false;
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
          window.imageData = null;
        }
        context.clearRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0);
        canvas.dataset.renderer = renderer ?? 'bitmap';
        canvas.dataset.graphicsApi = graphicsApi ?? (renderer === 'webgpu' ? 'd3d9' : '');
        canvas.dataset.graphicsFrames = String(graphicsFrames ?? 0);
        // Presenting the frame count alone cannot distinguish "nothing was
        // drawn" from "everything was cleared"; publish the draw count too.
        // Publishing the draw count alongside the frame count lets a caller
        // distinguish "nothing was drawn" from "everything was cleared".
        if (graphicsDraws !== undefined) canvas.dataset.graphicsDraws = String(graphicsDraws);
        if (graphicsModelView) canvas.dataset.graphicsModelView = JSON.stringify(graphicsModelView);
        return true;
      } finally {
        bitmap.close();
      }
    }
    const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);
    if (bytes.byteLength !== width * height * 4) return false;
    if (!window.imageData || canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      window.imageData = context.createImageData(width, height);
    }
    window.imageData.data.set(bytes);
    context.putImageData(window.imageData, 0, 0);
    if (graphicsApi !== undefined) canvas.dataset.graphicsApi = graphicsApi;
    if (graphicsFrames !== undefined) canvas.dataset.graphicsFrames = String(graphicsFrames);
    if (renderer !== undefined) canvas.dataset.renderer = renderer;
    return true;
  }

  reset() {
    this.#closeMenu(false);
    this.#removeCursorOverlay();
    this.cursorPoint = null;
    this.container.style.removeProperty('--guest-cursor');
    this.cursorImages.clear();
    this.windows.clear();
    this.activeWindowId = null;
    this.drag = null;
    this.nextZIndex = 1;
    this.container.replaceChildren();
  }
}
