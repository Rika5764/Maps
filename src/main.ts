import "./styles.css";

type RectItem = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
};

type ProjectFile = {
  version: 1;
  map: {
    widthMeters: number;
    heightMeters: number;
  };
  rects: RectItem[];
};

type StoredProject = {
  id: "default";
  savedAt: number;
  project: ProjectFile;
};

type Viewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

type HistoryEntry =
  | { kind: "create"; rect: RectItem }
  | { kind: "delete"; rect: RectItem; index: number }
  | { kind: "label"; id: string; before: string; after: string };

type DragState = {
  pointerId: number;
  startWorld: Point;
  lastWorld: Point;
  currentRect: RectItem | null;
  startedOnRectId: string | null;
  moved: boolean;
};

type PinchState = {
  pointers: Map<number, Point>;
  startDistance: number;
  startCenter: Point;
  startScale: number;
  startOffsetX: number;
  startOffsetY: number;
  worldAtCenter: Point;
};

type Point = {
  x: number;
  y: number;
};

const STORAGE_KEY = "kaufland-map-project-v1";
const DB_NAME = "kaufland-map-db";
const DB_VERSION = 1;
const PROJECT_STORE = "projects";
const PROJECT_ID = "default";
const FIXED_MAP_SIZE = { widthMeters: 110, heightMeters: 60 } as const;
const MIN_SCALE = 6;
const MAX_SCALE = 160;
const TAP_MOVE_THRESHOLD = 8;
const DEFAULT_PROJECT: ProjectFile = {
  version: 1,
  map: { ...FIXED_MAP_SIZE },
  rects: [],
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("App root not found.");
}

app.innerHTML = `
  <main class="shell">
    <canvas id="mapCanvas" aria-label="Kaufland indoor map editor"></canvas>

    <section class="top-panel" aria-label="Map controls">
      <div class="brand">
        <strong>Kaufland Map</strong>
        <span><span id="scaleReadout">100%</span> · <span id="saveReadout">本地保存</span></span>
      </div>
      <div class="map-size" aria-label="Map size">长 110m · 宽 60m</div>
      <div class="tool-row">
        <button id="undoButton" class="icon-button" type="button" aria-label="撤销" title="撤销">↶</button>
        <button id="deleteButton" class="icon-button" type="button" aria-label="删除工具" title="删除工具">⌫</button>
        <button id="exportSvgButton" class="command-button" type="button">SVG</button>
        <button id="exportJsonButton" class="command-button" type="button">JSON</button>
        <button id="importJsonButton" class="command-button" type="button">导入</button>
      </div>
    </section>

    <section id="labelEditor" class="label-editor" aria-label="Rectangle label editor" hidden>
      <input id="labelInput" type="text" autocomplete="off" placeholder="区域名称" />
      <button id="clearSelectionButton" class="compact-button" type="button">完成</button>
    </section>

    <input id="fileInput" type="file" accept="application/json,.json" hidden />
  </main>
`;

function mustElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Required UI element not found: ${selector}`);
  }

  return element;
}

const canvas = mustElement<HTMLCanvasElement>("#mapCanvas");
const scaleReadout = mustElement<HTMLSpanElement>("#scaleReadout");
const saveReadout = mustElement<HTMLSpanElement>("#saveReadout");
const undoButton = mustElement<HTMLButtonElement>("#undoButton");
const deleteButton = mustElement<HTMLButtonElement>("#deleteButton");
const exportSvgButton = mustElement<HTMLButtonElement>("#exportSvgButton");
const exportJsonButton = mustElement<HTMLButtonElement>("#exportJsonButton");
const importJsonButton = mustElement<HTMLButtonElement>("#importJsonButton");
const fileInput = mustElement<HTMLInputElement>("#fileInput");
const labelEditor = mustElement<HTMLElement>("#labelEditor");
const labelInput = mustElement<HTMLInputElement>("#labelInput");
const clearSelectionButton = mustElement<HTMLButtonElement>("#clearSelectionButton");

const canvasContext = canvas.getContext("2d");

if (!canvasContext) {
  throw new Error("2D canvas is not supported.");
}

const ctx = canvasContext;

const initialStoredProject = loadLocalProject();
let project: ProjectFile = initialStoredProject.project;
let viewport: Viewport = { scale: 12, offsetX: 0, offsetY: 0 };
let selectedRectId: string | null = null;
let deleteMode = false;
let dragState: DragState | null = null;
let pinchState: PinchState | null = null;
let activePointers = new Map<number, Point>();
let historyStack: HistoryEntry[] = [];
let labelBaseline = "";
let hasFittedInitialView = false;

setSaveStatus(initialStoredProject.savedAt > 0 ? "已保存" : "本地保存");

function loadLocalProject(): StoredProject {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  if (!stored) {
    return makeStoredProject(structuredClone(DEFAULT_PROJECT), 0);
  }

  try {
    return normalizeStoredProject(JSON.parse(stored));
  } catch {
    return makeStoredProject(structuredClone(DEFAULT_PROJECT), 0);
  }
}

function normalizeStoredProject(value: unknown): StoredProject {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid stored project.");
  }

  const candidate = value as Partial<StoredProject> & Partial<ProjectFile>;

  if (candidate.project) {
    return makeStoredProject(normalizeProject(candidate.project), Number(candidate.savedAt) || 0);
  }

  return makeStoredProject(normalizeProject(candidate), 0);
}

function normalizeProject(value: unknown): ProjectFile {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid project.");
  }

  const candidate = value as Partial<ProjectFile>;
  const map = { ...FIXED_MAP_SIZE };

  const rects = Array.isArray(candidate.rects)
    ? candidate.rects
        .map((rect, index) => normalizeRect(rect, index, map))
        .filter((rect): rect is RectItem => rect !== null)
    : [];

  return {
    version: 1,
    map,
    rects,
  };
}

function normalizeRect(value: unknown, index: number, map: ProjectFile["map"]): RectItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const rect = value as Partial<RectItem>;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  return clampRectToMapSize({
    id: typeof rect.id === "string" && rect.id.length > 0 ? rect.id : `r${index + 1}`,
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    label: typeof rect.label === "string" ? rect.label : "",
  }, map);
}

function makeStoredProject(nextProject: ProjectFile, savedAt = Date.now()): StoredProject {
  return {
    id: PROJECT_ID,
    savedAt,
    project: nextProject,
  };
}

function saveProject(): void {
  const storedProject = makeStoredProject(project);

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(storedProject));
    setSaveStatus("已保存");
  } catch {
    setSaveStatus("本地保存受限");
  }

  writeIndexedProject(storedProject).catch(() => setSaveStatus("本地保存受限"));
}

function setSaveStatus(text: string): void {
  saveReadout.textContent = text;
}

async function hydrateProjectFromIndexedDb(): Promise<void> {
  const localProject = loadLocalProject();
  const indexedProject = await readIndexedProject();

  if (!indexedProject || indexedProject.savedAt <= localProject.savedAt) {
    return;
  }

  project = indexedProject.project;
  historyStack = [];
  setSelectedRect(null);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(indexedProject));
  fitToMap();
  draw();
  setSaveStatus("已保存");
}

async function requestDurableStorage(): Promise<void> {
  if (!navigator.storage?.persisted || !navigator.storage.persist) {
    return;
  }

  const alreadyPersistent = await navigator.storage.persisted();

  if (!alreadyPersistent) {
    await navigator.storage.persist();
  }
}

function openProjectDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not available."));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        database.createObjectStore(PROJECT_STORE, { keyPath: "id" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function readIndexedProject(): Promise<StoredProject | null> {
  const database = await openProjectDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, "readonly");
    const store = transaction.objectStore(PROJECT_STORE);
    const request = store.get(PROJECT_ID);

    request.addEventListener("success", () => {
      try {
        resolve(request.result ? normalizeStoredProject(request.result) : null);
      } catch (error) {
        reject(error);
      } finally {
        database.close();
      }
    });

    request.addEventListener("error", () => {
      database.close();
      reject(request.error);
    });
  });
}

async function writeIndexedProject(storedProject: StoredProject): Promise<void> {
  const database = await openProjectDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PROJECT_STORE, "readwrite");
    const store = transaction.objectStore(PROJECT_STORE);
    const request = store.put(storedProject);

    request.addEventListener("success", () => resolve());
    request.addEventListener("error", () => reject(request.error));
    transaction.addEventListener("complete", () => {
      database.close();
      setSaveStatus("已保存");
    });
    transaction.addEventListener("error", () => {
      database.close();
      reject(transaction.error);
    });
  });
}

function resizeCanvas(): void {
  const bounds = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(bounds.width * dpr));
  canvas.height = Math.max(1, Math.round(bounds.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (!hasFittedInitialView) {
    fitToMap();
    hasFittedInitialView = true;
  }

  draw();
}

function fitToMap(): void {
  const bounds = canvas.getBoundingClientRect();
  const topInset = 170;
  const bottomInset = 72;
  const availableWidth = Math.max(1, bounds.width - 32);
  const availableHeight = Math.max(1, bounds.height - topInset - bottomInset);
  const scale = clamp(
    Math.min(availableWidth / project.map.widthMeters, availableHeight / project.map.heightMeters),
    MIN_SCALE,
    MAX_SCALE,
  );

  viewport.scale = scale;
  viewport.offsetX = 16;
  viewport.offsetY = topInset;
}

function draw(): void {
  const bounds = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, bounds.width, bounds.height);
  ctx.fillStyle = "#f7f3ea";
  ctx.fillRect(0, 0, bounds.width, bounds.height);

  drawGrid();
  drawRects();
  drawDraftRect();
  scaleReadout.textContent = `${Math.round(viewport.scale)} px/m`;
  undoButton.disabled = historyStack.length === 0;
}

function drawGrid(): void {
  const mapWidth = project.map.widthMeters;
  const mapHeight = project.map.heightMeters;
  const topLeft = worldToScreen({ x: 0, y: 0 });
  const bottomRight = worldToScreen({ x: mapWidth, y: mapHeight });

  ctx.save();
  ctx.fillStyle = "#fffaf0";
  ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);

  ctx.lineWidth = 1;
  for (let x = 0; x <= mapWidth; x += 1) {
    const screenX = Math.round(worldToScreen({ x, y: 0 }).x) + 0.5;
    ctx.strokeStyle = x % 5 === 0 ? "#d5cbb9" : "#e8dfcf";
    ctx.beginPath();
    ctx.moveTo(screenX, topLeft.y);
    ctx.lineTo(screenX, bottomRight.y);
    ctx.stroke();
  }

  for (let y = 0; y <= mapHeight; y += 1) {
    const screenY = Math.round(worldToScreen({ x: 0, y }).y) + 0.5;
    ctx.strokeStyle = y % 5 === 0 ? "#d5cbb9" : "#e8dfcf";
    ctx.beginPath();
    ctx.moveTo(topLeft.x, screenY);
    ctx.lineTo(bottomRight.x, screenY);
    ctx.stroke();
  }

  ctx.strokeStyle = "#594d3b";
  ctx.lineWidth = 2;
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
  ctx.restore();
}

function drawRects(): void {
  for (const rect of project.rects) {
    drawRect(rect, rect.id === selectedRectId);
  }
}

function drawRect(rect: RectItem, selected: boolean): void {
  const topLeft = worldToScreen({ x: rect.x, y: rect.y });
  const width = rect.width * viewport.scale;
  const height = rect.height * viewport.scale;

  ctx.save();
  ctx.fillStyle = selected ? "rgba(42, 110, 93, 0.18)" : "rgba(129, 89, 40, 0.16)";
  ctx.strokeStyle = selected ? "#1f6f60" : "#76542d";
  ctx.lineWidth = selected ? 3 : 2;
  ctx.fillRect(topLeft.x, topLeft.y, width, height);
  ctx.strokeRect(topLeft.x, topLeft.y, width, height);

  if (rect.label.trim()) {
    const fontSize = clamp(viewport.scale * 0.44, 11, 18);
    ctx.fillStyle = "#2d2a24";
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    drawWrappedText(rect.label, topLeft.x + width / 2, topLeft.y + height / 2, Math.max(10, width - 8), fontSize * 1.25);
  }

  ctx.restore();
}

function drawWrappedText(text: string, centerX: number, centerY: number, maxWidth: number, lineHeight: number): void {
  const words = Array.from(text.trim());
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const next = `${line}${word}`;
    if (ctx.measureText(next).width <= maxWidth || line.length === 0) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) {
    lines.push(line);
  }

  const visibleLines = lines.slice(0, 3);
  const startY = centerY - ((visibleLines.length - 1) * lineHeight) / 2;
  visibleLines.forEach((visibleLine, index) => {
    ctx.fillText(visibleLine, centerX, startY + index * lineHeight);
  });
}

function drawDraftRect(): void {
  if (!dragState?.currentRect) {
    return;
  }

  const rect = dragState.currentRect;
  const topLeft = worldToScreen({ x: rect.x, y: rect.y });

  ctx.save();
  ctx.fillStyle = "rgba(48, 102, 190, 0.14)";
  ctx.strokeStyle = "#2f64b1";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(topLeft.x, topLeft.y, rect.width * viewport.scale, rect.height * viewport.scale);
  ctx.strokeRect(topLeft.x, topLeft.y, rect.width * viewport.scale, rect.height * viewport.scale);
  ctx.restore();
}

function worldToScreen(point: Point): Point {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  };
}

function screenToWorld(point: Point): Point {
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale,
  };
}

function pointerToCanvasPoint(event: PointerEvent): Point {
  const bounds = canvas.getBoundingClientRect();

  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function buildSnappedRect(start: Point, end: Point): RectItem | null {
  const x1 = clamp(Math.round(start.x), 0, project.map.widthMeters);
  const y1 = clamp(Math.round(start.y), 0, project.map.heightMeters);
  const x2 = clamp(Math.round(end.x), 0, project.map.widthMeters);
  const y2 = clamp(Math.round(end.y), 0, project.map.heightMeters);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);

  if (width < 1 || height < 1) {
    return null;
  }

  return {
    id: makeId(),
    x,
    y,
    width,
    height,
    label: "",
  };
}

function hitTest(worldPoint: Point): RectItem | null {
  for (let index = project.rects.length - 1; index >= 0; index -= 1) {
    const rect = project.rects[index];

    if (
      worldPoint.x >= rect.x &&
      worldPoint.x <= rect.x + rect.width &&
      worldPoint.y >= rect.y &&
      worldPoint.y <= rect.y + rect.height
    ) {
      return rect;
    }
  }

  return null;
}

function setSelectedRect(id: string | null): void {
  selectedRectId = id;
  const rect = getSelectedRect();

  if (rect) {
    labelInput.value = rect.label;
    labelBaseline = rect.label;
    labelEditor.hidden = false;
  } else {
    labelEditor.hidden = true;
    labelInput.value = "";
    labelBaseline = "";
  }

  draw();
}

function getSelectedRect(): RectItem | null {
  if (!selectedRectId) {
    return null;
  }

  return project.rects.find((rect) => rect.id === selectedRectId) ?? null;
}

function commitLabelChange(): void {
  const rect = getSelectedRect();

  if (!rect) {
    return;
  }

  const nextLabel = labelInput.value.trim();

  if (nextLabel !== rect.label) {
    historyStack.push({ kind: "label", id: rect.id, before: rect.label, after: nextLabel });
    rect.label = nextLabel;
    saveProject();
  }

  labelBaseline = nextLabel;
  draw();
}

function setDeleteMode(enabled: boolean): void {
  deleteMode = enabled;
  deleteButton.classList.toggle("is-active", deleteMode);

  if (deleteMode) {
    setSelectedRect(null);
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

  canvas.setPointerCapture(event.pointerId);
  const point = pointerToCanvasPoint(event);
  activePointers.set(event.pointerId, point);

  if (activePointers.size === 2) {
    dragState = null;
    pinchState = createPinchState();
    setSelectedRect(null);
    draw();
    event.preventDefault();
    return;
  }

  if (activePointers.size > 1) {
    event.preventDefault();
    return;
  }

  const worldPoint = screenToWorld(point);
  const hitRect = hitTest(worldPoint);

  dragState = {
    pointerId: event.pointerId,
    startWorld: worldPoint,
    lastWorld: worldPoint,
    currentRect: null,
    startedOnRectId: hitRect?.id ?? null,
    moved: false,
  };

  event.preventDefault();
});

canvas.addEventListener("pointermove", (event) => {
  if (!activePointers.has(event.pointerId)) {
    return;
  }

  const point = pointerToCanvasPoint(event);
  activePointers.set(event.pointerId, point);

  if (pinchState && activePointers.size >= 2) {
    updatePinch();
    draw();
    event.preventDefault();
    return;
  }

  if (!dragState || dragState.pointerId !== event.pointerId) {
    return;
  }

  const worldPoint = screenToWorld(point);
  const startScreen = worldToScreen(dragState.startWorld);
  const movedPixels = distance(startScreen, point);
  dragState.lastWorld = worldPoint;
  dragState.moved = dragState.moved || movedPixels > TAP_MOVE_THRESHOLD;

  if (dragState.moved && !dragState.startedOnRectId && !deleteMode) {
    dragState.currentRect = buildSnappedRect(dragState.startWorld, worldPoint);
  }

  draw();
  event.preventDefault();
});

canvas.addEventListener("pointerup", finishPointer);
canvas.addEventListener("pointercancel", finishPointer);

function finishPointer(event: PointerEvent): void {
  const point = pointerToCanvasPoint(event);
  activePointers.delete(event.pointerId);

  if (pinchState) {
    if (activePointers.size < 2) {
      pinchState = null;
    } else {
      pinchState = createPinchState();
    }

    event.preventDefault();
    draw();
    return;
  }

  if (!dragState || dragState.pointerId !== event.pointerId) {
    event.preventDefault();
    return;
  }

  const worldPoint = screenToWorld(point);
  const hitRect = hitTest(worldPoint);

  if (dragState.currentRect) {
    const rect = dragState.currentRect;
    project.rects.push(rect);
    historyStack.push({ kind: "create", rect: structuredClone(rect) });
    saveProject();
    setSelectedRect(rect.id);
  } else if (!dragState.moved && hitRect) {
    if (deleteMode) {
      deleteRect(hitRect.id);
    } else {
      setSelectedRect(hitRect.id);
      window.setTimeout(() => labelInput.focus(), 0);
    }
  } else if (!dragState.moved && !hitRect) {
    setSelectedRect(null);
  }

  dragState = null;
  event.preventDefault();
  draw();
}

function createPinchState(): PinchState | null {
  const entries = Array.from(activePointers.entries()).slice(0, 2);

  if (entries.length < 2) {
    return null;
  }

  const pointers = new Map(entries);
  const [, first] = entries[0];
  const [, second] = entries[1];
  const center = midpoint(first, second);

  return {
    pointers,
    startDistance: distance(first, second),
    startCenter: center,
    startScale: viewport.scale,
    startOffsetX: viewport.offsetX,
    startOffsetY: viewport.offsetY,
    worldAtCenter: screenToWorld(center),
  };
}

function updatePinch(): void {
  if (!pinchState) {
    return;
  }

  const ids = Array.from(pinchState.pointers.keys());
  const first = activePointers.get(ids[0]);
  const second = activePointers.get(ids[1]);

  if (!first || !second) {
    return;
  }

  const center = midpoint(first, second);
  const nextDistance = distance(first, second);
  const scaleMultiplier = nextDistance / Math.max(1, pinchState.startDistance);
  viewport.scale = clamp(pinchState.startScale * scaleMultiplier, MIN_SCALE, MAX_SCALE);
  viewport.offsetX = center.x - pinchState.worldAtCenter.x * viewport.scale;
  viewport.offsetY = center.y - pinchState.worldAtCenter.y * viewport.scale;
}

function deleteRect(id: string): void {
  const index = project.rects.findIndex((rect) => rect.id === id);

  if (index === -1) {
    return;
  }

  const [rect] = project.rects.splice(index, 1);
  historyStack.push({ kind: "delete", rect: structuredClone(rect), index });

  if (selectedRectId === id) {
    setSelectedRect(null);
  }

  saveProject();
  draw();
}

function undo(): void {
  const entry = historyStack.pop();

  if (!entry) {
    return;
  }

  if (entry.kind === "create") {
    project.rects = project.rects.filter((rect) => rect.id !== entry.rect.id);
    if (selectedRectId === entry.rect.id) {
      setSelectedRect(null);
    }
  }

  if (entry.kind === "delete") {
    project.rects.splice(entry.index, 0, structuredClone(entry.rect));
  }

  if (entry.kind === "label") {
    const rect = project.rects.find((item) => item.id === entry.id);
    if (rect) {
      rect.label = entry.before;
    }
  }

  saveProject();
  draw();
}

function clampRectToMap(rect: RectItem): RectItem {
  return clampRectToMapSize(rect, project.map);
}

function clampRectToMapSize(rect: RectItem, map: ProjectFile["map"]): RectItem {
  const x = clamp(Math.round(rect.x), 0, map.widthMeters - 1);
  const y = clamp(Math.round(rect.y), 0, map.heightMeters - 1);
  const maxWidth = map.widthMeters - x;
  const maxHeight = map.heightMeters - y;

  return {
    ...rect,
    x,
    y,
    width: clamp(Math.round(rect.width), 1, Math.max(1, maxWidth)),
    height: clamp(Math.round(rect.height), 1, Math.max(1, maxHeight)),
  };
}

function exportJson(): void {
  downloadFile("kaufland-map.json", "application/json", `${JSON.stringify(project, null, 2)}\n`);
}

function exportSvg(): void {
  const svg = buildSvg();
  downloadFile("kaufland-map.svg", "image/svg+xml", svg);
}

function buildSvg(): string {
  const { widthMeters, heightMeters } = project.map;
  const gridLines: string[] = [];

  for (let x = 0; x <= widthMeters; x += 1) {
    const stroke = x % 5 === 0 ? "#d5cbb9" : "#e8dfcf";
    gridLines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${heightMeters}" stroke="${stroke}" stroke-width="0.035" />`);
  }

  for (let y = 0; y <= heightMeters; y += 1) {
    const stroke = y % 5 === 0 ? "#d5cbb9" : "#e8dfcf";
    gridLines.push(`<line x1="0" y1="${y}" x2="${widthMeters}" y2="${y}" stroke="${stroke}" stroke-width="0.035" />`);
  }

  const rects = project.rects
    .map((rect) => {
      const label = escapeXml(rect.label);
      const text = label
        ? `<text x="${rect.x + rect.width / 2}" y="${rect.y + rect.height / 2}" font-size="0.55" font-family="system-ui, sans-serif" font-weight="600" text-anchor="middle" dominant-baseline="middle" fill="#2d2a24">${label}</text>`
        : "";

      return `<g><rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="rgba(129,89,40,0.16)" stroke="#76542d" stroke-width="0.08" />${text}</g>`;
    })
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${widthMeters}m" height="${heightMeters}m" viewBox="0 0 ${widthMeters} ${heightMeters}">
  <rect x="0" y="0" width="${widthMeters}" height="${heightMeters}" fill="#fffaf0" />
  ${gridLines.join("\n  ")}
  <rect x="0" y="0" width="${widthMeters}" height="${heightMeters}" fill="none" stroke="#594d3b" stroke-width="0.12" />
  ${rects}
</svg>
`;
}

function importJson(file: File): void {
  const reader = new FileReader();

  reader.addEventListener("load", () => {
    try {
      project = normalizeProject(JSON.parse(String(reader.result)));
      historyStack = [];
      setSelectedRect(null);
      saveProject();
      fitToMap();
      draw();
    } catch {
      window.alert("JSON 工程文件无效。");
    }
  });

  reader.readAsText(file);
}

function downloadFile(filename: string, type: string, content: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function makeId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function midpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function distance(first: Point, second: Point): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

undoButton.addEventListener("click", undo);
deleteButton.addEventListener("click", () => setDeleteMode(!deleteMode));
exportJsonButton.addEventListener("click", exportJson);
exportSvgButton.addEventListener("click", exportSvg);
importJsonButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];

  if (file) {
    importJson(file);
  }

  fileInput.value = "";
});

labelInput.addEventListener("input", () => {
  const rect = getSelectedRect();

  if (!rect) {
    return;
  }

  rect.label = labelInput.value;
  saveProject();
  draw();
});

labelInput.addEventListener("blur", () => {
  const rect = getSelectedRect();

  if (rect && labelBaseline !== rect.label.trim()) {
    const nextLabel = rect.label.trim();
    historyStack.push({ kind: "label", id: rect.id, before: labelBaseline, after: nextLabel });
    rect.label = nextLabel;
    labelInput.value = nextLabel;
    labelBaseline = nextLabel;
    saveProject();
    draw();
  }
});

labelInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    commitLabelChange();
    labelInput.blur();
  }
});

clearSelectionButton.addEventListener("click", () => {
  commitLabelChange();
  setSelectedRect(null);
});

window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", () => window.setTimeout(resizeCanvas, 250));

resizeCanvas();
hydrateProjectFromIndexedDb()
  .then(requestDurableStorage)
  .catch(() => setSaveStatus("本地保存"));
