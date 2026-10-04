// DOM presentation of native common controls. Guest state/notifications remain
// in the runtime; browser selection is an event queued by the desktop.
import './desktop-report.css';
export function createReportControl(kind) {
  const element = document.createElement(kind === 'progress' ? 'progress' : 'div');
  element.className = 'virtual-desktop-control';
  if (kind === 'progress') element.classList.add('virtual-desktop-control-progress');
  if (kind === 'listview') {
    element.setAttribute('role', 'grid');
    element.setAttribute('aria-label', 'Report');
    element.tabIndex = 0;
    element.style.overflow = 'auto';
    element.style.background = 'white';
  }
  return element;
}
export function applyReportControl(element, state, emit) {
  if (state.progress) {
    const p = state.progress;
    element.max = Math.max(1, p.high - p.low);
    if (p.marquee) element.removeAttribute('value');
    else element.value = Math.max(0, p.position - p.low);
    element.setAttribute('aria-valuemin', String(p.low));
    element.setAttribute('aria-valuemax', String(p.high));
    element.setAttribute('aria-valuenow', String(p.position));
    const color = (value) => `rgb(${value & 255},${(value >>> 8) & 255},${(value >>> 16) & 255})`;
    const foreground =
      p.foreground === 0xff000000
        ? p.state === 2
          ? '#b91c1c'
          : p.state === 3
            ? '#ca8a04'
            : '#16803c'
        : color(p.foreground);
    element.style.accentColor = foreground;
    element.style.setProperty('--progress-foreground', foreground);
    element.style.setProperty(
      '--progress-background',
      p.background === 0xff000000 ? '#e6e6e6' : color(p.background),
    );
  }
  if (!state.report) return;
  const report = state.report,
    scroll = element.scrollTop;
  element.replaceChildren();
  const row = (texts, header, item) => {
    const node = document.createElement('div');
    node.setAttribute('role', 'row');
    node.style.display = 'flex';
    node.style.minHeight = '20px';
    if (item) {
      node.dataset.reportItem = String(item.id);
      node.setAttribute('aria-selected', String(!!(item.state & 2)));
      if (item.state & 2) {
        node.style.background = '#2463aa';
        node.style.color = 'white';
      }
      if (item.state & 1) node.style.outline = '1px dotted currentColor';
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        emit('report-select', { item: item.id, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey });
      });
    }
    report.columns.forEach((column, index) => {
      const cell = document.createElement('div');
      cell.setAttribute('role', header ? 'columnheader' : 'gridcell');
      cell.style.flex = `0 0 ${column.width}px`;
      cell.style.padding = '1px 4px';
      cell.style.boxSizing = 'border-box';
      cell.style.whiteSpace = 'pre';
      cell.style.overflow = 'hidden';
      cell.style.textAlign = ['left', 'right', 'center'][column.format] ?? 'left';
      cell.textContent = header ? column.text : (texts[column.subitem ?? index] ?? '');
      node.append(cell);
    });
    element.append(node);
  };
  if (report.header) row([], true);
  for (const item of report.items) row(item.texts, false, item);
  element.scrollTop = scroll;
}
