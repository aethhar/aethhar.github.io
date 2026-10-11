/* STA-A browser-side preview intake. No network upload, no automatic solver promotion. */
export async function previewAudit(file, object, THREE) {
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
  let sha256 = null;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,"0")).join("");
  }
  return {
    source_name: file.name, format: file.name.split(".").pop().toLowerCase(),
    file_size_bytes: file.size, sha256,
    model_line_declared: "A", original_units: "UNDECLARED",
    bounds_file_units: {min:lo,max:hi,extent},
    preview_counts: {mesh_objects:meshCount,line_objects:lineCount,
      triangle_estimate:trianglesEstimate,position_samples:positionSamples},
    audit_level: "BROWSER_PREVIEW_ONLY",
    elmer_handoff: "BLOCKED; full topology audit, units, volume mesh, materials, boundary conditions and physics required",
    warnings: ["Preview faces may be triangulated or duplicated by OBJLoader",
      "Coordinates are in file units, not necessarily millimeters or meters",
      "No file content was sent to the website; export the report for private intake"]
  };
}
export function downloadAuditReport(records) {
  if (!records.length) return false;
  const payload = {schema:"STA_BROWSER_INTAKE_V1",
    created_utc:new Date().toISOString(),
    model_line:"A", transfer_state:"LOCAL_EXPORT_NOT_SENT",
    source_count:records.length, models:records,
    note:"Local browser preview, not solver certification. Match against originals by SHA-256 in private STA intake."};
  const blob = new Blob([JSON.stringify(payload,null,2)+"\n"],{type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download="STA_A_BROWSER_INTAKE.json"; document.body.appendChild(a);
  a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
  return true;
}
