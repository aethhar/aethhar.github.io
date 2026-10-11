// STA geometry audit core — local-only, no external requests.
// Units must be provided by the researcher; OBJ/STL do not encode reliable units.
export async function fingerprint(file) {
  const data = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), b=>b.toString(16).padStart(2,"0")).join("");
}
export function inspectGeometry(root, THREE, options={}) {
  const unit=Number(options.mmPerUnit);
  if (!(unit>0) || !Number.isFinite(unit)) throw Error("Maßeinheit fehlt: mm pro Dateieinheit angeben.");
  const meshes=[];
  root.updateMatrixWorld(true);
  root.traverse(node=>{
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos=node.geometry.attributes.position, ix=node.geometry.index;
    const bounds=new THREE.Box3().setFromObject(node);
    const vertices=pos.count, triangles=ix?Math.floor(ix.count/3):Math.floor(vertices/3);
    meshes.push({name:node.name||"Mesh "+(meshes.length+1),vertices,triangles,
      bounds,worldMatrix:node.matrixWorld.clone()});
  });
  const findings=[];
  // Bounding-box proximity is a BROAD-PHASE CANDIDATE only, never proof of
  // conductor collision, minimum conductor clearance, or electrical contact.
  for(let i=0;i<meshes.length;i++) for(let j=i+1;j<meshes.length;j++){
    const a=meshes[i],b=meshes[j];
    const dx=Math.max(0,a.bounds.min.x-b.bounds.max.x,b.bounds.min.x-a.bounds.max.x);
    const dy=Math.max(0,a.bounds.min.y-b.bounds.max.y,b.bounds.min.y-a.bounds.max.y);
    const dz=Math.max(0,a.bounds.min.z-b.bounds.max.z,b.bounds.min.z-a.bounds.max.z);
    const lowerBound=Math.hypot(dx,dy,dz)*unit;
    findings.push({meshA:a.name,meshB:b.name,lowerBoundDistanceMm:lowerBound,
      boundingBoxesOverlap:lowerBound===0,
      classification:lowerBound===0?"REQUIRES_NARROW_PHASE":"BBOX_SEPARATED",
      electricalContact:"UNKNOWN",collision:"UNKNOWN",
      note:"Bounding-box lower bound only; actual surface clearance and electrical connectivity not computed."});
  }
  const box=new THREE.Box3().setFromObject(root),dims=box.getSize(new THREE.Vector3());
  return {schema:"sta.geometry-audit.v1",method:"bbox-broadphase",mmPerUnit:unit,
    dimensionsMm:dims.toArray().map(x=>x*unit),meshCount:meshes.length,
    vertexCount:meshes.reduce((s,m)=>s+m.vertices,0),
    triangleCount:meshes.reduce((s,m)=>s+m.triangles,0),
    pairCount:findings.length,findings,
    collisionStatus:"NOT_VERIFIED",electricalContactStatus:"NOT_VERIFIED",
    minimumConductorClearanceStatus:"NOT_VERIFIED",
    warning:"Broad-phase only. Do not use to certify No-Short, contact, insulation or fabrication."};
}
export function downloadAudit(report) {
  const blob=new Blob([JSON.stringify(report,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download="STA_GEOMETRY_AUDIT_"+new Date().toISOString().replace(/[:.]/g,"-")+".json";
  a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
