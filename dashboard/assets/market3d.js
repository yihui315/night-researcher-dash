import * as THREE from "three";

const host = document.getElementById("market3d");
if (host) {
  host.innerHTML = "";
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x08111e);
  const camera = new THREE.PerspectiveCamera(42, host.clientWidth / Math.max(1, host.clientHeight), 0.1, 100);
  camera.position.set(0, 0, 9);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0x8ba8d0, 1.25));
  const keyLight = new THREE.PointLight(0x7bb8ff, 2.4, 30); keyLight.position.set(3, 4, 6); scene.add(keyLight);
  const group = new THREE.Group(); scene.add(group);
  const positions = {
    BTCUSDT: new THREE.Vector3(0, 0.2, 0),
    ETHUSDT: new THREE.Vector3(2.1, -0.5, -0.5),
    ORDIUSDT: new THREE.Vector3(-2.0, 0.8, 0.3),
    "1000SATSUSDT": new THREE.Vector3(-0.4, -1.8, -0.6)
  };
  const nodes = {};
  const geometry = new THREE.SphereGeometry(0.34, 32, 24);
  Object.keys(positions).forEach(symbol => {
    const material = new THREE.MeshStandardMaterial({ color: symbol === "BTCUSDT" ? 0xf0b90b : 0x668ab4, roughness: 0.3, metalness: 0.55, emissive: 0x10243b, emissiveIntensity: 0.5 });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.copy(positions[symbol]); mesh.userData.symbol = symbol; group.add(mesh); nodes[symbol] = mesh;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.008, 8, 64), new THREE.MeshBasicMaterial({ color: 0x355274, transparent: true, opacity: 0.55 }));
    ring.position.copy(positions[symbol]); ring.rotation.x = Math.PI / 2.8; group.add(ring);
  });
  const symbols = Object.keys(positions);
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const points = [positions[symbols[i]], positions[symbols[j]]];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x385777, transparent: true, opacity: 0.42 }));
      group.add(line);
    }
  }
  const starGeo = new THREE.BufferGeometry(), starPositions = [];
  for (let i = 0; i < 260; i++) starPositions.push((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 8 - 2);
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x6686aa, size: 0.018, transparent: true, opacity: 0.6 })));
  let dragging = false, px = 0, py = 0;
  renderer.domElement.addEventListener("pointerdown", e => { dragging = true; px = e.clientX; py = e.clientY; renderer.domElement.setPointerCapture(e.pointerId); });
  renderer.domElement.addEventListener("pointermove", e => { if (!dragging) return; group.rotation.y += (e.clientX - px) * 0.006; group.rotation.x += (e.clientY - py) * 0.004; px = e.clientX; py = e.clientY; });
  renderer.domElement.addEventListener("pointerup", () => { dragging = false; });
  renderer.domElement.addEventListener("pointercancel", () => { dragging = false; });
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  renderer.domElement.addEventListener("click", e => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(Object.values(nodes));
    if (hit.length && window.NRTradingSelectSymbol) window.NRTradingSelectSymbol(hit[0].object.userData.symbol);
  });
  function updateAssets(tickers) {
    Object.keys(nodes).forEach(symbol => {
      const t = tickers[symbol]; if (!t) return;
      const mesh = nodes[symbol], pct = Number(t.change || 0);
      mesh.material.color.setHex(symbol === "BTCUSDT" ? 0xf0b90b : pct >= 0 ? 0xef5350 : 0x21ba72);
      const scale = 0.85 + Math.min(1.2, Math.abs(pct) / 15);
      mesh.scale.setScalar(scale);
    });
  }
  window.NRMarket3D = { updateAssets };
  function resize() { const w = host.clientWidth, h = host.clientHeight; camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); renderer.setSize(w, h); }
  window.addEventListener("resize", resize);
  function animate() { requestAnimationFrame(animate); if (!dragging) group.rotation.y += 0.0015; renderer.render(scene, camera); }
  animate();
}