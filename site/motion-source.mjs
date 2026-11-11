// Generated from actual source-viewer/miniature-motion.mjs (pointAt) and geography.mjs (rectangle).
// Rebuild with build_motion_source.mjs; do not fork their movement/footprint logic.
export function pointAt(path,distance){
  const d=Math.max(0,Math.min(path.length-.0001,distance));let low=0,high=path.samples.length-1;
  while(high-low>1){const mid=(low+high)>>1;if(path.samples[mid].distance<d)low=mid;else high=mid;}
  const a=path.samples[low],b=path.samples[high],span=b.distance-a.distance,t=span>0?(d-a.distance)/span:0;
  return{x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t,yaw:Math.atan2(b.x-a.x,b.z-a.z)};
}

export function rectangle(x,z,length,width,yaw) {
  const fx=Math.sin(yaw),fz=Math.cos(yaw),rx=fz,rz=-fx;
  return [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5],[0,0],[0,-.5],[.5,0],[0,.5],[-.5,0]].map(([a,b])=>[x+rx*a*width+fx*b*length,z+rz*a*width+fz*b*length]);
}
