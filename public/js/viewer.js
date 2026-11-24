// 3D viewer for part files (STEP, STL, 3MF, OBJ), plus rendering a picture of a part for its photo.
// three.js and the OpenCascade STEP reader load only when first needed (the STEP reader is ~7 MB).
import { h, fill, api, attempt, openModal, closeModal, refresh, uploadImage } from './core.js';

const MODEL_EXTS = ['step', 'stp', 'stl', '3mf', 'obj'];
const extOf = (name) => String(name || '').split('.').pop().toLowerCase();
export const isViewable = (name) => MODEL_EXTS.includes(extOf(name));

let threePromise;
function loadThree() {
  threePromise ||= Promise.all([
    import('three'),
    import('three/addons/controls/OrbitControls.js'),
    import('three/addons/loaders/STLLoader.js'),
    import('three/addons/loaders/3MFLoader.js'),
    import('three/addons/loaders/OBJLoader.js'),
  ]).then(([THREE, { OrbitControls }, { STLLoader }, { ThreeMFLoader }, { OBJLoader }]) => ({ THREE, OrbitControls, STLLoader, ThreeMFLoader, OBJLoader }));
  return threePromise;
}

let occtPromise;
function loadOcct() {
  occtPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/occt/occt-import-js.js';
    s.onload = () => window.occtimportjs({ locateFile: (f) => `/vendor/occt/${f}` }).then(resolve, reject);
    s.onerror = () => reject(new Error('Could not load the STEP reader.'));
    document.head.append(s);
  });
  occtPromise.catch(() => (occtPromise = null));
  return occtPromise;
}

// Turn file bytes into a three.js object.
async function buildModel(buffer, name) {
  const lib = await loadThree();
  const { THREE } = lib;
  const ext = extOf(name);
  const material = (color) => new THREE.MeshStandardMaterial({ color: color ?? 0x9aa4b2, metalness: 0.25, roughness: 0.55, side: THREE.DoubleSide });

  if (ext === 'step' || ext === 'stp') {
    const occt = await loadOcct();
    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result.success || !result.meshes.length) throw new Error("Couldn't read that STEP file.");
    const group = new THREE.Group();
    for (const m of result.meshes) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
      if (m.attributes.normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
      if (m.index) geo.setIndex(Array.from(m.index.array));
      if (!m.attributes.normal) geo.computeVertexNormals();
      const color = m.color ? new THREE.Color(m.color[0], m.color[1], m.color[2]) : null;
      group.add(new THREE.Mesh(geo, material(color)));
    }
    return group;
  }
  if (ext === 'stl') {
    const geo = new lib.STLLoader().parse(buffer);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, material());
  }
  if (ext === '3mf') return new lib.ThreeMFLoader().parse(buffer);
  if (ext === 'obj') {
    const obj = new lib.OBJLoader().parse(new TextDecoder().decode(buffer));
    obj.traverse((c) => c.isMesh && (c.material = material()));
    return obj;
  }
  throw new Error('That file type cannot be shown in 3D.');
}

// Set up a scene around the model, camera framed on it.
async function stage(model, width, height, { preserveDrawingBuffer = false } = {}) {
  const { THREE } = await loadThree();
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(width, height);
  renderer.setClearColor(0xffffff);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a94a6, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(1, 1.4, 1.2);
  scene.add(key);
  const fillLight = new THREE.DirectionalLight(0xffffff, 0.5);
  fillLight.position.set(-1, -0.4, -1);
  scene.add(fillLight);

  // Center the model and frame it from a three-quarter view.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  scene.add(model);
  const radius = Math.max(size.length() / 2, 1e-3);
  const camera = new THREE.PerspectiveCamera(35, width / height, radius / 100, radius * 100);
  const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * 1.1;
  camera.position.set(dist * 0.6, dist * 0.45, dist * 0.65);
  camera.lookAt(0, 0, 0);
  key.target.position.set(0, 0, 0);
  return { THREE, renderer, scene, camera, radius };
}

async function fetchFile(file) {
  const res = await fetch(`/api/files/${file.id}`);
  if (!res.ok) throw new Error('Could not download the file.');
  return res.arrayBuffer();
}

// Render a picture of a model file (used as the part photo when it has none).
export async function renderThumbnail(file) {
  const model = await buildModel(await fetchFile(file), file.name);
  const { renderer, scene, camera } = await stage(model, 800, 600, { preserveDrawingBuffer: true });
  renderer.render(scene, camera);
  const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
  renderer.dispose();
  return uploadImage(new File([blob], 'render.png', { type: 'image/png' }));
}

// Full-screen-ish viewer with orbit / zoom / pan. `part` (optional) enables "Use this view as photo".
export async function openViewer(file, part = null) {
  const holder = h('div', { class: 'viewer-canvas' }, h('div', { class: 'viewer-msg' }, `Loading ${file.name}…`));
  const others = (part?.files || []).filter((f) => isViewable(f.name));
  const photoBtn = part ? h('button', { class: 'btn', disabled: true }, 'Use this view as the part photo') : null;
  let renderer;
  let frame;

  openModal(`${file.name}${part ? ` · ${part.name}` : ''}`, h('div', {},
    others.length > 1 ? h('div', { class: 'row viewer-files' }, others.map((f) =>
      h('button', { class: `btn small${f.id === file.id ? ' primary' : ''}`, onclick: () => openViewer(f, part) }, f.name))) : null,
    holder,
    h('p', { class: 'note' }, 'Drag to rotate · scroll to zoom · right-drag to pan')), [
    h('a', { class: 'btn', href: `/api/files/${file.id}`, download: file.name, style: { marginRight: 'auto' } }, 'Download'),
    photoBtn,
    h('button', { class: 'btn primary', onclick: closeModal }, 'Close'),
  ], 'wide');

  try {
    const model = await buildModel(await fetchFile(file), file.name);
    const width = holder.clientWidth || 900;
    const height = Math.round(Math.min(window.innerHeight * 0.6, width * 0.62));
    const s = await stage(model, width, height, { preserveDrawingBuffer: true });
    renderer = s.renderer;
    const { OrbitControls } = await loadThree();
    const controls = new OrbitControls(s.camera, renderer.domElement);
    controls.enableDamping = true;
    fill(holder, renderer.domElement);
    const loop = () => {
      if (!renderer.domElement.isConnected) { // dialog closed: free the GPU memory
        renderer.dispose();
        return;
      }
      controls.update();
      renderer.render(s.scene, s.camera);
      frame = requestAnimationFrame(loop);
    };
    loop();
    if (photoBtn) {
      photoBtn.disabled = false;
      photoBtn.onclick = async () => {
        photoBtn.disabled = true;
        renderer.render(s.scene, s.camera);
        const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
        const url = await attempt(() => uploadImage(new File([blob], 'view.png', { type: 'image/png' })));
        if (url && (await attempt(() => api('PATCH', `/api/custom-parts/${part.id}`, { image: url }), 'Photo updated'))) refresh();
        photoBtn.disabled = false;
      };
    }
  } catch (err) {
    cancelAnimationFrame(frame);
    fill(holder, h('div', { class: 'viewer-msg error' }, err.message));
  }
}
