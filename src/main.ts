import "./styles.css";

type MapShape = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  points?: Point[];
};

type ProjectFile = {
  version: 1;
  map: {
    widthMeters: number;
    heightMeters: number;
  };
  rects: MapShape[];
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
  | { kind: "create"; shape: MapShape }
  | { kind: "delete"; shape: MapShape; index: number }
  | { kind: "replace"; before: MapShape; after: MapShape; index: number }
  | { kind: "label"; id: string; before: string; after: string };

type DragState = {
  pointerId: number;
  startWorld: Point;
  lastWorld: Point;
  currentRect: MapShape | null;
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
        <button id="mergeButton" class="command-button" type="button" aria-label="合并绘制" title="合并绘制">合并</button>
        <button id="exportSvgButton" class="command-button" type="button">SVG</button>
        <button id="exportJsonButton" class="command-button" type="button">JSON</button>
        <button id="importJsonButton" class="command-button" type="button">导入</button>
      </div>
    </section>

    <section id="labelEditor" class="label-editor" aria-label="Shape label editor" hidden>
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
const mergeButton = mustElement<HTMLButtonElement>("#mergeButton");
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
let mergeMode = false;
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
        .filter((rect): rect is MapShape => rect !== null)
    : [];

  return {
    version: 1,
    map,
    rects,
  };
}

function normalizeRect(value: unknown, index: number, map: ProjectFile["map"]): MapShape | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const rect = value as Partial<MapShape>;
  const points = normalizePoints(rect.points, map);

  if (points) {
    const bounds = getPointBounds(points);

    return {
      id: typeof rect.id === "string" && rect.id.length > 0 ? rect.id : `r${index + 1}`,
      ...bounds,
      label: typeof rect.label === "string" ? rect.label : "",
      points,
    };
  }

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

function normalizePoints(value: unknown, map: ProjectFile["map"]): Point[] | null {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }

  const points = value
    .map((point) => {
      if (!point || typeof point !== "object") {
        return null;
      }

      const candidate = point as Partial<Point>;
      const x = Number(candidate.x);
      const y = Number(candidate.y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }

      return {
        x: clamp(Math.round(x), 0, map.widthMeters),
        y: clamp(Math.round(y), 0, map.heightMeters),
      };
    })
    .filter((point): point is Point => point !== null);

  const simplifiedPoints = points.length >= 3 ? simplifyPolygon(points) : [];

  return simplifiedPoints.length >= 3 ? simplifiedPoints : null;
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

function drawRect(rect: MapShape, selected: boolean): void {
  ctx.save();
  ctx.fillStyle = selected ? "rgba(42, 110, 93, 0.18)" : "rgba(129, 89, 40, 0.16)";
  ctx.strokeStyle = selected ? "#1f6f60" : "#76542d";
  ctx.lineWidth = selected ? 3 : 2;

  if (rect.points?.length) {
    drawPolygonPath(rect.points);
    ctx.fill();
    ctx.stroke();
  } else {
    const topLeft = worldToScreen({ x: rect.x, y: rect.y });
    ctx.fillRect(topLeft.x, topLeft.y, rect.width * viewport.scale, rect.height * viewport.scale);
    ctx.strokeRect(topLeft.x, topLeft.y, rect.width * viewport.scale, rect.height * viewport.scale);
  }

  if (rect.label.trim()) {
    const fontSize = clamp(viewport.scale * 0.44, 11, 18);
    const labelPoint = worldToScreen(getShapeLabelPoint(rect));
    ctx.fillStyle = "#2d2a24";
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    drawWrappedText(rect.label, labelPoint.x, labelPoint.y, Math.max(10, rect.width * viewport.scale - 8), fontSize * 1.25);
  }

  ctx.restore();
}

function drawPolygonPath(points: Point[]): void {
  const [firstPoint, ...restPoints] = points;
  const firstScreenPoint = worldToScreen(firstPoint);

  ctx.beginPath();
  ctx.moveTo(firstScreenPoint.x, firstScreenPoint.y);

  for (const point of restPoints) {
    const screenPoint = worldToScreen(point);
    ctx.lineTo(screenPoint.x, screenPoint.y);
  }

  ctx.closePath();
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

function buildSnappedRect(start: Point, end: Point): MapShape | null {
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

function hitTest(worldPoint: Point): MapShape | null {
  for (let index = project.rects.length - 1; index >= 0; index -= 1) {
    const rect = project.rects[index];
    const inBounds =
      worldPoint.x >= rect.x &&
      worldPoint.x <= rect.x + rect.width &&
      worldPoint.y >= rect.y &&
      worldPoint.y <= rect.y + rect.height;

    if (inBounds && (!rect.points?.length || pointInPolygon(worldPoint, rect.points))) {
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

function getSelectedRect(): MapShape | null {
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

function setMergeMode(enabled: boolean): void {
  mergeMode = enabled;
  mergeButton.classList.toggle("is-active", mergeMode);
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
    const mergeTarget = mergeMode ? findMergeTarget(rect) : null;

    if (mergeTarget) {
      const mergedShape = buildMergedShape(mergeTarget.shape, rect);
      project.rects[mergeTarget.index] = mergedShape;
      historyStack.push({
        kind: "replace",
        before: structuredClone(mergeTarget.shape),
        after: structuredClone(mergedShape),
        index: mergeTarget.index,
      });
      saveProject();
      setSelectedRect(mergedShape.id);
    } else {
      project.rects.push(rect);
      historyStack.push({ kind: "create", shape: structuredClone(rect) });
      saveProject();
      setSelectedRect(rect.id);
    }
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

function findMergeTarget(newRect: MapShape): { shape: MapShape; index: number } | null {
  for (let index = project.rects.length - 1; index >= 0; index -= 1) {
    const shape = project.rects[index];

    if (getShapeOverlapArea(shape, newRect) > 0) {
      return { shape, index };
    }
  }

  return null;
}

function buildMergedShape(baseShape: MapShape, newRect: MapShape): MapShape {
  const points = buildShapeUnionPolygon(baseShape, newRect);
  const bounds = getPointBounds(points);
  const mergedShape: MapShape = {
    id: baseShape.id,
    ...bounds,
    label: baseShape.label,
  };

  if (!isRectanglePolygon(points, bounds)) {
    mergedShape.points = points;
  }

  return mergedShape;
}

function buildShapeUnionPolygon(first: MapShape, second: MapShape): Point[] {
  const xs = uniqueSorted([...getShapeXCoordinates(first), ...getShapeXCoordinates(second)]);
  const ys = uniqueSorted([...getShapeYCoordinates(first), ...getShapeYCoordinates(second)]);
  const filledCells = new Set<string>();

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const center = {
        x: (xs[xIndex] + xs[xIndex + 1]) / 2,
        y: (ys[yIndex] + ys[yIndex + 1]) / 2,
      };

      if (pointInShape(center, first) || pointInShape(center, second)) {
        filledCells.add(cellKey(xIndex, yIndex));
      }
    }
  }

  const edges: Array<[Point, Point]> = [];

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      if (!filledCells.has(cellKey(xIndex, yIndex))) {
        continue;
      }

      const x1 = xs[xIndex];
      const x2 = xs[xIndex + 1];
      const y1 = ys[yIndex];
      const y2 = ys[yIndex + 1];

      if (!filledCells.has(cellKey(xIndex, yIndex - 1))) edges.push([{ x: x1, y: y1 }, { x: x2, y: y1 }]);
      if (!filledCells.has(cellKey(xIndex + 1, yIndex))) edges.push([{ x: x2, y: y1 }, { x: x2, y: y2 }]);
      if (!filledCells.has(cellKey(xIndex, yIndex + 1))) edges.push([{ x: x2, y: y2 }, { x: x1, y: y2 }]);
      if (!filledCells.has(cellKey(xIndex - 1, yIndex))) edges.push([{ x: x1, y: y2 }, { x: x1, y: y1 }]);
    }
  }

  return simplifyPolygon(traceBoundary(edges));
}

function traceBoundary(edges: Array<[Point, Point]>): Point[] {
  const adjacency = new Map<string, string[]>();

  for (const [start, end] of edges) {
    const startKey = pointKey(start);
    const endKey = pointKey(end);
    adjacency.set(startKey, [...(adjacency.get(startKey) ?? []), endKey]);
    adjacency.set(endKey, [...(adjacency.get(endKey) ?? []), startKey]);
  }

  const startKey = Array.from(adjacency.keys()).sort(comparePointKeys)[0];
  const firstNeighbor = (adjacency.get(startKey) ?? []).sort(comparePointKeys)[0];

  if (!startKey || !firstNeighbor) {
    return [];
  }

  const polygonKeys = [startKey];
  let previousKey = startKey;
  let currentKey = firstNeighbor;

  for (let guard = 0; guard < edges.length + 4; guard += 1) {
    if (currentKey === startKey) {
      break;
    }

    polygonKeys.push(currentKey);
    const neighbors = adjacency.get(currentKey) ?? [];
    const nextKey = neighbors.find((neighbor) => neighbor !== previousKey);

    if (!nextKey) {
      break;
    }

    previousKey = currentKey;
    currentKey = nextKey;
  }

  return polygonKeys.map(parsePointKey);
}

function deleteRect(id: string): void {
  const index = project.rects.findIndex((rect) => rect.id === id);

  if (index === -1) {
    return;
  }

  const [rect] = project.rects.splice(index, 1);
  historyStack.push({ kind: "delete", shape: structuredClone(rect), index });

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
    project.rects = project.rects.filter((rect) => rect.id !== entry.shape.id);
    if (selectedRectId === entry.shape.id) {
      setSelectedRect(null);
    }
  }

  if (entry.kind === "delete") {
    project.rects.splice(entry.index, 0, structuredClone(entry.shape));
  }

  if (entry.kind === "replace") {
    project.rects[entry.index] = structuredClone(entry.before);
    if (selectedRectId === entry.after.id) {
      setSelectedRect(entry.before.id);
    }
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

function clampRectToMap(rect: MapShape): MapShape {
  return clampRectToMapSize(rect, project.map);
}

function clampRectToMapSize(rect: MapShape, map: ProjectFile["map"]): MapShape {
  if (rect.points?.length) {
    const points = rect.points.map((point) => ({
      x: clamp(Math.round(point.x), 0, map.widthMeters),
      y: clamp(Math.round(point.y), 0, map.heightMeters),
    }));
    const bounds = getPointBounds(points);

    return {
      ...rect,
      ...bounds,
      points,
    };
  }

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
      const labelPoint = getShapeLabelPoint(rect);
      const text = label
        ? `<text x="${labelPoint.x}" y="${labelPoint.y}" font-size="0.55" font-family="system-ui, sans-serif" font-weight="600" text-anchor="middle" dominant-baseline="middle" fill="#2d2a24">${label}</text>`
        : "";
      const shape = rect.points?.length
        ? `<polygon points="${rect.points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="rgba(129,89,40,0.16)" stroke="#76542d" stroke-width="0.08" />`
        : `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="rgba(129,89,40,0.16)" stroke="#76542d" stroke-width="0.08" />`;

      return `<g>${shape}${text}</g>`;
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

function getShapeOverlapArea(first: MapShape, second: MapShape): number {
  const xs = uniqueSorted([...getShapeXCoordinates(first), ...getShapeXCoordinates(second)]);
  const ys = uniqueSorted([...getShapeYCoordinates(first), ...getShapeYCoordinates(second)]);
  let area = 0;

  for (let xIndex = 0; xIndex < xs.length - 1; xIndex += 1) {
    for (let yIndex = 0; yIndex < ys.length - 1; yIndex += 1) {
      const width = xs[xIndex + 1] - xs[xIndex];
      const height = ys[yIndex + 1] - ys[yIndex];

      if (width <= 0 || height <= 0) {
        continue;
      }

      const center = {
        x: xs[xIndex] + width / 2,
        y: ys[yIndex] + height / 2,
      };

      if (pointInShape(center, first) && pointInShape(center, second)) {
        area += width * height;
      }
    }
  }

  return area;
}

function pointInRect(point: Point, rect: MapShape): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function pointInShape(point: Point, shape: MapShape): boolean {
  return shape.points?.length ? pointInPolygon(point, shape.points) : pointInRect(point, shape);
}

function getShapeXCoordinates(shape: MapShape): number[] {
  if (shape.points?.length) {
    return shape.points.map((point) => point.x);
  }

  return [shape.x, shape.x + shape.width];
}

function getShapeYCoordinates(shape: MapShape): number[] {
  if (shape.points?.length) {
    return shape.points.map((point) => point.y);
  }

  return [shape.y, shape.y + shape.height];
}

function pointInPolygon(point: Point, points: Point[]): boolean {
  if (isPointOnPolygonBoundary(point, points)) {
    return true;
  }

  let inside = false;

  for (let currentIndex = 0, previousIndex = points.length - 1; currentIndex < points.length; previousIndex = currentIndex++) {
    const currentPoint = points[currentIndex];
    const previousPoint = points[previousIndex];
    const intersects =
      currentPoint.y > point.y !== previousPoint.y > point.y &&
      point.x <
        ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) +
          currentPoint.x;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function isPointOnPolygonBoundary(point: Point, points: Point[]): boolean {
  return points.some((start, index) => {
    const end = points[(index + 1) % points.length];
    const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);

    if (Math.abs(cross) > 0.0001) {
      return false;
    }

    return (
      point.x >= Math.min(start.x, end.x) &&
      point.x <= Math.max(start.x, end.x) &&
      point.y >= Math.min(start.y, end.y) &&
      point.y <= Math.max(start.y, end.y)
    );
  });
}

function getShapeLabelPoint(shape: MapShape): Point {
  if (shape.points?.length) {
    return getPolygonCentroid(shape.points);
  }

  return {
    x: shape.x + shape.width / 2,
    y: shape.y + shape.height / 2,
  };
}

function getPolygonCentroid(points: Point[]): Point {
  let area = 0;
  let x = 0;
  let y = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const cross = current.x * next.y - next.x * current.y;
    area += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }

  if (area === 0) {
    const bounds = getPointBounds(points);
    return {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
  }

  return {
    x: x / (3 * area),
    y: y / (3 * area),
  };
}

function getPointBounds(points: Point[]): Pick<MapShape, "x" | "y" | "width" | "height"> {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function simplifyPolygon(points: Point[]): Point[] {
  const withoutDuplicateClosingPoint =
    points.length > 1 && pointKey(points[0]) === pointKey(points[points.length - 1]) ? points.slice(0, -1) : points;

  return withoutDuplicateClosingPoint.filter((point, index, polygon) => {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const next = polygon[(index + 1) % polygon.length];
    return !isCollinear(previous, point, next);
  });
}

function isCollinear(first: Point, second: Point, third: Point): boolean {
  return (first.x === second.x && second.x === third.x) || (first.y === second.y && second.y === third.y);
}

function isRectanglePolygon(points: Point[], bounds: Pick<MapShape, "x" | "y" | "width" | "height">): boolean {
  if (points.length !== 4) {
    return false;
  }

  const cornerKeys = new Set([
    pointKey({ x: bounds.x, y: bounds.y }),
    pointKey({ x: bounds.x + bounds.width, y: bounds.y }),
    pointKey({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }),
    pointKey({ x: bounds.x, y: bounds.y + bounds.height }),
  ]);

  return points.every((point) => cornerKeys.has(pointKey(point)));
}

function uniqueSorted(values: number[]): number[] {
  return Array.from(new Set(values)).sort((first, second) => first - second);
}

function cellKey(xIndex: number, yIndex: number): string {
  return `${xIndex},${yIndex}`;
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

function parsePointKey(key: string): Point {
  const [x, y] = key.split(",").map(Number);

  return { x, y };
}

function comparePointKeys(firstKey: string, secondKey: string): number {
  const first = parsePointKey(firstKey);
  const second = parsePointKey(secondKey);

  return first.y - second.y || first.x - second.x;
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
mergeButton.addEventListener("click", () => setMergeMode(!mergeMode));
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
