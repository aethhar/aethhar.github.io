/* STA-A local OBJ/STL intake. No network upload and no solver promotion. */
const SCHEMA = "STA_OBJ_CAPTURE/1.0";
const KNOWN = new Set(["v","vt","vn","vp","f","l","p","o","g","s","mg","usemtl","mtllib","cstype","deg","curv","curv2","surf","parm","trim","hole","scrv","sp","end","bevel","c_interp","d_interp","lod","shadow_obj","trace_obj","ctech","stech","maplib","usemap"]);
const FREEFORM = new Set(["cstype","deg","curv","curv2","surf","parm","trim","hole","scrv","sp","end"]);
const MTL_KEYS = new Set(["ka","kd","ks","ke","tf","ns","ni","d","tr","illum","sharpness","map_ka","map_kd","map_ks","map_ns","map_d","map_bump","bump","disp","refl"]);
const UNIT_RES = [[/\b(?:mm|millimet(?:er|re)s?)\b/i, "mm"], [/\b(?:meters?|metres?)\b/i, "m"], [/\b(?:inch|inches)\b/i, "in"], [/\b(?:feet|foot)\b/i, "ft"]];

export async function sha256Of(buffer) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,"0")).join("");
}

function logicalLines(text) {
  const raw = String(text).replace(/^\uFEFF/, "");
  if (raw.includes("\u0000")) throw Error("BINARY_NOT_WAVEFRONT");
  const parts = raw.split(/\r\n|\n|\r/);
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  const out = [];
  let buf = "";
  for (const line of parts) {
    if (line.endsWith("\\")) { buf += line.slice(0,-1) + " "; continue; }
    out.push(buf + line); buf = "";
  }
  if (buf) out.push(buf);
  return out;
}

function sniffUnits(comments) {
  const blob = comments.join("\n");
  const declared = [...blob.matchAll(/\bunits?\s*[:=]\s*([A-Za-z0-9./_-]+)/gi)].map(m => m[1]);
  const hits = UNIT_RES.filter(([re]) => re.test(blob)).map(([,name]) => name);
  const unique = [];
  for (const item of [...declared, ...hits]) {
    const map = {millimeter:"mm",millimetre:"mm",millimeters:"mm",millimetres:"mm",meter:"m",metre:"m",meters:"m",metres:"m",inch:"in",inches:"in",foot:"ft",feet:"ft"};
    const key = map[item.toLowerCase()] || item.toLowerCase();
    if (!unique.includes(key)) unique.push(key);
  }
  if (unique.length === 1) return {original_units: unique[0], unit_evidence: unique, units_status: "COMMENT_DECLARED"};
  if (unique.length > 1) return {original_units: "CONFLICTING", unit_evidence: unique, units_status: "CONFLICTING_COMMENTS"};
  return {original_units: "UNDECLARED", unit_evidence: [], units_status: "UNDECLARED"};
}

export function parseMtl(text) {
  const materials = [];
  let current = null;
  const unknown = [];
  for (const line of logicalLines(text)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const parts = stripped.split(/\s+/);
    const low = parts[0].toLowerCase();
    if (low === "newmtl") {
      current = {name: stripped.slice(parts[0].length).trim() || "unnamed", keys: {}};
      materials.push(current);
      continue;
    }
    if (!current) { unknown.push(parts[0]); continue; }
    if (MTL_KEYS.has(low)) current.keys[low] = parts.slice(1);
    else { unknown.push(parts[0]); }
  }
  return {
    material_count: materials.length,
    materials: materials.map(item => ({
      name: item.name,
      declared_keys: Object.keys(item.keys).sort(),
      values: item.keys,
      visual_only: true
    })),
    unknown_directives: [...new Set(unknown)].sort(),
    note: "MTL Ka/Kd/Ks/d/illum are viewer colors, not Elmer conductivity, permittivity, stiffness or density."
  };
}

function faceRef(token, vCount) {
  const raw0 = Number(token.split("/")[0]);
  if (!Number.isInteger(raw0) || raw0 === 0) throw Error("bad face index " + token);
  return raw0 < 0 ? vCount + raw0 + 1 : raw0;
}

export function captureObj(text, sourceName = "model.obj", mtlText = null, mtlName = null) {
  const statementCounts = {};
  const comments = [];
  let commentTotal = 0;
  const vertices = [];
  const counts = {v:0,vt:0,vn:0,vp:0,f:0,l:0,p:0};
  const objectsOrder = [];
  let currentObject = "default", currentGroup = "default", currentMaterial = null, currentSmooth = "off", seenObject = false;
  const faces = [];
  const mtllibs = [];
  const unknownSamples = [];
  let degenerate = 0;
  const faceKinds = {triangles:0, quads:0, ngons:0};
  let lineSegments = 0, points = 0;
  const groupsSeen = new Set(), materialsSeen = new Set(), smoothingSeen = new Set();
  const bump = key => { statementCounts[key] = (statementCounts[key] || 0) + 1; };
  const ensureObject = name => {
    currentObject = name || "default";
    seenObject = true;
    if (!objectsOrder.includes(currentObject)) objectsOrder.push(currentObject);
  };
  for (const line of logicalLines(text)) {
    const stripped = line.trim();
    if (!stripped) { bump("blank"); continue; }
    if (stripped.startsWith("#")) {
      commentTotal++; bump("comment");
      if (comments.length < 40) comments.push(stripped.slice(0,240));
      continue;
    }
    const parts = stripped.split(/\s+/);
    const key = parts[0], low = key.toLowerCase();
    bump(KNOWN.has(low) || low.startsWith("map_") ? low : key);
    if (low === "v" && parts.length >= 4) {
      counts.v++; vertices.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
    } else if (low === "vt") counts.vt++;
    else if (low === "vn") counts.vn++;
    else if (low === "vp") counts.vp++;
    else if (low === "o") ensureObject(stripped.slice(parts[0].length).trim() || "unnamed");
    else if (low === "g") { currentGroup = stripped.slice(parts[0].length).trim() || "default"; groupsSeen.add(currentGroup); }
    else if (low === "usemtl") { currentMaterial = stripped.slice(parts[0].length).trim() || "unnamed"; materialsSeen.add(currentMaterial); }
    else if (low === "mtllib") parts.slice(1).forEach(name => { if (!mtllibs.includes(name)) mtllibs.push(name); });
    else if (low === "s") { currentSmooth = parts[1] || "off"; smoothingSeen.add(currentSmooth); }
    else if (low === "f") {
      if (!seenObject) ensureObject("default");
      let idxs;
      try { idxs = parts.slice(1).map(tok => faceRef(tok, counts.v)); }
      catch { degenerate++; continue; }
      const unique = [];
      for (const idx of idxs) if (!unique.includes(idx)) unique.push(idx);
      if (unique.length < 3) { degenerate++; continue; }
      const kind = unique.length === 3 ? "triangles" : unique.length === 4 ? "quads" : "ngons";
      faceKinds[kind]++; counts.f++;
      faces.push({verts: unique, object: currentObject, group: currentGroup, material: currentMaterial, smoothing: currentSmooth});
      if (currentMaterial) materialsSeen.add(currentMaterial);
      groupsSeen.add(currentGroup);
    } else if (low === "l") { counts.l++; lineSegments += Math.max(0, parts.length - 2); }
    else if (low === "p") { counts.p++; points += Math.max(0, parts.length - 1); }
    else if (!KNOWN.has(low) && unknownSamples.length < 20 && !unknownSamples.includes(key)) unknownSamples.push(key);
  }
  let lo = [0,0,0], hi = [0,0,0], extent = [0,0,0], center = [0,0,0];
  if (vertices.length) {
    lo = [Infinity, Infinity, Infinity];
    hi = [-Infinity, -Infinity, -Infinity];
    center = [0, 0, 0];
    for (const v of vertices) for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); center[i] += v[i];
    }
    extent = lo.map((n, i) => hi[i] - n);
    center = center.map(n => n / vertices.length);
  }
  const scale = Math.max(...extent) || 1;
  const areaEps = 1e-12 * scale * scale;
  const area = idxs => {
    if (idxs.some(i => i < 1 || i > vertices.length)) return 0;
    const a = vertices[idxs[0]-1], b = vertices[idxs[1]-1], c = vertices[idxs[2]-1];
    const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
    const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
    const cx = uy*vz-uz*vy, cy = uz*vx-ux*vz, cz = ux*vy-uy*vx;
    return Math.hypot(cx, cy, cz);
  };
  let zeroArea = 0;
  const byObject = new Map();
  for (const face of faces) {
    face.zero_area = uniqueEnough(face) && area(face.verts) <= areaEps;
    if (face.zero_area) zeroArea++;
    if (!byObject.has(face.object)) byObject.set(face.object, []);
    byObject.get(face.object).push(face);
  }
  function uniqueEnough(face) { return face.verts.length >= 3; }
  function edgeStats(objFaces) {
    const parent = new Map();
    const find = v => { let p = parent.get(v); if (p !== v) { p = find(p); parent.set(v, p); } return p; };
    const union = (a,b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    const ends = new Map();
    const used = new Set();
    for (const face of objFaces) {
      if (face.zero_area) continue;
      const verts = face.verts;
      for (const vert of verts) if (vert >= 1 && vert <= vertices.length) { used.add(vert); if (!parent.has(vert)) parent.set(vert, vert); }
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i+1) % verts.length];
        if (a === b || a < 1 || b < 1 || a > vertices.length || b > vertices.length) continue;
        union(a, b);
        const slot = a < b ? 0 : 1;
        const id = Math.min(a,b) + "," + Math.max(a,b);
        const rec = ends.get(id) || [0,0];
        rec[slot]++; ends.set(id, rec);
      }
    }
    let boundary = 0, manifold = 0, nonmanifold = 0, inconsistent = 0;
    for (const [fwd, back] of ends.values()) {
      const total = fwd + back;
      if (total === 1) boundary++;
      else if (total === 2) { manifold++; if (fwd !== 1 || back !== 1) inconsistent++; }
      else if (total > 2) nonmanifold++;
    }
    const roots = new Set([...used].map(find));
    return {
      vertices_referenced: used.size,
      boundary_edges: boundary, manifold_edges: manifold, nonmanifold_edges: nonmanifold,
      inconsistent_winding_edges: inconsistent, face_components: roots.size,
      closed_oriented_surface: boundary === 0 && nonmanifold === 0 && inconsistent === 0 && objFaces.length > 0 && zeroArea === 0
    };
  }
  const objectReports = (objectsOrder.length ? objectsOrder : ["default"]).map(name => {
    const objFaces = byObject.get(name) || [];
    const stats = edgeStats(objFaces);
    const localZero = objFaces.some(face => face.zero_area);
    stats.closed_oriented_surface = stats.boundary_edges === 0 && stats.nonmanifold_edges === 0 && stats.inconsistent_winding_edges === 0 && objFaces.length > 0 && !localZero;
    const kinds = {triangles:0, quads:0, ngons:0};
    const groups = new Set(), mats = new Set(), smooth = new Set();
    for (const face of objFaces) {
      kinds[face.verts.length === 3 ? "triangles" : face.verts.length === 4 ? "quads" : "ngons"]++;
      groups.add(face.group); if (face.material) mats.add(face.material); smooth.add(face.smoothing);
    }
    return {
      name, faces: objFaces.length, face_kinds: kinds, groups: [...groups].sort(),
      materials_visual_only: [...mats].sort(), smoothing_groups: [...smooth].sort(),
      degenerate_or_zero_area_faces: objFaces.filter(face => face.zero_area).length,
      ...stats, has_surface: objFaces.length > 0
    };
  });
  const globalTopo = edgeStats(faces);
  const mtl = mtlText != null ? parseMtl(mtlText) : null;
  const supplied = mtl != null ? [mtlName || "inline.mtl"] : [];
  let missingMtl = mtllibs.filter(name => mtl == null);
  if (mtl != null && mtllibs.length === 1) missingMtl = [];
  else if (mtl != null) {
    const have = new Set(supplied.map(name => name.split(/[\\/]/).pop().toLowerCase()));
    missingMtl = mtllibs.filter(name => !have.has(name.split(/[\\/]/).pop().toLowerCase()));
  }
  const units = sniffUnits(comments);
  const freeform = [...FREEFORM].reduce((sum, name) => sum + (statementCounts[name] || 0), 0);
  const blockers = [];
  if (!counts.f) blockers.push("NO_FACES");
  if (units.original_units === "UNDECLARED" || units.original_units === "CONFLICTING") blockers.push("UNITS_" + units.units_status);
  if (globalTopo.boundary_edges) blockers.push("OPEN_SURFACE");
  if (globalTopo.nonmanifold_edges) blockers.push("NONMANIFOLD_EDGES");
  if (globalTopo.inconsistent_winding_edges) blockers.push("INCONSISTENT_WINDING");
  if (degenerate || zeroArea) blockers.push("DEGENERATE_OR_ZERO_AREA_FACES");
  if (freeform) blockers.push("FREEFORM_NOT_MESH");
  if (missingMtl.length) blockers.push("MTL_REFERENCED_NOT_SUPPLIED");
  blockers.push("NOT_A_VOLUME_MESH","NO_PHYSICAL_MATERIAL_CONSTANTS","NO_BOUNDARY_CONDITIONS","NO_SIF");
  const present = Object.keys(statementCounts).filter(key => statementCounts[key] && key !== "blank").sort();
  const absent = [...KNOWN].filter(key => !present.includes(key)).sort();
  return {
    schema: SCHEMA,
    source_name: sourceName,
    audit_level: "FULL_WAVEFRONT_INVENTORY",
    claim_boundary: "Geometry inventory only. No Elmer solve, no energy claim, no build-ready status.",
    statements: {
      counts: statementCounts, record_types_present: present, standard_record_types_absent: absent,
      comments_kept: comments, comment_count: commentTotal, comments_truncated: commentTotal > comments.length,
      unknown_directives_sample: unknownSamples, freeform_statements: freeform
    },
    coordinates: {
      vertices: counts.v, texture_vertices: counts.vt, normals: counts.vn, parameter_vertices: counts.vp,
      bounds_file_units: {min: lo, max: hi, extent}, vertex_centroid_file_units: center,
      original_units: units.original_units, units_status: units.units_status, unit_evidence: units.unit_evidence
    },
    elements: {
      faces: counts.f, face_kinds: faceKinds, degenerate_faces: degenerate, zero_area_faces: zeroArea,
      line_records: counts.l, line_segments: lineSegments, point_records: counts.p, points
    },
    naming: {
      objects: objectReports.map(item => item.name), groups: [...groupsSeen].sort(),
      smoothing_groups: [...smoothingSeen].sort(), usemtl: [...materialsSeen].sort(), mtllib: mtllibs
    },
    objects: objectReports,
    topology: globalTopo,
    materials: {
      visual_names: [...materialsSeen].sort(), mtl_files_referenced: mtllibs,
      mtl_files_supplied: supplied, mtl_files_missing: missingMtl, parsed_mtl: mtl
    },
    elmer: {
      role: "surface inventory for a later volume mesh and case.sif",
      solver_mesh_status: "NOT_YET_GENERATED",
      can_start_elmer_solver: false,
      body_names: objectReports.filter(item => item.has_surface).map(item => item.name),
      open_objects: objectReports.filter(item => item.has_surface && !item.closed_oriented_surface).map(item => item.name),
      closed_oriented_objects: objectReports.filter(item => item.closed_oriented_surface).map(item => item.name),
      visual_material_names: [...materialsSeen].sort(),
      blockers,
      still_required: [
        "declared length unit and reference frame",
        "decision: closed solid, open shell, or centerline-only",
        "volume mesh via ElmerGrid or Gmsh, plus mesh hash",
        "physical material constants with source and uncertainty",
        "boundary and initial conditions tied to named surfaces",
        "case.sif",
        "solver build manifest and convergence gate"
      ]
    }
  };
}

function captureStl(buffer) {
  const bytes = new Uint8Array(buffer);
  const ascii = new TextDecoder("latin1").decode(bytes.slice(0, 80));
  if (bytes.length >= 84 && !ascii.trimStart().toLowerCase().startsWith("solid")) {
    const count = new DataView(buffer).getUint32(80, true);
    return {format:"stl-binary", header: ascii.replace(/\u0000/g," ").trim().slice(0,80), triangle_count: count, size_matches: bytes.length === 84 + count * 50};
  }
  const text = new TextDecoder().decode(bytes);
  const solid = (text.match(/^\s*solid\s+(.*)$/im) || [])[1] || "";
  const triangles = (text.match(/^\s*facet\s+normal\b/gim) || []).length;
  return {format:"stl-ascii", solid_name: solid.trim(), triangle_count: triangles, size_matches: null};
}

export async function previewAudit(file, object, THREE, rawText = "", mtlBundle = null) {
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) throw Error("No bounding geometry");
  const lo = bounds.min.toArray(), hi = bounds.max.toArray();
  const extent = bounds.getSize(new THREE.Vector3()).toArray();
  let meshCount=0, lineCount=0, trianglesEstimate=0, positionSamples=0;
  object.traverse(child => {
    if (!child.geometry) return;
    const geom = child.geometry;
    const pos = geom.getAttribute?.("position");
    if (pos) positionSamples += pos.count;
    if (child.isMesh) {
      meshCount++;
      trianglesEstimate += Math.floor((geom.index?.count ?? pos?.count ?? 0)/3);
    }
    if (child.isLine || child.isLineSegments) lineCount++;
  });
  const sha256 = await sha256Of(await file.arrayBuffer());
  const ext = file.name.split(".").pop().toLowerCase();
  let wavefront = null, parseError = null, stl = null;
  if (ext === "obj") {
    try { wavefront = captureObj(rawText, file.name, mtlBundle?.text ?? null, mtlBundle?.name ?? null); wavefront.sha256 = sha256; wavefront.file_size_bytes = file.size; }
    catch (err) { parseError = String(err.message || err); }
  } else if (ext === "stl") {
    try { stl = captureStl(await file.arrayBuffer()); }
    catch (err) { parseError = String(err.message || err); }
  }
  return {
    source_name: file.name, format: ext, file_size_bytes: file.size, sha256,
    model_line_declared: "A",
    original_units: wavefront?.coordinates.original_units || "UNDECLARED",
    bounds_file_units: wavefront?.coordinates.bounds_file_units || {min:lo, max:hi, extent},
    preview_counts: {mesh_objects:meshCount, line_objects:lineCount, triangle_estimate:trianglesEstimate, position_samples:positionSamples},
    audit_level: wavefront ? "FULL_WAVEFRONT_INVENTORY" : "BROWSER_PREVIEW_ONLY",
    wavefront, stl, parse_error: parseError,
    elmer_handoff: wavefront?.elmer || {can_start_elmer_solver:false, solver_mesh_status:"NOT_YET_GENERATED", blockers:["FULL_CAPTURE_UNAVAILABLE"]},
    warnings: [
      "Three.js preview may triangulate OBJ faces. The wavefront block keeps the authored face kinds.",
      "Coordinates stay in file units until a comment declares a unit.",
      "MTL colors are not Elmer material constants.",
      "No file content was sent to the website. Export the JSON and compare it by SHA-256."
    ]
  };
}

export function summarizeCapture(record) {
  const wave = record.wavefront;
  if (!wave) return record.source_name + ": Vorschau ohne vollständiges OBJ-Inventar.";
  const elmer = wave.elmer;
  return [
    wave.source_name,
    "Objekte " + wave.naming.objects.length,
    "Flächen " + wave.elements.faces + " (Dreiecke " + wave.elements.face_kinds.triangles + ", Vierecke " + wave.elements.face_kinds.quads + ")",
    "Einheiten " + wave.coordinates.original_units,
    "Randkanten " + wave.topology.boundary_edges,
    "geschlossen " + (elmer.closed_oriented_objects.join(", ") || "keins"),
    "offen " + (elmer.open_objects.join(", ") || "keins"),
    "Materialnamen " + (elmer.visual_material_names.join(", ") || "keine"),
    "Elmer-Start blockiert"
  ].join(" · ");
}

export function downloadAuditReport(records) {
  if (!records.length) return false;
  const payload = {
    schema: "STA_BROWSER_INTAKE_V2",
    created_utc: new Date().toISOString(),
    model_line: "A",
    transfer_state: "LOCAL_EXPORT_NOT_SENT",
    source_count: records.length,
    models: records,
    note: "Local browser inventory, not an Elmer mesh and not a physics result. Match originals by SHA-256 before private intake."
  };
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "STA_A_OBJ_CAPTURE.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}
