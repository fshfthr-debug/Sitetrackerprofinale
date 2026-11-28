// ============================================================================
// Stage environment for the 3D viewers
//
// Both the 3D BIM screen and the IFC viewer used to sit on a flat pale fill with
// a faint grid, which read as an empty CAD viewport rather than a site. This adds
// the two things that make a model look placed on real ground:
//
//   ground  a large plane with a generated land texture — grass and soil patches,
//           field edges, speckle — repeated across the plane.
//   sky     an inside-out gradient dome, pale at the horizon and deeper overhead,
//           so the camera never sees a flat colour behind the model.
//
// Distance haze ties the two together: the far ground fades into the horizon
// colour, which hides the end of the plane without any visible edge.
//
// Everything is procedural, so no texture files ship with the app and nothing
// has to be fetched at runtime.
// ============================================================================

import * as THREE from 'three';

const SKY_TOP = '#5f9fca';
const SKY_MID = '#b4d5e8';
const SKY_HORIZON = '#e9eef0';
const HAZE = '#dfe7e8';

const LAND_TILES = 120;      // texture tiles across the ground
const SKY_RADIUS = 4200;
const MIN_LAND = 800;        // never smaller than this, so a fixture still has a horizon
const MAX_LAND = 60000;

// Small deterministic generator: the same site looks the same on every reload.
function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function landTexture() {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const random = seeded(20261);

  // Base pasture.
  ctx.fillStyle = '#6f8851';
  ctx.fillRect(0, 0, size, size);

  // Broad tonal patches: mown grass, dry grass, turned soil.
  const patches = [
    ['#7c9a5b', 0.5], ['#5f7a47', 0.45], ['#87a463', 0.4],
    ['#9c9a63', 0.3], ['#8a7550', 0.22], ['#4f6b3d', 0.3]
  ];
  for (let i = 0; i < 140; i += 1) {
    const [colour, alpha] = patches[Math.floor(random() * patches.length)];
    const radius = 24 + random() * 150;
    ctx.globalAlpha = alpha * (0.35 + random() * 0.5);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.ellipse(random() * size, random() * size, radius, radius * (0.5 + random() * 0.9), random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Field boundaries: thin, pale, irregular, like hedgerows and tracks seen from above.
  ctx.strokeStyle = 'rgba(206, 212, 178, 0.14)';
  for (let i = 0; i < 14; i += 1) {
    ctx.lineWidth = 1 + random() * 1.6;
    ctx.beginPath();
    let x = random() * size;
    let y = random() * size;
    ctx.moveTo(x, y);
    const steps = 3 + Math.floor(random() * 4);
    for (let step = 0; step < steps; step += 1) {
      x += (random() - 0.5) * 300;
      y += (random() - 0.5) * 300;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // A worked dirt track running roughly across the tile.
  ctx.strokeStyle = 'rgba(150, 126, 92, 0.36)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(-40, size * (0.3 + random() * 0.4));
  ctx.bezierCurveTo(size * 0.3, size * 0.45, size * 0.6, size * 0.7, size + 40, size * (0.4 + random() * 0.3));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(196, 176, 140, 0.22)';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Fine speckle so the ground holds detail when the camera is close.
  for (let i = 0; i < 26000; i += 1) {
    const shade = random();
    ctx.fillStyle = shade > 0.55
      ? `rgba(255, 255, 235, ${0.02 + random() * 0.05})`
      : `rgba(30, 45, 25, ${0.02 + random() * 0.06})`;
    const dot = 0.6 + random() * 1.6;
    ctx.fillRect(random() * size, random() * size, dot, dot);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(LAND_TILES, LAND_TILES);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function skyDome() {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 32, 20);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(SKY_TOP) },
      midColor: { value: new THREE.Color(SKY_MID) },
      horizonColor: { value: new THREE.Color(SKY_HORIZON) }
    },
    vertexShader: `
      varying vec3 vPosition;
      void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 horizonColor;
      varying vec3 vPosition;
      void main() {
        float h = clamp(normalize(vPosition).y, -1.0, 1.0);
        vec3 colour = mix(horizonColor, midColor, smoothstep(-0.03, 0.18, h));
        colour = mix(colour, topColor, smoothstep(0.15, 0.9, h));
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false
  });
  const dome = new THREE.Mesh(geometry, material);
  dome.name = 'stage-sky';
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}

export function addStageEnvironment(scene, { renderer, tileSize = 60 } = {}) {
  const sky = skyDome();
  scene.add(sky);

  const texture = landTexture();
  if (renderer?.capabilities?.getMaxAnisotropy) {
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    roughness: 0.97,
    metalness: 0
  });
  const land = new THREE.Mesh(geometry, material);
  land.name = 'stage-land';
  land.rotation.x = -Math.PI / 2;
  land.position.y = -0.02;
  land.scale.set(MIN_LAND, MIN_LAND, 1);
  land.receiveShadow = true;
  scene.add(land);

  // Haze ties the ground into the sky at distance, so the plane has no visible edge.
  const previousFog = scene.fog;
  scene.fog = new THREE.Fog(new THREE.Color(HAZE), 360, 800);

  // The ground is sized from the model: one texture tile per `metres` of ground,
  // 120 tiles across, so a 2 m fixture and a 200 m building both see field detail
  // at a believable scale and both get a horizon the sky shows above. Haze fades
  // the far ground into the sky, so the plane's edge is never a hard line.
  const setTileSize = (metres) => {
    const next = Number(metres);
    if (!Number.isFinite(next) || next <= 0) return;
    const extent = THREE.MathUtils.clamp(next * LAND_TILES, MIN_LAND, MAX_LAND);
    land.scale.set(extent, extent, 1);
    texture.repeat.set(LAND_TILES, LAND_TILES);
    // Keep the fade inside the camera's far plane so the ground is never cut off
    // in clear air.
    const far = Math.min(extent * 0.75, 4400);
    const near = far * 0.45;
    if (scene.fog && scene.fog.isFog) {
      scene.fog.near = near;
      scene.fog.far = far;
    }
  };
  setTileSize(tileSize);

  return {
    sky,
    land,
    setTileSize,
    dispose() {
      scene.remove(sky);
      scene.remove(land);
      geometry.dispose();
      material.dispose();
      texture.dispose();
      sky.geometry.dispose();
      sky.material.dispose();
      scene.fog = previousFog || null;
    }
  };
}

export default addStageEnvironment;
