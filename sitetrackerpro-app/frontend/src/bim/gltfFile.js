// ---------------------------------------------------------------------------
// What a glTF file is, before three.js is asked to read it.
//
// A .glb downloaded from Blender, Sketchfab or 3D Warehouse arrives with any of
// several browser MIME types (model/gltf-binary, application/octet-stream, or an
// empty ""), so the type is never trusted: the extension is checked case-
// insensitively and the bytes are checked for the glTF binary magic. When a file
// cannot be read, the reason is named — wrong container, a legacy glTF 1.0
// export, or a file over the upload limit — instead of "unsupported format".
// ---------------------------------------------------------------------------

// The server accepts model uploads up to 100 MB (multer limit in
// backend-v3-enhanced.js). Reading more than that into the tab would fail
// half-way through, so the same ceiling is applied before a byte is read.
export const GLB_BROWSER_LIMIT_BYTES = 100 * 1024 * 1024;

// 'glTF' in little-endian ASCII, the first four bytes of every GLB.
export const GLB_MAGIC = 0x46546c67;

// 'JSON' chunk type in a GLB, and the container markers of files that are
// commonly mistaken for one.
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;

export const megabytes = (bytes) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return 'unknown size';
  const value = Number(bytes) / (1024 * 1024);
  return `${value.toFixed(value < 10 ? 1 : 0)} MB`;
};

/** True for .glb and .gltf in any letter case, whatever the browser calls it. */
export function isGltfFileName(fileName) {
  return /\.(glb|gltf)$/i.test(String(fileName || ''));
}

export const KTX2_TEXTURE_EXTENSION = 'KHR_texture_basisu';

export function tooLargeMessage(fileName, sizeBytes, limitBytes = GLB_BROWSER_LIMIT_BYTES) {
  const name = String(fileName || 'This model');
  // Rounded up, so a file one byte over the limit does not read as "100 MB, over 100 MB".
  const sizeMb = Number(sizeBytes) / (1024 * 1024);
  const shown = `${(Math.ceil(sizeMb * 10) / 10).toFixed(1)} MB`;
  const limitShown = `${(Number(limitBytes) / (1024 * 1024)).toFixed(0)} MB`;
  return `${name} is ${shown}, over the ${limitShown} a model may be. `
    + 'Reduce it before importing: decimate the mesh, export without textures, or split it into '
    + 'storeys. Nothing was loaded.';
}

/**
 * What the bytes are: 'glb' for a binary container, 'json' for glTF JSON text
 * (.gltf), or null when it is neither.
 */
export function sniffGltfContainer(arrayBuffer) {
  if (!arrayBuffer || !arrayBuffer.byteLength) return null;
  const bytes = new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 64));
  if (bytes.byteLength >= 4) {
    const magic = new DataView(arrayBuffer, 0, 4).getUint32(0, true);
    if (magic === GLB_MAGIC) return 'glb';
  }
  // A .gltf is JSON text; skip a BOM and leading whitespace.
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) index += 1;
  return index < bytes.length && bytes[index] === 0x7b ? 'json' : null;
}

/** The JSON header of a GLB, or null when the first chunk is not readable JSON. */
export function readGlbJson(arrayBuffer) {
  if (arrayBuffer.byteLength < GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES) return null;
  const header = new DataView(arrayBuffer);
  const chunkLength = header.getUint32(GLB_HEADER_BYTES, true);
  const chunkType = header.getUint32(GLB_HEADER_BYTES + 4, true);
  if (chunkType !== GLB_JSON_CHUNK_TYPE) return null;
  const start = GLB_HEADER_BYTES + GLB_CHUNK_HEADER_BYTES;
  if (chunkLength <= 0 || start + chunkLength > arrayBuffer.byteLength) return null;
  try {
    const text = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer, start, chunkLength));
    // The JSON chunk is padded with spaces (and some exporters with NUL bytes).
    let end = text.length;
    while (end > 0) {
      const code = text.charCodeAt(end - 1);
      if (code === 0 || code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) end -= 1;
      else break;
    }
    return JSON.parse(text.slice(0, end));
  } catch (err) {
    return null;
  }
}

/** The glTF JSON block of either container, or null when it cannot be read. */
export function readGltfJson(arrayBuffer) {
  const container = sniffGltfContainer(arrayBuffer);
  if (container === 'glb') return readGlbJson(arrayBuffer);
  if (container === 'json') {
    try {
      return JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer)));
    } catch (err) {
      return null;
    }
  }
  return null;
}

/**
 * What a glTF expects from its textures. Read from the JSON header, before three.js
 * builds materials, so a texture problem can be explained rather than left as a
 * grey model.
 */
export function textureSummary(json) {
  const images = (json && Array.isArray(json.images)) ? json.images : [];
  const textures = (json && Array.isArray(json.textures)) ? json.textures : [];
  const required = (json && Array.isArray(json.extensionsRequired)) ? json.extensionsRequired : [];
  const used = (json && Array.isArray(json.extensionsUsed)) ? json.extensionsUsed : [];
  return {
    imageCount: images.length,
    textureCount: textures.length,
    // Required: three.js refuses to parse the file at all without a KTX2 decoder.
    ktx2Required: required.includes(KTX2_TEXTURE_EXTENSION),
    ktx2: required.includes(KTX2_TEXTURE_EXTENSION) || used.includes(KTX2_TEXTURE_EXTENSION),
    // Images stored beside the model rather than inside it. A .glb opened on its own
    // cannot reach them, which is one of the common ways a model arrives grey.
    externalImages: images
      .filter((image) => typeof image.uri === 'string' && !/^data:/i.test(image.uri))
      .map((image) => image.uri)
  };
}

export function ktx2TextureMessage(fileName) {
  const name = String(fileName || 'This model');
  return `${name} uses KTX2/Basis-compressed textures. The viewer has no KTX2 decoder, so those `
    + 'textures cannot be shown and the model appears in flat grey. Re-export with ordinary '
    + 'PNG or JPEG textures: in the Blender glTF 2.0 exporter switch texture compression off (Draco '
    + 'geometry compression is fine), and on Sketchfab download the glTF version with PNG textures.';
}

export function missingTexturesMessage(fileName, failed, total, externalImages = []) {
  const name = String(fileName || 'This model');
  const count = `${failed} ${failed === 1 ? 'texture' : 'textures'} of ${total}`;
  const files = externalImages.slice(0, 4).map((uri) => `“${uri}”`).join(', ');
  const more = externalImages.length > 4 ? ` and ${externalImages.length - 4} more` : '';
  const cause = files
    ? `The file points at texture images that are not inside it: ${files}${more}. Copy them next to the `
      + 'model and open the .gltf from that folder, or export with the textures embedded '
      + '(Blender: glTF Binary with Images set to Automatic).'
    : 'The texture data inside the file could not be decoded. Export the model again as glTF 2.0 '
      + 'with PNG or JPEG textures embedded.';
  return `${name} opened, but ${count} could not be loaded, so those surfaces are plain grey. ${cause}`;
}

/**
 * The texture warning for a parsed model, or null when its textures all loaded.
 * `textures` holds what three.js resolved for each texture it tried to read: a
 * texture, or null where the image failed (three.js swallows that error and
 * leaves the material without a map).
 */
export function textureWarningFor(json, textures, fileName) {
  const summary = textureSummary(json);
  if (summary.ktx2) return ktx2TextureMessage(fileName);
  const list = Array.isArray(textures) ? textures : [];
  const failed = list.filter((texture) => !texture).length;
  if (failed > 0) {
    return missingTexturesMessage(fileName, failed, list.length, summary.externalImages);
  }
  // Nothing was even attempted, yet the file declares textures: they were never used
  // by a material, which also leaves the model flat.
  if (summary.imageCount > 0 && summary.textureCount > 0 && list.length === 0) {
    return missingTexturesMessage(fileName, summary.textureCount, summary.textureCount, summary.externalImages);
  }
  return null;
}

function notAGlbMessage(arrayBuffer) {
  const head = new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 16));
  const ascii = Array.from(head).map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
  if (ascii.startsWith('PK')) {
    return 'This file does not start with the glTF marker (it starts like a ZIP archive), so it is not a GLB. '
      + 'Unzip the archive and open the .glb or .gltf file inside it.';
  }
  if (/^(ISO-10303|IFC|ISO)/i.test(ascii)) {
    return 'This file does not start with the glTF marker; it looks like an IFC file. '
      + 'Open it with the .ifc option instead of the GLB option.';
  }
  if (ascii.startsWith('<')) {
    return 'This file does not start with the glTF marker; it looks like an XML file (KML, Collada .dae or similar). '
      + 'Export it from your tool as glTF 2.0 (.glb) and open that.';
  }
  return 'This file does not start with the glTF marker (0x46546C67 for a GLB, or a "{" for glTF JSON), '
    + 'so it is not a glTF model. It may be a partial download; export it again from your tool.';
}

function versionMessage(fileName, version) {
  const name = String(fileName || 'This model');
  return `${name} is glTF ${version}, an old 1.0 export that three.js cannot read. `
    + 'Re-export as glTF 2.0: in Blender use File → Export → glTF 2.0 with the "glTF Binary (.glb)" '
    + 'format; on Sketchfab download the glTF (.glb) version. glTF 1.0 files are usually older exports.';
}

/**
 * Throw a plain-English reason when this buffer cannot be read, otherwise return
 * the container ('glb' or 'json'). Size is checked first, so an oversized file is
 * refused before the JSON header is parsed.
 */
export function assertLoadableGltf(arrayBuffer, fileName) {
  const name = String(fileName || 'This file');
  if (!isGltfFileName(name)) {
    throw new Error('Unsupported file type. Open an IFC (.ifc), a binary glTF (.glb) or a glTF JSON (.gltf) file.');
  }
  if (!arrayBuffer || !arrayBuffer.byteLength) {
    throw new Error(`${name} is empty (0 bytes). Export the model again and open the new file.`);
  }
  if (arrayBuffer.byteLength > GLB_BROWSER_LIMIT_BYTES) {
    throw new Error(tooLargeMessage(name, arrayBuffer.byteLength));
  }

  const container = sniffGltfContainer(arrayBuffer);
  if (!container) throw new Error(notAGlbMessage(arrayBuffer));

  const json = readGltfJson(arrayBuffer);
  if (!json) {
    throw new Error(`${name} has no readable glTF JSON header, so its contents cannot be loaded. `
      + 'Export it again as glTF 2.0 (.glb).');
  }

  // three.js refuses a file whose required KTX2 textures cannot be decoded; say why here
  // rather than let its internal "setKTX2Loader must be called" message be the answer.
  if (textureSummary(json).ktx2Required) throw new Error(ktx2TextureMessage(name));

  const version = json.asset && json.asset.version;
  if (!version) {
    throw new Error(`${name} is missing its glTF version block, so it is not a complete export. `
      + 'Export it again as glTF 2.0 (.glb).');
  }
  const major = Number(String(version).split('.')[0]);
  if (major < 2) throw new Error(versionMessage(name, version));
  if (major > 2) {
    throw new Error(`${name} is glTF ${version}, newer than the glTF 2.0 this viewer supports. `
      + 'Export it as glTF 2.0 (.glb) instead.');
  }
  return container;
}
