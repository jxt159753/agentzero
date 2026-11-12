import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { WORLD_MODEL_CATALOG, WORLD_ROOM_DIMENSIONS, worldLandDimensions, worldModelFits, worldRoomFits, type WorldLand, type WorldSnapshot } from '@agentzero/contracts';
import { FIRST_PERSON_RUN_SPEED, FIRST_PERSON_WALK_SPEED, JUMP_DURATION, WALK_SPEED, clampPoint, interpolatePoint, nearbyArcade, houseEntrance, nearbyShowcaseLand, quantizePoint, sampleJumpHeight, sceneBounds, walk, type ArcadeSelection, type SceneCamera, type WorldPoint, type WorldPlacementPreview } from './world-scene';
import { TownModels } from './world-3d-models';
import { TownEnvironment } from './world-environment';
import { sampleDaylight } from './world-daylight';
import { TownLamps } from './world-lamps';
import { ROOM_CEILING_HEIGHT, TownRoom } from './world-room';
import { slideWorldMovement, worldObstacles, type WorldObstacle } from './world-collision';
import { createAgentActivity, sampleAgentActivity, type AgentActivityPlan } from './world-agent-activity';
import { AgentSocialActivity } from './world-agent-social';
import { WORLD_ASSET_CREDITS } from './world-assets';
import { LandShowcase } from './land-showcase';
import worldStyles from './world.module.css';

interface MapProps {
  world: WorldSnapshot; camera: SceneCamera;
  onMove: (position: WorldPoint, moving?: boolean) => void; onLand: (id: string) => void; onAgent: (id: string) => void;
  onPlace: (path: string) => void; disabled: boolean;
  onRoom: (roomId: string | null) => void; editingRoomId?: string | null;
  renderArcade?: (selection: ArcadeSelection, onPlayingChange: (active: boolean) => void) => ReactNode;
  onViewChange?: (mode: ViewMode) => void;
  editingLandId?: string; placement?: WorldPlacementPreview; onPlacementPoint?: (point: WorldPoint) => void;
}
type ViewMode = 'first-person' | 'overview';
interface Pick { kind: 'land' | 'agent' | 'visitor' | 'place' | 'room'; id: string; title: string; detail: string }
interface Resident { node: THREE.Group; body: THREE.Group; legs: THREE.Object3D[]; arms: THREE.Object3D[]; point: WorldPoint; target: WorldPoint; signature: string; self: boolean; activity?: AgentActivityPlan; label?: HTMLDivElement; bubble?: HTMLDivElement; contact?: Pick }
interface Label { element: HTMLDivElement; node: THREE.Object3D; height: number; always: boolean; bubble: boolean }
const EYE_HEIGHT = 0.22, INTERACTION_DISTANCE = 2.5;
const CHAT_DISTANCE = 1;
const LOOK_SENSITIVITY = 0.0025, MAX_LOOK_SAMPLE = 256, MAX_LOOK_STEP = Math.PI / 9;
const directionKeys: Record<string, WorldPoint> = { ArrowUp: { x: 0, y: -1 }, w: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, s: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, a: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, d: { x: 1, y: 0 } };
const horizontalPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

/** Business positions remain on the x/y ground plane; only this renderer maps them to X/Z. */
export default function WorldMap(props: MapProps) {
  const host = useRef<HTMLDivElement>(null), labelHost = useRef<HTMLDivElement>(null), latest = useRef(props); latest.current = props;
  const gameActive = useRef(false);
  const keys = useRef(new Set<string>()), controls = useRef<{ wake: () => void; rotate: (direction: number) => void; stop: () => void; setView: (view: ViewMode) => void; enter: () => void; interact: () => void; message: () => void; showcase: () => void;
    jump: () => void; toggleRun: () => void; nudge: (key: string) => void; pressDirection: (key: string, pointerId: number) => void; releaseDirection: (pointerId: number, cancelled: boolean) => void } | null>(null);
  const handleGameActivity = useCallback((active: boolean) => { gameActive.current = active; if (active) controls.current?.stop(); else controls.current?.wake(); }, []);
  const [failed, setFailed] = useState(false), [hover, setHover] = useState<Pick | null>(null);
  const [nearby, setNearby] = useState<Pick | null>(null);
  const [nearbyLand, setNearbyLand] = useState<WorldLand | undefined>();
  const showcaseHost = useRef<HTMLDivElement>(null), arcadeHost = useRef<HTMLDivElement>(null);
  const [arcade, setArcade] = useState<ArcadeSelection | undefined>(), [nearbyDoor, setNearbyDoor] = useState<Pick | null>(null);
  const [clockLabel, setClockLabel] = useState('');
  const [running, setRunning] = useState(false);
  const [view, setView] = useState<ViewMode>('first-person'), [locked, setLocked] = useState(false), [lockNotice, setLockNotice] = useState('');
  useEffect(() => {
    const element = host.current, labelsElement = labelHost.current;
    if (!element || !labelsElement) return;
    let renderer: THREE.WebGLRenderer;
    const mobile = window.matchMedia('(max-width: 800px)').matches;
    try { renderer = new THREE.WebGLRenderer({ antialias: !mobile, alpha: false, powerPreference: 'low-power' }); }
    catch { setFailed(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.75));
    renderer.setClearColor(0xc7dfeb); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.03;
    renderer.shadowMap.enabled = !mobile; renderer.shadowMap.type = THREE.PCFShadowMap; renderer.shadowMap.autoUpdate = false;
    renderer.domElement.setAttribute('aria-hidden', 'true'); element.dataset.renderer = 'three';
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene(), overviewCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 180);
    const walkCamera = new THREE.PerspectiveCamera(mobile ? 75 : 68, 1, 0.015, 135);
    let camera: THREE.Camera = walkCamera, viewMode: ViewMode = 'first-person', yaw = -0.65, pitch = -0.025;
    const fog = new THREE.Fog(0xc7dfeb, 28, 105); scene.fog = fog;
    const hemisphere = new THREE.HemisphereLight(0xe3f1ff, 0x71844f, 1.45); scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffe5bb, 2.5);
    sun.position.set(-12, 25, 14); sun.castShadow = !mobile;
    sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -10; sun.shadow.camera.right = 10;
    sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10; sun.shadow.camera.far = 70;
    sun.shadow.normalBias = 0.008; sun.shadow.bias = -0.00015; scene.add(sun, sun.target);
    const structures = new THREE.Group(), residents = new THREE.Group(), preview = new THREE.Group();
    scene.add(structures, residents, preview);
    let displayRoom: string | null = latest.current.editingLandId ? latest.current.editingRoomId ?? null : latest.current.world.self.room_id ?? null;
    let actualRoom = latest.current.world.self.room_id ?? null, roomSignature = '', displayedArcade: ArcadeSelection | undefined, doorTarget: Pick | null = null;
    const models = new TownModels(count => {
      if (!disposed) { modelRevision++; snapshot = null; previewSignature = ''; element.dataset.assetsLoaded = String(count); wake(); }
    }), actors = new Map<string, Resident>(), lands = new Map<string, { node: THREE.Group; signature: string }>();
    const room = new TownRoom(models, mobile), interior = room.root; scene.add(interior);
    const social = new AgentSocialActivity();
    let nearbyActor: Resident | undefined;
    let displayedLand: WorldLand | undefined;
    const environment = new TownEnvironment(models); scene.add(environment.root);
    const lamps = new TownLamps(mobile); scene.add(lamps.root);
    const plotHitMaterial = new THREE.MeshBasicMaterial({ visible: false });
    const signs = new Map<string, THREE.MeshBasicMaterial>();
    const facilitySign = (name: string, color: string) => {
      if (!signs.has(name)) {
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
        const context = canvas.getContext('2d')!;
        context.fillStyle = color; context.fillRect(0, 0, 512, 128);
        context.strokeStyle = '#eedbb2'; context.lineWidth = 6; context.strokeRect(12, 12, 488, 104);
        context.font = '600 58px sans-serif'; context.fillStyle = '#fff6df'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(name, 256, 68);
        const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
        signs.set(name, new THREE.MeshBasicMaterial({ map: texture }));
      }
      const sign: THREE.Mesh = models.box(new THREE.Group(), 0xffffff, 0, 0.62, 0.66, 0.58, 0.145, 0.025);
      sign.material = signs.get(name)!; return sign;
    };
    const labels: Label[] = [], raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), projected = new THREE.Vector3();
    let disposed = false, graphicsLost = false, visible = true, frame = 0, dirty = true, width = 1, height = 1, lastTime = 0;
    let activityTimer: number | undefined;
    const activityEpoch = Date.parse(latest.current.world.server_time) / 1000, activityStartedAt = performance.now();
    const activityTime = (now: number) => activityEpoch + (now - activityStartedAt) / 1000;
    let clockSource = latest.current.world.server_time, clockEpoch = Date.parse(clockSource), clockStarted = performance.now();
    let daylight = sampleDaylight(clockEpoch), lightTick = -1, displayedMinute = '';
    let local = { x: latest.current.world.self.x, y: latest.current.world.self.y }, target: WorldPoint | null = null;
    let center = { ...local }, zoom = latest.current.camera.zoom, follow = true, azimuth = Math.PI / 6, wantedAzimuth = azimuth;
    let requestedZoom = zoom, obstacles: WorldObstacle[] = [], editingId: string | undefined, beforeEdit: ViewMode = 'first-person', previewSignature = '';
    const previewMaterials = new Set<THREE.Material>();
    let focusRevision = -1, snapshot: WorldSnapshot | null = null, terrainSignature = '', placesSignature = '', plotSignature = '', modelRevision = 0, lampLayoutDirty = true;
    let moving = false, lastEmit = 0, emitted = quantizePoint(local), hoveredKey = '', lockPending = false, lockFailed = false, lockWanted = false;
    const touchDirections = new Map<number, { key: string; origin: WorldPoint }>();
    let touchRunning = false, sprintShown = false, jumpStarted: number | null = null;
    const pendingLook = new THREE.Vector2();
    let lookReady = false;
    let drag: { id: number; x: number; y: number; point: WorldPoint | null; azimuth: number; yaw: number; pitch: number; rotate: boolean; moved: boolean } | null = null;
    const wake = () => { clearTimeout(activityTimer); activityTimer = undefined; dirty = true; if (!frame && !disposed && !graphicsLost && visible && !document.hidden) frame = requestAnimationFrame(draw); };
    const resetMotion = () => {
      keys.current.clear(); touchDirections.clear(); target = null; touchRunning = false; jumpStarted = null;
      if (sprintShown) { sprintShown = false; setRunning(false); }
    };
    const stopMovement = () => {
      resetMotion();
      if (moving) { moving = false; latest.current.onMove({ ...quantizePoint(local), room_id: actualRoom }, false); }
      wake();
    };
    const releasePointer = () => { if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); };
    const cancelDrag = () => {
      if (drag && renderer.domElement.hasPointerCapture(drag.id)) renderer.domElement.releasePointerCapture(drag.id);
      drag = null;
    };
    const resetLook = () => { pendingLook.set(0, 0); lookReady = false; };
    const stop = () => { lockWanted = false; resetLook(); cancelDrag(); stopMovement(); releasePointer(); };
    const setMode = (mode: ViewMode) => {
      if (latest.current.editingLandId && mode === 'first-person') return;
      if (viewMode === mode) return;
      stop(); viewMode = mode; camera = mode === 'first-person' ? walkCamera : overviewCamera;
      setView(mode); latest.current.onViewChange?.(mode); setHover(null); hoveredKey = '';
      if (mode === 'overview') { center = { ...local }; follow = true; }
      element.dataset.view = mode; renderer.shadowMap.needsUpdate = true; wake();
    };
    const rotate = (direction: number) => { wantedAzimuth += direction * Math.PI / 4; wake(); };
    const canMove = () => !gameActive.current && !latest.current.disabled && !latest.current.editingLandId && visible && !document.hidden;
    const headingDirection = (point: WorldPoint) => {
      const heading = viewMode === 'first-person' ? yaw : azimuth;
      return { x: point.x * Math.cos(heading) + point.y * Math.sin(heading), y: -point.x * Math.sin(heading) + point.y * Math.cos(heading) };
    };
    const nudge = (key: string) => {
      if (!canMove() || !directionKeys[key]) return;
      const direction = viewMode === 'first-person' ? headingDirection(directionKeys[key]) : directionKeys[key], step = viewMode === 'first-person' ? 0.25 : 1;
      target = clampPoint({ x: local.x + direction.x * step, y: local.y + direction.y * step }, sceneBounds(latest.current.world)); follow = true; wake();
    };
    const pressDirection = (key: string, pointerId: number) => {
      if (!canMove() || viewMode !== 'first-person') return;
      touchDirections.set(pointerId, { key, origin: { ...local } }); target = null; wake();
    };
    const releaseDirection = (pointerId: number, cancelled: boolean) => {
      const press = touchDirections.get(pointerId); if (!press) return;
      touchDirections.delete(pointerId);
      // A quick tap still takes a small step; a held direction stops on release.
      if (!cancelled && Math.hypot(local.x - press.origin.x, local.y - press.origin.y) < 0.00001) nudge(press.key);
      wake();
    };
    const toggleRun = () => { if (canMove() && viewMode === 'first-person') { touchRunning = !touchRunning; wake(); } };
    const jump = () => {
      if (!canMove() || viewMode !== 'first-person' || jumpStarted !== null) return;
      jumpStarted = performance.now(); wake();
    };
    const enter = () => {
      if (latest.current.disabled || latest.current.editingLandId || viewMode !== 'first-person' || lockPending || document.pointerLockElement === renderer.domElement) return;
      setLockNotice(''); element.focus({ preventScroll: true });
      if (!renderer.domElement.requestPointerLock) { lockFailed = true; setLockNotice('可拖动屏幕环视，使用方向键行走'); return; }
      cancelDrag(); lockPending = true; lockFailed = false; lockWanted = true;
      try { Promise.resolve(renderer.domElement.requestPointerLock()).then(() => { if (disposed) releasePointer(); }).catch(pointerLockFailed); }
      catch { pointerLockFailed(); }
    };
    const activate = (picked: Pick | null) => {
      if (!picked || latest.current.disabled || latest.current.editingLandId) return;
      stop();
      if (picked.kind === 'room') latest.current.onRoom(picked.id || null);
      else if (picked.kind === 'land') latest.current.onLand(picked.id);
      else if (picked.kind === 'agent') latest.current.onAgent(picked.id);
      else if (picked.kind === 'visitor') latest.current.onPlace('/messages?user=' + encodeURIComponent(picked.id));
      else latest.current.onPlace(picked.id);
    };
    const interact = () => {
      if (viewMode !== 'first-person' || latest.current.disabled || latest.current.editingLandId) return;
      if (doorTarget) { activate(doorTarget); return; }
      raycaster.setFromCamera(new THREE.Vector2(), camera); activate(readHit(INTERACTION_DISTANCE));
    };
    const message = () => {
      if (latest.current.disabled || latest.current.editingLandId || viewMode !== 'first-person' || !nearbyActor?.contact) return;
      if (Math.hypot(nearbyActor.point.x - local.x, nearbyActor.point.y - local.y) > CHAT_DISTANCE) return;
      const { id, kind } = nearbyActor.contact;
      const world = latest.current.world;
      const available = kind === 'agent' ? world.agents.some(agent => agent.id === id && agent.status === 'active')
        : world.visitors.some(visitor => visitor.id === id);
      if (!available) return;
      stop(); latest.current.onPlace('/messages?' + (kind === 'agent' ? 'agent=' : 'user=') + encodeURIComponent(id));
    };
    const showcase = () => {
      if (!displayedLand || latest.current.disabled || latest.current.editingLandId || showcaseHost.current?.style.visibility !== 'visible') return;
      stop(); showcaseHost.current?.focus({ preventScroll: true });
    };
    controls.current = { wake, rotate, stop, setView: setMode, enter, interact, message, showcase, jump, toggleRun, nudge, pressDirection, releaseDirection };
    element.dataset.view = viewMode; element.dataset.pointerLocked = 'false';
    const label = (node: THREE.Object3D, text: string, labelHeight: number, always = false, bubble = false) => {
      const el = document.createElement('div'); el.className = worldStyles.sceneLabel; el.textContent = text;
      if (bubble) el.classList.add(worldStyles.sceneSpeech!);
      labelsElement.appendChild(el); labels.push({ element: el, node, height: labelHeight, always, bubble });
      return el;
    };
    const removeLabels = (root: THREE.Object3D) => {
      for (let i = labels.length - 1; i >= 0; i--) {
        let node: THREE.Object3D | null = labels[i]!.node;
        while (node && node !== root) node = node.parent;
        if (node === root) { labels[i]!.element.remove(); labels.splice(i, 1); }
      }
    };
    const pickData = (node: THREE.Object3D, value: Pick) => { node.userData.pick = value; };
    const landPick = (land: WorldLand): Pick => ({ kind: 'land', id: land.id, title: land.owner_agent_id ? land.name : land.code,
      detail: land.owner_agent_id ? '产权人 @' + (land.owner?.github_login ?? '') + ' · 点击访问工作室'
        : land.purchasable ? BigInt(land.points_price).toLocaleString('zh-CN') + ' 积分 · 点击查看报价' : '公共区域 · 不可购买' });
    const updatePlots = (world: WorldSnapshot) => {
      const signature = JSON.stringify(world.lands.map(land => [land.id, land.x, land.y, land.area, land.width, land.height, land.owner_agent_id, land.purchasable, land.name, land.code, land.points_price, land.owner?.github_login]));
      if (signature === plotSignature) return;
      const old = structures.getObjectByName('plots'); if (old) { models.releaseInstances(old); structures.remove(old); }
      const plots = new THREE.Group(); plots.name = 'plots'; structures.add(plots);
      const chunks = new Map<string, WorldLand[]>();
      for (const land of world.lands) {
        const key = Math.floor(land.x / 8) + ':' + Math.floor(land.y / 8); if (!chunks.has(key)) chunks.set(key, []); chunks.get(key)!.push(land);
      }
      for (const chunk of chunks.values()) {
        const picks: Pick[] = [], tiles: Parameters<TownModels['boxes']>[0] = [], markers: Parameters<TownModels['boxes']>[0] = [];
        const hitTiles: Parameters<TownModels['boxes']>[0] = [], hitPicks: Pick[] = [];
        for (const land of chunk) {
          const size = worldLandDimensions(land), owned = Boolean(land.owner_agent_id), edge = Math.min(0.018, size.width / 8, size.height / 8), pick = landPick(land);
          hitTiles.push({ x: land.x, y: 0.008, z: land.y, width: size.width, height: 0.01, depth: size.height, color: 0xffffff }); hitPicks.push(pick);
          if (owned) {
            tiles.push({ x: land.x, y: 0.018, z: land.y, width: size.width, height: 0.03, depth: size.height, color: 0x8a9e69 });
            tiles.push({ x: land.x, y: 0.036, z: land.y, width: size.width - edge * 2, height: 0.012, depth: size.height - edge * 2, color: 0xb8c496 });
            picks.push(pick, pick);
          } else for (const side of [-1, 1]) {
            tiles.push({ x: land.x + side * (size.width - edge) / 2, y: 0.014, z: land.y, width: edge, height: 0.005, depth: size.height, color: 0x96a979 });
            tiles.push({ x: land.x, y: 0.014, z: land.y + side * (size.height - edge) / 2, width: size.width, height: 0.005, depth: edge, color: 0x96a979 });
            picks.push(pick, pick);
          }
          if (!owned && size.width > 0.8 && size.height > 0.8) {
            const span = Math.min(0.18, size.width * 0.12), z = land.y + size.height * 0.4;
            markers.push({ x: land.x, y: 0.09, z, width: 0.018, height: 0.18, depth: 0.018, color: 0x977454 });
            markers.push({ x: land.x, y: 0.18, z, width: span, height: 0.09, depth: 0.02, color: 0x55796a });
          }
        }
        const mesh = models.boxes(tiles); mesh.userData.picks = picks; plots.add(mesh);
        const hitMesh: THREE.InstancedMesh = models.boxes(hitTiles); hitMesh.material = plotHitMaterial; hitMesh.userData.picks = hitPicks; plots.add(hitMesh);
        if (markers.length) { const markerMesh = models.boxes(markers); markerMesh.raycast = () => {}; plots.add(markerMesh); }
      }
      plotSignature = signature; renderer.shadowMap.needsUpdate = true;
    };
    const buildLand = (land: WorldLand) => {
      const group = new THREE.Group(), size = worldLandDimensions(land), owned = Boolean(land.owner_agent_id);
      group.position.set(land.x, 0, land.y);
      pickData(group, landPick(land));
      if (owned) {
        const count = Math.min(land.decorations.length, 12), step = Math.min(0.4, size.width * 0.8 / Math.max(count, 1));
        land.decorations.slice(0, count).forEach((item, index) => {
          const itemWidth = Math.max(0.04, Math.min(0.28, step * 0.8, size.height * 0.15));
          let ornament: THREE.Group;
          if (item.appearance === 'plant') ornament = models.asset('plant', itemWidth, itemWidth, itemWidth * 1.8);
          else if (item.appearance === 'lamp') {
            const lampSize = WORLD_MODEL_CATALOG.lamp;
            ornament = models.asset('lamp', Math.min(itemWidth, lampSize.width), Math.min(itemWidth, lampSize.depth), lampSize.maxHeight);
          }
          else if (item.appearance === 'bookshelf') ornament = models.asset('bookshelf', itemWidth, itemWidth, itemWidth * 1.8);
          else {
            ornament = new THREE.Group();
            models.box(ornament, 0x877759, 0, itemWidth, 0, itemWidth * 0.08, itemWidth * 2, itemWidth * 0.08);
            models.box(ornament, 0xd4a05d, itemWidth * 0.3, itemWidth * 1.5, 0, itemWidth * 0.55, itemWidth * 0.6, itemWidth * 0.05);
          }
          ornament.position.set((index - (count - 1) / 2) * step, 0.045, size.height * 0.38); group.add(ornament);
        });
      }
      for (const item of (land.models ?? []).filter(item => !item.room_id)) {
        const spec = WORLD_MODEL_CATALOG[item.model_id], model = models.asset(item.model_id, spec.width, spec.depth, spec.maxHeight);
        model.name = 'placement:' + item.id; model.position.set(item.x, 0.045, item.y);
        model.rotation.y = item.rotation * Math.PI / 180; model.scale.multiplyScalar(item.scale);
        model.visible = !(latest.current.editingLandId === land.id && latest.current.placement?.selectedId === item.id); group.add(model);
      }
      if (owned && Math.min(size.width, size.height) > 0.4) {
        const height = Math.max(0.2, ...(land.models ?? []).filter(item => !item.room_id && WORLD_MODEL_CATALOG[item.model_id].solid)
          .map(item => WORLD_MODEL_CATALOG[item.model_id].maxHeight * item.scale + 0.2));
        label(group, land.name, height).dataset.landId = land.id;
      }
      return group;
    };
    const updateStructures = (world: WorldSnapshot) => {
      updatePlots(world);
      const nextPlaces = JSON.stringify(world.places) + modelRevision;
      if (placesSignature !== nextPlaces) {
        const old = structures.getObjectByName('places'); if (old) { removeLabels(old); structures.remove(old); }
        const places = new THREE.Group(); places.name = 'places'; structures.add(places);
        for (const place of world.places) {
          const node = new THREE.Group(); node.position.set(place.x, 0.04, place.y); places.add(node); node.add(models.asset('studio', 1.28, 1.28, 1.6));
          const colors: Record<string, number> = { tasks: 0xd6ae69, market: 0x91a97b, rewards: 0x86a8bb };
          const signColors: Record<string, string> = { tasks: '#856a44', market: '#406651', rewards: '#466b7d' };
          node.add(facilitySign(place.name, signColors[place.id] ?? '#406651'));
          models.box(node, colors[place.id] ?? 0xd6ae69, 0, 0.43, 0.7, 0.78, 0.035, 0.23);
          for (const side of [-1, 1]) {
            models.box(node, 0x795b3d, side * 0.34, 0.22, 0.77, 0.028, 0.43, 0.028);
            models.box(node, 0xa9845f, side * 0.42, 0.11, 0.57, 0.23, 0.12, 0.17);
            const planter = models.asset('plant', 0.2, 0.15, 0.25); planter.position.set(side * 0.42, 0.15, 0.57); node.add(planter);
          }
          pickData(node, { kind: 'place', id: place.path, title: place.name, detail: '公共设施 · 点击进入' }); label(node, place.name, 1.55, true);
        }
        placesSignature = nextPlaces; renderer.shadowMap.needsUpdate = true;
      }
      const ids = new Set<string>();
      for (const land of world.lands) {
        ids.add(land.id); const signature = JSON.stringify(land) + modelRevision, previous = lands.get(land.id);
        if (previous?.signature === signature) continue;
        if (previous) { removeLabels(previous.node); structures.remove(previous.node); }
        const node = buildLand(land); structures.add(node); lands.set(land.id, { node, signature }); renderer.shadowMap.needsUpdate = true; lampLayoutDirty = true;
      }
      for (const [id, entry] of lands) if (!ids.has(id)) { removeLabels(entry.node); structures.remove(entry.node); lands.delete(id); renderer.shadowMap.needsUpdate = true; lampLayoutDirty = true; }
      obstacles = worldObstacles(world, actualRoom);
      if (lampLayoutDirty) { lamps.rebuild([environment.root, structures]); lampLayoutDirty = false; }
    };
    const updateRoom = (world: WorldSnapshot) => {
      const land = world.lands.find(item => item.models?.some(model => model.id === displayRoom));
      const contents = land?.models?.filter(item => item.room_id === displayRoom) ?? [];
      const signature = JSON.stringify([displayRoom, contents, modelRevision]);
      if (signature === roomSignature) return;
      removeLabels(interior); roomSignature = signature;
      room.setContents(displayRoom && land ? contents : []); room.setDaylight(daylight);
      if (displayRoom && land) {
        pickData(room.door, { kind: 'room', id: '', title: '回到小镇', detail: 'E · 离开房屋' }); label(room.door, '出口', 0.27, true);
      }
      renderer.shadowMap.needsUpdate = true;
    };
    const updateInteractions = (current: MapProps) => {
      let nextDoor: Pick | null = null;
      if (!current.disabled && !editingId && viewMode === 'first-person') {
        if (actualRoom && Math.hypot(local.x, local.y - WORLD_ROOM_DIMENSIONS.height / 2) < 0.45) nextDoor = { kind: 'room', id: '', title: '回到小镇', detail: 'E · 离开房屋' };
        if (!actualRoom) for (const land of current.world.lands) for (const house of land.models ?? []) {
          if (house.room_id || WORLD_MODEL_CATALOG[house.model_id].category !== 'building') continue;
          const door = houseEntrance(land, house);
          if (Math.hypot(local.x - door.x, local.y - door.y) < 0.55) nextDoor = { kind: 'room', id: house.id, title: WORLD_MODEL_CATALOG[house.model_id].label, detail: 'E · 进入房屋' };
        }
      }
      if (JSON.stringify(nextDoor) !== JSON.stringify(doorTarget)) setNearbyDoor(nextDoor); doorTarget = nextDoor;
      const next = gameActive.current ? displayedArcade : current.disabled || editingId ? undefined : nearbyArcade(current.world.lands, { ...local, room_id: actualRoom });
      if (next?.placement !== displayedArcade?.placement || next?.land !== displayedArcade?.land) { displayedArcade = next; setArcade(next); }
      const bubble = arcadeHost.current;
      if (bubble && next) {
        const item = next.placement, spec = WORLD_MODEL_CATALOG[item.model_id];
        projected.set(item.x + (item.room_id ? 0 : next.land.x), spec.maxHeight * item.scale + 0.12, item.y + (item.room_id ? 0 : next.land.y)).project(camera);
        const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
        const shown = projected.z >= -1 && projected.z <= 1 && x >= 0 && x <= width && y >= 0 && y <= height;
        bubble.style.visibility = shown ? 'visible' : 'hidden';
        bubble.style.transform = `translate(${Math.max(8, Math.min(width - bubble.offsetWidth - 8, x - bubble.offsetWidth / 2))}px,${Math.max(8, y - bubble.offsetHeight - 14)}px)`;
      } else if (bubble) bubble.style.visibility = 'hidden';
    };
    const updatePreview = (current: MapProps) => {
      const land = current.world.lands.find(item => item.id === current.editingLandId), draft = current.placement;
      const signature = JSON.stringify([current.editingLandId, draft, land?.x, land?.y, land?.area, land?.width, land?.height, modelRevision]);
      if (signature === previewSignature) return;
      previewMaterials.forEach(material => material.dispose()); previewMaterials.clear(); preview.clear();
      for (const [id, entry] of lands) for (const child of entry.node.children) {
        if (child.name.startsWith('placement:')) child.visible = !(id === current.editingLandId && child.name === 'placement:' + draft?.selectedId);
      }
      for (const child of room.contents.children) child.visible = child.name !== 'placement:' + draft?.selectedId;
      room.setSelected(draft?.selectedId);
      if (land && draft) {
        const spec = WORLD_MODEL_CATALOG[draft.model_id], valid = draft.room_id ? worldRoomFits(draft) : worldModelFits(land, draft);
        const model = models.asset(draft.model_id, spec.width, spec.depth, spec.maxHeight);
        model.scale.multiplyScalar(draft.scale);
        preview.add(model);
        models.box(preview, valid ? 0x88bb87 : 0xd66e5e, 0, 0.012, 0, spec.width * draft.scale, 0.015, spec.depth * draft.scale);
        preview.position.set((draft.room_id ? 0 : land.x) + draft.x, 0.05, (draft.room_id ? 0 : land.y) + draft.y); preview.rotation.y = draft.rotation * Math.PI / 180;
        preview.traverse(node => {
          if (!(node instanceof THREE.Mesh)) return;
          const clone = (material: THREE.Material) => {
            const copy = material.clone(); copy.transparent = true; copy.opacity = 0.52; copy.depthWrite = false;
            if (!valid && copy instanceof THREE.MeshStandardMaterial) copy.color.lerp(new THREE.Color(0xe15b48), 0.55);
            previewMaterials.add(copy); return copy;
          };
          node.material = Array.isArray(node.material) ? node.material.map(clone) : clone(node.material);
          node.castShadow = false; node.receiveShadow = false;
        });
        element.dataset.placementValid = String(valid);
      } else delete element.dataset.placementValid;
      previewSignature = signature; dirty = true;
      if (displayRoom) renderer.shadowMap.needsUpdate = true;
    };
    const updateActors = (world: WorldSnapshot) => {
      const entries = [...world.agents.map(agent => ({ id: agent.id, name: agent.name, room_id: agent.room_id, x: agent.x, y: agent.y, online: agent.online, status: agent.status, kind: 'agent' })),
        ...world.visitors.map(visitor => ({ id: visitor.id, name: visitor.name, room_id: visitor.room_id, x: visitor.x, y: visitor.y, online: true, status: 'active', kind: 'visitor' }))];
      if (!entries.some(actor => actor.kind === world.self.kind && actor.id === world.self.id)) entries.push({ ...world.self, room_id: world.self.room_id, name: '你', status: 'active' });
      const ids = new Set<string>();
      for (const actor of entries) {
        if ((actor.room_id ?? null) !== displayRoom) continue;
        const id = actor.kind + ':' + actor.id, self = actor.kind === world.self.kind && actor.id === world.self.id;
        const simulate = !displayRoom && actor.kind === 'agent' && !actor.online && actor.status === 'active' && !self;
        ids.add(id); const signature = actor.name + ':' + actor.online + ':' + actor.kind + ':' + actor.status;
        let resident = actors.get(id);
        const previousPoint = actor.online && resident?.activity ? undefined : resident?.point;
        if (resident && resident.signature !== signature) { removeLabels(resident.node); residents.remove(resident.node); actors.delete(id); resident = undefined; }
        if (!resident) {
          const node = new THREE.Group(), body = new THREE.Group(), color = !actor.online ? 0x98a397 : actor.kind === 'agent' ? 0xd2a24e : 0x6a9bb6;
          node.add(body); node.scale.setScalar(0.5); residents.add(node);
          const shadow = models.cylinder(node, 0x91a984, 0, 0.043, 0, self ? 0.22 : 0.16, 0.008); shadow.castShadow = false;
          if (self) models.cylinder(node, 0xc4e5db, 0, 0.049, 0, 0.185, 0.008).castShadow = false;
          let legs: THREE.Object3D[], arms: THREE.Object3D[] = [];
          if (actor.kind === 'agent') {
            models.cylinder(body, color, 0, 0.21, 0, 0.105, 0.27);
            models.box(body, color, 0, 0.43, 0, 0.26, 0.23, 0.23); models.box(body, 0x43665d, 0, 0.44, 0.12, 0.19, 0.075, 0.012);
            for (const x of [-0.05, 0.05]) models.box(body, 0xf8efd2, x, 0.44, 0.132, 0.025, 0.026, 0.015);
            models.cylinder(body, 0xa1855d, 0, 0.61, 0, 0.018, 0.12);
            legs = [-0.065, 0.065].map(x => models.box(body, 0x52685c, x, 0.08, 0, 0.07, 0.13, 0.12));
          } else ({ legs, arms } = models.visitor(body, actor.id));
          node.traverse(part => { if (part instanceof THREE.Mesh) part.castShadow = false; });
          let actorLabel: HTMLDivElement | undefined, bubble: HTMLDivElement | undefined;
          if (actor.kind === 'agent') {
            pickData(node, { kind: 'agent', id: actor.id, title: actor.name, detail: actor.online ? 'Agent 在线 · 点击查看主页'
              : simulate ? 'Agent 离线 · 小镇模拟活动 · 点击查看主页' : 'Agent 已暂停 · 离线 · 点击查看主页' });
            actorLabel = label(node, actor.name + (self ? ' · 你' : simulate ? ' · 离线漫步' : actor.online ? ' · 在线' : ' · 已暂停'), 0.425, self);
            actorLabel.dataset.agentId = actor.id;
            if (simulate) { bubble = label(node, '', 0.59, false, true); bubble.dataset.agentBubble = actor.id; }
          } else {
            actorLabel = label(node, actor.name + (self ? ' · 你' : ''), 0.425, self);
            actorLabel.dataset.visitorId = actor.id;
            if (!self) pickData(node, { kind: 'visitor', id: actor.id, title: actor.name, detail: '访客在线 · 点击发消息' });
          }
          const activity = simulate ? createAgentActivity(actor.id) : undefined;
          const paused = actor.kind === 'agent' && !actor.online && actor.status === 'paused';
          const point = activity ? sampleAgentActivity(activity, activityTime(performance.now())).point
            : paused ? { x: actor.x, y: actor.y } : previousPoint ?? { x: actor.x, y: actor.y };
          const contact: Pick | undefined = actor.status === 'active' && !self
            ? { kind: actor.kind === 'agent' ? 'agent' : 'visitor', id: actor.id, title: actor.name,
              detail: actor.kind === 'visitor' ? '访客在线' : actor.online ? 'Agent 在线' : 'Agent 离线 · 可以留言' } : undefined;
          resident = { node, body, legs, arms, point, target: { x: actor.x, y: actor.y }, signature, self, activity, label: actorLabel, bubble, contact }; actors.set(id, resident);
        }
        resident.target = { x: actor.x, y: actor.y };
      }
      for (const [id, actor] of actors) if (!ids.has(id)) { removeLabels(actor.node); residents.remove(actor.node); actors.delete(id); }
    };
    const resize = () => {
      width = Math.max(1, element.clientWidth); height = Math.max(1, element.clientHeight); renderer.setSize(width, height, false);
      const vertical = height / 54; overviewCamera.left = -vertical * width / height / 2; overviewCamera.right = -overviewCamera.left; overviewCamera.top = vertical / 2; overviewCamera.bottom = -overviewCamera.top;
      overviewCamera.updateProjectionMatrix(); walkCamera.aspect = width / height; walkCamera.updateProjectionMatrix(); wake();
    };
    const setRay = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1); raycaster.setFromCamera(pointer, camera);
    };
    const groundPoint = (clientX: number, clientY: number): WorldPoint | null => {
      setRay(clientX, clientY); const point = raycaster.ray.intersectPlane(horizontalPlane, new THREE.Vector3()); return point ? { x: point.x, y: point.z } : null;
    };
    const readHit = (maxDistance = Infinity): Pick | null => {
      scene.updateMatrixWorld(true); raycaster.far = maxDistance;
      for (const intersection of raycaster.intersectObjects([residents, structures, interior], true)) {
        let ancestor: THREE.Object3D | null = intersection.object, hidden = false;
        while (ancestor) { if (!ancestor.visible) { hidden = true; break; } ancestor = ancestor.parent; }
        if (hidden) continue;
        if (intersection.instanceId !== undefined && intersection.object.userData.picks) return intersection.object.userData.picks[intersection.instanceId] as Pick;
        let node: THREE.Object3D | null = intersection.object;
        while (node) { if (node.userData.pick) return node.userData.pick as Pick; node = node.parent; }
      }
      return null;
    };
    const hit = (clientX: number, clientY: number): Pick | null => { setRay(clientX, clientY); return readHit(viewMode === 'first-person' ? INTERACTION_DISTANCE : Infinity); };
    const updateHover = (picked: Pick | null) => {
      const key = picked ? picked.kind + picked.id + picked.title + picked.detail : '';
      if (hoveredKey !== key) { hoveredKey = key; setHover(picked); }
      renderer.domElement.style.cursor = document.pointerLockElement === renderer.domElement ? 'none'
        : viewMode === 'first-person' || latest.current.editingLandId ? 'crosshair' : picked ? 'pointer' : 'grab';
    };
    const pointerDown = (event: PointerEvent) => {
      if (latest.current.disabled || event.button > 2) return;
      if (document.pointerLockElement === renderer.domElement) { if (event.button === 0) interact(); return; }
      if (lockPending) return;
      // A first click enters walking mode; it must not also activate the building under the pointer.
      if (viewMode === 'first-person' && !latest.current.editingLandId && event.pointerType === 'mouse' && event.button === 0
        && !lockFailed && typeof renderer.domElement.requestPointerLock === 'function') { enter(); return; }
      renderer.domElement.setPointerCapture(event.pointerId); element.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, point: groundPoint(event.clientX, event.clientY), azimuth: wantedAzimuth, yaw, pitch, rotate: event.button === 2 || event.shiftKey, moved: false };
      setHover(null); hoveredKey = '';
    };
    const pointerMove = (event: PointerEvent) => {
      if (latest.current.disabled || document.pointerLockElement === renderer.domElement) return;
      if (drag && drag.id === event.pointerId) {
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (Math.hypot(dx, dy) < 6 && !drag.moved) return;
        drag.moved = true; follow = false;
        if (viewMode === 'first-person') { yaw = drag.yaw - dx * 0.005; pitch = Math.max(-1.2, Math.min(1.2, drag.pitch - dy * 0.005)); }
        else if (drag.rotate) wantedAzimuth = drag.azimuth - dx * 0.008;
        else { const point = groundPoint(event.clientX, event.clientY); if (point && drag.point) center = clampPoint({ x: center.x + drag.point.x - point.x, y: center.y + drag.point.y - point.y }, sceneBounds(latest.current.world)); }
        wake(); return;
      }
      // First-person prompts always describe the crosshair target; clicking still uses the actual pointer ray.
      if (event.pointerType === 'touch' || latest.current.editingLandId || viewMode === 'first-person') return;
      updateHover(hit(event.clientX, event.clientY));
    };
    const pointerUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const activeDrag = drag; drag = null;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
      if (event.type === 'pointercancel' || activeDrag.moved || activeDrag.rotate || latest.current.disabled) return;
      if (latest.current.editingLandId) {
        const point = groundPoint(event.clientX, event.clientY); if (point) latest.current.onPlacementPoint?.(point); return;
      }
      const picked = hit(event.clientX, event.clientY);
      if (picked) activate(picked);
      else if (viewMode === 'overview') { const point = groundPoint(event.clientX, event.clientY); if (point) { target = clampPoint(point, sceneBounds(latest.current.world)); follow = true; wake(); } }
    };
    const contextMenu = (event: MouseEvent) => event.preventDefault(), pointerLeave = () => { if (!drag) { hoveredKey = ''; setHover(null); } };
    const visibility = () => { if (document.hidden) { stop(); cancelAnimationFrame(frame); frame = 0; } else { lastTime = 0; wake(); } };
    const contextLost = (event: Event) => { event.preventDefault(); graphicsLost = true; stop(); cancelAnimationFrame(frame); frame = 0; setFailed(true); };
    const lockedLook = (event: MouseEvent) => {
      if (!lockWanted || document.pointerLockElement !== renderer.domElement || latest.current.disabled || viewMode !== 'first-person') return;
      // Lock transitions may recenter the cursor; that first sample is not camera movement.
      if (!lookReady) { lookReady = true; return; }
      if (Math.hypot(event.movementX, event.movementY) > MAX_LOOK_SAMPLE) return;
      pendingLook.x += event.movementX; pendingLook.y += event.movementY; wake();
    };
    const pointerLockChanged = () => {
      const active = document.pointerLockElement === renderer.domElement;
      lockPending = false; resetLook(); cancelDrag();
      if (active && (!lockWanted || disposed || document.hidden || !visible || latest.current.disabled || latest.current.editingLandId || viewMode !== 'first-person')) { releasePointer(); return; }
      setLocked(active); element.dataset.pointerLocked = String(active); renderer.domElement.style.cursor = active ? 'none' : viewMode === 'first-person' ? 'crosshair' : 'grab';
      if (!active) { lockWanted = false; stopMovement(); } else element.focus({ preventScroll: true }); wake();
    };
    function pointerLockFailed() { lockPending = false; lockWanted = false; lockFailed = true; if (!disposed) setLockNotice('未能锁定鼠标，可拖动环视；点击「进入漫游」重试'); }
    const draw = (now: number) => {
      frame = 0;
      if (disposed || graphicsLost || !visible || document.hidden) return;
      const current = latest.current, dt = lastTime ? Math.min((now - lastTime) / 1000, 0.05) : 1 / 60; lastTime = now;
      let animate = false, activityAnimating = false, nearbyActivities = 0;
      const nextRoom = current.editingLandId ? current.editingRoomId ?? null : current.world.self.room_id ?? null;
      if (actualRoom !== (current.world.self.room_id ?? null)) {
        actualRoom = current.world.self.room_id ?? null; moving = false; resetMotion(); releasePointer();
        local = { x: current.world.self.x, y: current.world.self.y }; center = { ...local }; emitted = quantizePoint(local); yaw = actualRoom ? 0 : yaw;
      }
      if (displayRoom !== nextRoom) { displayRoom = nextRoom; snapshot = null; previewSignature = ''; roomSignature = ''; renderer.shadowMap.needsUpdate = true; center = displayRoom ? { x: 0, y: 0 } : { ...local }; dirty = true; }
      environment.root.visible = !displayRoom; structures.visible = !displayRoom; interior.visible = Boolean(displayRoom);
      hemisphere.visible = !displayRoom; sun.visible = !displayRoom; lamps.root.visible = !displayRoom;
      element.dataset.roomId = displayRoom ?? '';
      if (snapshot !== current.world) {
        snapshot = current.world;
        if (clockSource !== snapshot.server_time) {
          clockSource = snapshot.server_time; clockEpoch = Date.parse(clockSource); clockStarted = now;
        }
        const ground = JSON.stringify([snapshot.bounds, snapshot.public_areas, snapshot.lands.map(land => [land.x, land.y, land.area, land.width, land.height, land.owner_agent_id, land.owner?.id])]) + modelRevision;
        if (ground !== terrainSignature) { environment.update(snapshot); terrainSignature = ground; renderer.shadowMap.needsUpdate = true; lampLayoutDirty = true; }
        updateStructures(snapshot); updateRoom(snapshot); updateActors(snapshot);
        element.dataset.modelCount = String(snapshot.lands.reduce((count, land) => count + (land.models?.length ?? 0), 0)); dirty = true;
      }
      if (editingId !== current.editingLandId) {
        if (current.editingLandId && !editingId) beforeEdit = viewMode;
        editingId = current.editingLandId; stop();
        if (editingId) {
          setMode('overview'); const land = current.world.lands.find(item => item.id === editingId);
          if (land) { center = displayRoom ? { x: 0, y: 0 } : { x: land.x, y: land.y }; follow = false; }
        } else setMode(beforeEdit);
      }
      let focusChanged = false;
      if (focusRevision !== current.camera.revision) {
        focusChanged = focusRevision >= 0;
        if (focusChanged) setMode(current.camera.follow ? 'first-person' : 'overview');
        focusRevision = current.camera.revision; follow = current.camera.follow;
        if (!follow) center = { x: current.camera.x, y: current.camera.y }; dirty = true;
      }
      if (requestedZoom !== current.camera.zoom) { requestedZoom = current.camera.zoom; if (!focusChanged) setMode('overview'); }
      if (pendingLook.lengthSq()) {
        if (lockWanted && document.pointerLockElement === renderer.domElement && !current.disabled && !editingId && viewMode === 'first-person') {
          // Bound one rendered turn and discard overflow rather than replaying a stalled input burst.
          pendingLook.clampLength(0, MAX_LOOK_STEP / LOOK_SENSITIVITY);
          yaw -= pendingLook.x * LOOK_SENSITIVITY; pitch = Math.max(-1.2, Math.min(1.2, pitch - pendingLook.y * LOOK_SENSITIVITY)); dirty = true;
        }
        pendingLook.set(0, 0);
      }
      const activeKeys = new Set([...keys.current, ...[...touchDirections.values()].map(press => press.key)]);
      const keyDirection = [...activeKeys].reduce((value, key) => ({ x: value.x + (directionKeys[key]?.x ?? 0), y: value.y + (directionKeys[key]?.y ?? 0) }), { x: 0, y: 0 });
      const direction = headingDirection(keyDirection);
      if (direction.x || direction.y) { target = null; follow = true; }
      if (current.disabled || editingId) { resetMotion(); releasePointer(); if (hoveredKey) { hoveredKey = ''; setHover(null); } }
      const sprint = viewMode === 'first-person' && !current.disabled && !editingId && (keys.current.has('Shift') || touchRunning);
      const speed = viewMode === 'first-person' ? sprint ? FIRST_PERSON_RUN_SPEED : FIRST_PERSON_WALK_SPEED : WALK_SPEED;
      if (sprint !== sprintShown) { sprintShown = sprint; setRunning(sprint); }
      element.dataset.running = String(sprint); element.dataset.moveSpeed = String(speed);
      const previous = local;
      if (!gameActive.current && !current.disabled && !editingId) {
        const next = walk(local, direction, target, dt * speed / WALK_SPEED, sceneBounds(current.world));
        local = clampPoint(slideWorldMovement(local, next, obstacles), sceneBounds(current.world));
        if (target && Math.hypot(local.x - previous.x, local.y - previous.y) < 0.00001 && Math.hypot(next.x - local.x, next.y - local.y) > 0.00001) target = null;
      }
      const arrived = target !== null && Math.hypot(target.x - local.x, target.y - local.y) < 0.001;
      if (arrived) target = null;
      const nowMoving = !arrived && Math.hypot(local.x - previous.x, local.y - previous.y) > 0.00001, rounded = quantizePoint(local);
      element.dataset.selfX = String(rounded.x); element.dataset.selfY = String(rounded.y);
      if ((nowMoving && now - lastEmit >= 100 && (rounded.x !== emitted.x || rounded.y !== emitted.y)) || (moving && !nowMoving) || (arrived && (rounded.x !== emitted.x || rounded.y !== emitted.y))) { lastEmit = now; emitted = rounded; current.onMove({ ...rounded, room_id: actualRoom }, nowMoving); }
      moving = nowMoving; animate ||= nowMoving;
      let jumpHeight = 0;
      if (jumpStarted !== null) {
        const elapsed = (now - jumpStarted) / 1000;
        if (elapsed >= JUMP_DURATION) jumpStarted = null;
        else jumpHeight = sampleJumpHeight(elapsed);
        dirty = true; animate ||= jumpStarted !== null;
      }
      element.dataset.jumpHeight = String(jumpHeight); element.dataset.airborne = String(jumpStarted !== null);
      if (viewMode === 'overview') {
        const focus = displayRoom ? { x: 0, y: 0 } : local;
        if (follow && Math.hypot(center.x - focus.x, center.y - focus.y) > 0.001) { center = interpolatePoint(center, focus, dt, 7); animate = true; }
        if (Math.abs(zoom - current.camera.zoom) > 0.001) { zoom += (current.camera.zoom - zoom) * (1 - Math.exp(-10 * dt)); animate = true; }
        if (Math.abs(wantedAzimuth - azimuth) > 0.001) { azimuth += (wantedAzimuth - azimuth) * (1 - Math.exp(-10 * dt)); animate = true; }
        let roomZoom = 1;
        if (displayRoom) {
          const { width: roomWidth, height: roomDepth } = WORLD_ROOM_DIMENSIONS;
          const sine = Math.abs(Math.sin(azimuth)), cosine = Math.abs(Math.cos(azimuth)), distance = Math.hypot(25, 29);
          const projectedWidth = roomWidth * cosine + roomDepth * sine;
          const projectedHeight = (roomWidth * sine + roomDepth * cosine) * 29 / distance + ROOM_CEILING_HEIGHT * 25 / distance;
          roomZoom = Math.min(width / 54 * 0.84 / projectedWidth, height / 54 * 0.8 / projectedHeight);
        }
        const focusHeight = displayRoom ? ROOM_CEILING_HEIGHT / 2 : 0;
        overviewCamera.zoom = zoom * roomZoom; overviewCamera.updateProjectionMatrix();
        overviewCamera.position.set(center.x + Math.sin(azimuth) * 25, 29 + focusHeight, center.y + Math.cos(azimuth) * 25);
        overviewCamera.lookAt(center.x, focusHeight, center.y);
      } else {
        walkCamera.position.set(local.x, EYE_HEIGHT + jumpHeight, local.y); walkCamera.rotation.set(pitch, yaw, 0, 'YXZ');
      }
      camera.updateMatrixWorld(true); element.dataset.cameraYaw = String(yaw); element.dataset.cameraPitch = String(pitch);
      const clockTime = clockEpoch + now - clockStarted, tick = Math.floor(clockTime / 5000);
      const lightChanged = tick !== lightTick;
      if (lightChanged) {
        lightTick = tick; daylight = sampleDaylight(clockTime); environment.setDaylight(daylight); room.setDaylight(daylight);
        renderer.setClearColor(daylight.fog); fog.color.setHex(daylight.fog);
        hemisphere.color.setHex(daylight.hemisphereSky); hemisphere.groundColor.setHex(daylight.hemisphereGround); hemisphere.intensity = daylight.hemisphereIntensity;
        sun.color.setHex(daylight.sunColor); sun.intensity = daylight.sunIntensity; renderer.toneMappingExposure = daylight.exposure;
        element.dataset.dayPhase = daylight.phase; element.dataset.worldHour = daylight.hours.toFixed(3); element.dataset.lampStrength = daylight.lamps.toFixed(3);
        const minute = Math.floor(daylight.hours * 60), phases = { dawn: '晨光', day: '白昼', dusk: '暮光', night: '夜晚' };
        const text = `北京时间 ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} · ${phases[daylight.phase]}`;
        if (text !== displayedMinute) { displayedMinute = text; setClockLabel(text); }
        dirty = true;
      }
      models.setLampStrength(displayRoom ? Math.max(0.55, daylight.lamps) : daylight.lamps);
      const shadowX = Math.round((viewMode === 'first-person' ? local.x : center.x) / 2) * 2;
      const shadowY = Math.round((viewMode === 'first-person' ? local.y : center.y) / 2) * 2;
      if (!displayRoom && (lightChanged || sun.target.position.x !== shadowX || sun.target.position.z !== shadowY)) {
        sun.target.position.set(shadowX, 0, shadowY); sun.position.set(shadowX + daylight.sunPosition.x, daylight.sunPosition.y, shadowY + daylight.sunPosition.z); renderer.shadowMap.needsUpdate = true;
      }
      const lampFocus = viewMode === 'first-person' ? local : center;
      element.dataset.pointLights = String(displayRoom ? room.lightCount : lamps.update(lampFocus.x, lampFocus.y, daylight.lamps, now)); element.dataset.lampCount = String(lamps.count);
      element.dataset.roomLights = String(displayRoom ? room.lightCount : 0); element.dataset.roomShadowLights = String(displayRoom ? room.shadowLightCount : 0);
      element.dataset.roomWindowStrength = String(displayRoom ? room.windowStrength : 0);
      element.dataset.roomWidth = String(WORLD_ROOM_DIMENSIONS.width); element.dataset.roomDepth = String(WORLD_ROOM_DIMENSIONS.height);
      element.dataset.roomHeight = String(ROOM_CEILING_HEIGHT);
      const activitySeconds = activityTime(now), focus = viewMode === 'first-person' ? local : center;
      const participants: { id: string; plan: AgentActivityPlan }[] = [];
      if (!current.disabled && !editingId) for (const [id, actor] of actors) {
        if (!actor.activity) continue;
        const point = sampleAgentActivity(actor.activity, activitySeconds).point;
        if (Math.hypot(point.x - focus.x, point.y - focus.y) < (viewMode === 'first-person' ? 12 : 20)) participants.push({ id, plan: actor.activity });
        if (participants.length === 24) break;
      }
      const activitySamples = social.sample(participants, activitySeconds);
      let nearest: Resident | undefined, nearestDistance = CHAT_DISTANCE;
      for (const [id, actor] of actors) {
        const old = actor.point, distance = Math.hypot(actor.target.x - old.x, actor.target.y - old.y);
        let walking = false, speech = '';
        if (actor.activity) {
          // These are display-only routes. The server's position, online state and movement outbox stay untouched.
          const sample = activitySamples.get(id);
          if (sample) {
            actor.point = sample.point; actor.body.rotation.y = sample.yaw;
            nearbyActivities++; walking = sample.moving; activityAnimating ||= sample.moving || sample.activity === 'look';
            if (actor.label) actor.label.dataset.activity = sample.conversation ? 'chat' : sample.activity;
            if (sample.conversation?.text) speech = sample.conversation.text + ' · 模拟闲聊';
          }
        } else {
          actor.point = actor.self ? local : distance > 0.001 ? interpolatePoint(old, actor.target, dt, 8) : actor.target;
          const dx = actor.point.x - old.x, dz = actor.point.y - old.y;
          walking = Math.hypot(dx, dz) > 0.0001;
          if (walking) { actor.body.rotation.y = Math.atan2(dx, dz); animate = true; }
          if (actor.label) actor.label.dataset.activity = 'none';
        }
        if (actor.bubble && actor.bubble.textContent !== speech) actor.bubble.textContent = speech;
        actor.body.position.y = walking ? Math.abs(Math.sin(now * 0.013)) * 0.025 : 0; actor.node.position.set(actor.point.x, 0, actor.point.y);
        actor.legs.forEach((leg, index) => { leg.rotation.x = walking ? Math.sin(now * 0.013 + index * Math.PI) * 0.38 : 0; });
        actor.arms.forEach((arm, index) => { arm.rotation.x = walking ? -Math.sin(now * 0.013 + index * Math.PI) * 0.3 : 0; });
        actor.node.visible = !actor.self || viewMode === 'overview';
        if (actor.label) { actor.label.dataset.x = String(Math.round(actor.point.x * 1000) / 1000); actor.label.dataset.y = String(Math.round(actor.point.y * 1000) / 1000); }
        if (!current.disabled && !editingId && viewMode === 'first-person' && actor.contact) {
          const proximity = Math.hypot(actor.point.x - local.x, actor.point.y - local.y);
          if (proximity <= nearestDistance) { nearestDistance = proximity; nearest = actor; }
        }
      }
      if (nearbyActor?.contact !== nearest?.contact) setNearby(nearest?.contact ?? null);
      nearbyActor = nearest;
      const nextLand = current.disabled || editingId || displayRoom ? undefined : nearbyShowcaseLand(current.world.lands, local);
      if (nextLand !== displayedLand) { displayedLand = nextLand; setNearbyLand(nextLand); }
      const bubble = showcaseHost.current;
      if (bubble) {
        let shown = false;
        if (nextLand && bubble.dataset.landShowcase === nextLand.id) {
          // Keep walk-mode displays at reading height; roofs and tall trees must not push them above the view.
          const anchorHeight = viewMode === 'first-person' ? EYE_HEIGHT
            : Math.max(0.26, ...(nextLand.models ?? []).filter(item => !item.room_id).map(item => WORLD_MODEL_CATALOG[item.model_id].maxHeight * item.scale + 0.14));
          projected.set(nextLand.x, anchorHeight, nextLand.y).project(camera);
          const anchorX = (projected.x + 1) * width / 2, anchorY = (1 - projected.y) * height / 2;
          const minimumAnchorY = viewMode === 'overview' ? 80 : Math.min(240, height * 0.45);
          shown = projected.z >= -1 && projected.z <= 1 && anchorX >= 8 && anchorX <= width - 8 && anchorY >= minimumAnchorY && anchorY <= height - 8;
          if (shown) {
            bubble.style.maxHeight = Math.min(560, anchorY - 24) + 'px';
            const left = Math.max(8, Math.min(width - bubble.offsetWidth - 8, anchorX - bubble.offsetWidth / 2));
            bubble.style.transform = 'translate(' + left + 'px,' + (anchorY - bubble.offsetHeight - 12) + 'px)';
            bubble.style.setProperty('--tail-x', (anchorX - left) + 'px');
            bubble.dataset.anchorX = String(anchorX); bubble.dataset.anchorY = String(anchorY);
            bubble.dataset.worldX = String(nextLand.x); bubble.dataset.worldY = String(nextLand.y); bubble.dataset.worldHeight = String(anchorHeight);
          }
        }
        bubble.style.visibility = shown ? 'visible' : 'hidden';
      }
      element.dataset.simulatedAgents = String(nearbyActivities);
      updateInteractions(current);
      room.setOverview(viewMode === 'overview');
      updatePreview(current);
      if (dirty || animate) {
        if (viewMode === 'first-person' && !current.disabled && !editingId) { raycaster.setFromCamera(new THREE.Vector2(), camera); updateHover(readHit(INTERACTION_DISTANCE)); }
        for (const entry of labels) {
          entry.node.getWorldPosition(projected);
          const inRange = Math.hypot(projected.x - local.x, projected.z - local.y) < 6;
          projected.y += entry.height; projected.project(camera);
          const eligible = entry.bubble ? Boolean(entry.element.textContent) && !editingId && (viewMode === 'overview' || inRange)
            : viewMode === 'overview' ? entry.always || zoom > 0.6 : entry.node.parent === residents && inRange;
          let ancestor: THREE.Object3D | null = entry.node, hidden = false;
          while (ancestor) { if (!ancestor.visible) { hidden = true; break; } ancestor = ancestor.parent; }
          const shown = eligible && !hidden && !current.disabled && projected.z >= -1 && projected.z <= 1 && Math.abs(projected.x) < 0.95 && Math.abs(projected.y) < 0.9;
          entry.element.hidden = !shown;
          if (shown) entry.element.style.transform = 'translate(-50%, -100%) translate(' + ((projected.x + 1) * width / 2) + 'px,' + ((1 - projected.y) * height / 2 - (entry.bubble && viewMode === 'overview' ? 24 : 0)) + 'px)';
        }
        renderer.render(scene, camera); dirty = false; element.dataset.drawCalls = String(renderer.info.render.calls);
      }
      if (animate && !current.disabled && !frame) frame = requestAnimationFrame(draw);
      else if (nearbyActivities && !frame && !current.disabled && !editingId) activityTimer = window.setTimeout(wake, activityAnimating ? 1000 / 30 : 250);
      else if (!frame && !current.disabled) activityTimer = window.setTimeout(wake, 5000);
    };
    const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(element);
    const intersectionObserver = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; if (visible) { lastTime = 0; wake(); } else { stop(); cancelAnimationFrame(frame); frame = 0; } });
    intersectionObserver.observe(element);
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove); canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerUp); canvas.addEventListener('pointerleave', pointerLeave); canvas.addEventListener('contextmenu', contextMenu);
    canvas.addEventListener('webglcontextlost', contextLost); document.addEventListener('visibilitychange', visibility); window.addEventListener('blur', stop);
    document.addEventListener('mousemove', lockedLook); document.addEventListener('pointerlockchange', pointerLockChanged); document.addEventListener('pointerlockerror', pointerLockFailed);
    resize(); wake();
    void models.load();
    return () => {
      stop(); disposed = true; controls.current = null; cancelAnimationFrame(frame); clearTimeout(activityTimer); resizeObserver.disconnect(); intersectionObserver.disconnect();
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('blur', stop);
      document.removeEventListener('mousemove', lockedLook); document.removeEventListener('pointerlockchange', pointerLockChanged); document.removeEventListener('pointerlockerror', pointerLockFailed);
      canvas.removeEventListener('pointerdown', pointerDown); canvas.removeEventListener('pointermove', pointerMove); canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerUp); canvas.removeEventListener('pointerleave', pointerLeave); canvas.removeEventListener('contextmenu', contextMenu); canvas.removeEventListener('webglcontextlost', contextLost);
      previewMaterials.forEach(material => material.dispose()); previewMaterials.clear();
      plotHitMaterial.dispose(); signs.forEach(material => { material.map?.dispose(); material.dispose(); });
      environment.dispose(); scene.remove(environment.root);
      lamps.dispose(); scene.remove(lamps.root); room.dispose(); scene.remove(interior);
      labels.forEach(entry => entry.element.remove()); models.releaseInstances(scene); models.dispose(); renderer.dispose(); canvas.remove();
    };
  }, []);
  useEffect(() => {
    const bubble = showcaseHost.current; if (!bubble) return;
    const observer = new ResizeObserver(() => controls.current?.wake()); observer.observe(bubble);
    return () => observer.disconnect();
  }, [failed, props.disabled, props.editingLandId]);
  useEffect(() => { controls.current?.wake(); }, [props.world, props.camera, props.disabled, props.editingLandId, props.placement, props.editingRoomId, nearbyLand, arcade]);
  return <div ref={host} className={worldStyles.map} data-testid="world-map" data-view={view} tabIndex={0} role="group"
    aria-label={view === 'first-person' ? '共享小镇第一人称，点击场景锁定鼠标，WASD 行走，Shift 跑动，空格跳跃，E 与附近目标互动，F 联系附近 Agent，V 浏览地块展示，Esc 释放鼠标；触屏拖动环视' : '共享小镇俯视地图，点击空地行走，拖动查看，右键拖动旋转'}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) controls.current?.stop(); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || gameActive.current) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === 'Escape') { event.preventDefault(); controls.current?.stop(); }
      else if (key === 'e' && !event.repeat && !props.disabled && !props.editingLandId) { event.preventDefault(); controls.current?.interact(); }
      else if (key === 'f' && !event.repeat && !props.disabled && !props.editingLandId) { event.preventDefault(); controls.current?.message(); }
      else if (key === 'v' && !event.repeat && !props.disabled && !props.editingLandId) { event.preventDefault(); controls.current?.showcase(); }
      else if (key === ' ' && view === 'first-person' && !props.disabled && !props.editingLandId) { event.preventDefault(); if (!event.repeat) controls.current?.jump(); }
      else if ((directionKeys[key] || key === 'Shift' && view === 'first-person') && !props.disabled && !props.editingLandId) {
        event.preventDefault(); keys.current.add(key); if (event.shiftKey) keys.current.add('Shift'); controls.current?.wake();
      }
    }}
    onKeyUp={event => { keys.current.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key); controls.current?.wake(); }}>
    <div ref={labelHost} className={worldStyles.sceneLabels} aria-hidden="true" />
    {!failed && !props.disabled && <>
      <span className={worldStyles.sceneTime} data-testid="world-clock">{clockLabel}</span>
      {!props.editingLandId && <div className={worldStyles.sceneViewModes} aria-label="小镇视角">
        <button aria-pressed={view === 'first-person'} onClick={() => controls.current?.setView('first-person')}>第一人称</button>
        <button aria-pressed={view === 'overview'} onClick={() => controls.current?.setView('overview')}>俯视地图</button>
      </div>}
      {view === 'overview' && <div className={worldStyles.sceneCompass} aria-label="3D 视角控制"><button aria-label="向左旋转视角" onClick={() => controls.current?.rotate(-1)}>↶</button><span>3D</span><button aria-label="向右旋转视角" onClick={() => controls.current?.rotate(1)}>↷</button></div>}
      {view === 'first-person' && !props.editingLandId && <>
        <button className={worldStyles.sceneRoam} onClick={() => locked ? controls.current?.stop() : controls.current?.enter()}>{locked ? '退出漫游' : '进入漫游'}</button>
        <span className={worldStyles.sceneCrosshair} aria-hidden="true" />
        <div className={worldStyles.sceneWalkHelp}>{lockNotice || (locked ? 'WASD 行走 · Shift 跑动 · 空格跳跃 · E 互动 · Esc 显示鼠标' : '点击场景漫游 · Shift 跑动 · 空格跳跃 · 触屏拖动环视')}</div>
      </>}
      {!props.editingLandId && <>
        {nearbyDoor && <div className={worldStyles.sceneDoor} role="region" aria-label="房屋入口"><strong>{nearbyDoor.title}</strong><button onClick={() => { controls.current?.stop(); props.onRoom(nearbyDoor.id || null); }}>{nearbyDoor.detail}</button></div>}
        <div ref={arcadeHost} className={worldStyles.sceneArcade} role="region" aria-label="附近游戏机" hidden={!arcade} onPointerDownCapture={() => controls.current?.stop()} onFocusCapture={() => controls.current?.stop()}>{arcade && (props.renderArcade?.(arcade, handleGameActivity) ?? <strong>游戏机</strong>)}</div>
        <section className={worldStyles.sceneMovement} aria-label="移动控制">
          <div className={worldStyles.movePad} aria-label="移动访客">{([['向上移动', 'w', '↑'], ['向左移动', 'a', '←'], ['向下移动', 's', '↓'], ['向右移动', 'd', '→']] as const).map(([label, key, icon]) => <button key={key} type="button" aria-label={label}
            onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); host.current?.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); controls.current?.pressDirection(key, event.pointerId); }}
            onPointerUp={event => { controls.current?.releaseDirection(event.pointerId, false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
            onPointerCancel={event => controls.current?.releaseDirection(event.pointerId, true)} onLostPointerCapture={event => controls.current?.releaseDirection(event.pointerId, true)}
            onClick={event => { if (view === 'overview' || event.detail === 0) controls.current?.nudge(key); }}>{icon}</button>)}</div>
          {view === 'first-person' && <div className={worldStyles.motionActions}>
            <button type="button" aria-label="切换跑动" aria-pressed={running} onClick={() => { host.current?.focus({ preventScroll: true }); controls.current?.toggleRun(); }}>跑动</button>
            <button type="button" aria-label="跳跃" onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); host.current?.focus({ preventScroll: true }); controls.current?.jump(); }}
              onClick={event => { if (event.detail === 0) controls.current?.jump(); }}>跳跃</button>
          </div>}
        </section>
        {view === 'first-person' && nearby && <div className={worldStyles.sceneNearby} role="region" aria-label={nearby.kind === 'visitor' ? '附近的访客' : '附近的 Agent'}><strong>{nearby.title}</strong><span>{nearby.detail}</span><button onClick={() => controls.current?.message()}>F · 发消息</button></div>}
        <div ref={showcaseHost} className={worldStyles.sceneLandShowcase} role="region" aria-label="附近地块展示" data-land-showcase={nearbyLand?.id} data-view={view} tabIndex={-1} hidden={!nearbyLand}
          onPointerDownCapture={() => controls.current?.stop()} onFocusCapture={() => controls.current?.stop()}>
          {nearbyLand && (view === 'overview' ? <button className={worldStyles.showcaseOpen} onClick={() => { controls.current?.stop(); props.onLand(nearbyLand.id); }} aria-label={`查看展示：${nearbyLand.name}`}><strong>{nearbyLand.name}</strong><span>查看展示 →</span></button> : <>
          <div className={worldStyles.showcaseHeading}><span>附近的展示</span><strong>{nearbyLand.name}</strong><small>产权人 @{nearbyLand.owner?.github_login}</small></div>
          {locked && <p className={worldStyles.showcaseHint}>按 V 显示鼠标，浏览展示</p>}
          <LandShowcase key={`${nearbyLand.id}-${nearbyLand.version}`} items={nearbyLand.showcase ?? []} compact />
          <button className={worldStyles.showcaseVisit} onClick={() => { controls.current?.stop(); props.onLand(nearbyLand.id); }}>查看工作室 →</button>
          </>)}
        </div>
      </>}
      <a className={worldStyles.sceneCredits} href={WORLD_ASSET_CREDITS} target="_blank" rel="noreferrer">模型 © Polyfork · CC BY 4.0 ↗</a>
      {hover && !props.editingLandId && <div className={worldStyles.sceneTooltip}><strong>{hover.title}</strong><span>{hover.detail}</span>
        {view === 'first-person' && <button onClick={() => controls.current?.interact()} aria-label={'与目标互动：' + hover.title}>E · 互动</button>}
      </div>}
    </>}
    {failed && <div className={worldStyles.mapOverlay}><strong>当前设备无法绘制 3D 地图</strong><p>仍可打开“小镇目录”，查看土地、工作室和全部业务入口。</p></div>}
  </div>;
}
