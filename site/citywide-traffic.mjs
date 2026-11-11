// Citywide simulated road actors (NOT live traffic). Official City centreline lanes with
// Ontario-DTM heights, streamed in 1 km tiles; a car is drawn only where its whole
// projected footprint lies on road/parking in the source-aligned semantic mask, so
// buildings occlude it. At night, headlight cones light the pavement ahead.
import {pointAt,rectangle} from './motion-source.mjs';
import {projectActor,drawRoadActors} from './runtime-motion.mjs';

const MIN_SCALE=1.2;       // screen px per metre before cars appear
const MAX_TILES=16, MASK_TILE=512;

function atHeight(route,distance){
 const p=pointAt(route,distance),s=route.samples;let lo=0,hi=s.length-1;
 while(hi-lo>1){const m=(lo+hi)>>1;if(s[m].distance<distance)lo=m;else hi=m;}
 const a=s[lo],b=s[hi],t=Math.max(0,Math.min(1,(distance-a.distance)/((b.distance-a.distance)||1)));
 return {...p,y:a.y+(b.y-a.y)*t};
}
const overlaps=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];

export function createCityTraffic({index,canvas,projection,loadJSON,loadBitmap}){
 const roads=new Map(),masks=new Map();
 const l0=[...canvas.levels].sort((a,b)=>b.pixels[0]-a.pixels[0])[0];
 const maskByCell=new Map(l0.tiles.filter(t=>t.motion_mask).map(t=>[`${t.rect_px[0]/MASK_TILE}_${t.rect_px[1]/MASK_TILE}`,t]));
 const R=canvas.projected_rect_m,W=l0.pixels[0],H=l0.pixels[1];
 const toPx=([x,y])=>[(x-R[0])/(R[2]-R[0])*W,(R[3]-y)/(R[3]-R[1])*H];
 const state={active:false,visibleCars:0,loadedTiles:0,cones:0};

 function ensureRoad(t){
  if(roads.has(t.id))return roads.get(t.id);
  const row={status:'loading',t};roads.set(t.id,row);
  loadJSON(t).then(d=>{row.routes=d.routes;row.cars=d.routes.flatMap((r,ri)=>r.cars.map(c=>({route:ri,distance:c.distance%r.length,paint:c.paint})));for(const c of row.cars)Object.assign(c,atHeight(row.routes[c.route],c.distance));row.status='ready';}).catch(()=>{row.status='error';});
  return row;
 }
 function ensureMask(key){
  if(masks.has(key))return masks.get(key);
  const tile=maskByCell.get(key),row={status:tile?'loading':'none',tile};masks.set(key,row);
  if(tile)loadBitmap(tile.motion_mask).then(bmp=>{row.bitmap=bmp;const c=new OffscreenCanvas(bmp.width,bmp.height),g=c.getContext('2d');g.drawImage(bmp,0,0);const d=g.getImageData(0,0,bmp.width,bmp.height).data,a=new Uint8Array(bmp.width*bmp.height);for(let i=0;i<a.length;i++)a[i]=d[i*4+3];row.alpha=a;row.w=bmp.width;row.status='ready';}).catch(()=>{row.status='error';});
  return row;
 }
 // Whole projected car volume (+2 px halo) must be pavement in the mask.
 function visible(car){
  const pts=rectangle(car.x,car.z,4.3,1.9,car.yaw).slice(0,4).flatMap(([x,z])=>[0,1.6].map(h=>toPx(projectActor({x,y:car.y+h,z},projection))));
  const x0=Math.floor(Math.min(...pts.map(p=>p[0])))-2,x1=Math.ceil(Math.max(...pts.map(p=>p[0])))+2,y0=Math.floor(Math.min(...pts.map(p=>p[1])))-2,y1=Math.ceil(Math.max(...pts.map(p=>p[1])))+2;
  if(x0<0||y0<0||x1>=W||y1>=H)return false;
  const at=(x,y)=>{const m=ensureMask(`${Math.floor(x/MASK_TILE)}_${Math.floor(y/MASK_TILE)}`);return m.status==='ready'?m.alpha[(y%MASK_TILE)*m.w+(x%MASK_TILE)]:-1;};
  const [cx,cy]=toPx(projectActor({x:car.x,y:car.y,z:car.z},projection)).map(Math.round);
  if(at(cx,cy)!==255)return false;   // centre on pavement
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const v=at(x,y);if(v===-1||v===0)return false;}  // no building covers any of it
  return true;
 }
 function inView(view){return index.tiles.filter(t=>overlaps(view,t.rect_m)).slice(0,MAX_TILES);}
 return {state,
  active(scale){return scale>=MIN_SCALE;},
  advance(dt,view){const step=Math.max(0,Math.min(Number.isFinite(dt)?dt:0,.3));for(const t of inView(view)){const r=roads.get(t.id);if(r?.status!=='ready')continue;for(const c of r.cars){const route=r.routes[c.route];c.distance=(c.distance+step*route.speed)%route.length;Object.assign(c,atHeight(route,c.distance));}}},
  draw(ctx,view,scale,toScreen,night,dpr,size){
   state.active=scale>=MIN_SCALE;state.visibleCars=0;state.cones=0;state.candidates=0;state.rejects=[];if(!state.active)return false;
   const cars=[];for(const t of inView(view)){const r=ensureRoad(t);if(r.status!=='ready')continue;for(const c of r.cars){const [px,py]=projectActor(c,projection);if(px<view[0]-10||px>view[2]+10||py<view[1]-10||py>view[3]+10)continue;state.candidates++;if(visible(c))cars.push(c);else if(state.rejects.length<12)state.rejects.push({x:c.x,z:c.z,y:c.y,px:toPx([px,py])});}}
   state.loadedTiles=[...roads.values()].filter(r=>r.status==='ready').length;state.visibleCars=cars.length;
   if(night>.02&&cars.length)drawHeadlights(ctx,cars,view,toScreen,night,dpr,size);
   drawRoadActors(ctx,{cars},projection,toScreen,night);
   return true;
  }};

 function drawHeadlights(ctx,cars,view,toScreen,night,dpr,size){
  const layer=new OffscreenCanvas(Math.max(1,Math.round(size[0]*dpr)),Math.max(1,Math.round(size[1]*dpr))),g=layer.getContext('2d');
  g.setTransform(dpr,0,0,dpr,0,0);g.globalCompositeOperation='lighter';
  for(const car of cars){
   // Ground cone ahead of the car: 2 m to 24 m forward, 1.7 m to 9 m wide, at road height.
   const fx=Math.sin(car.yaw),fz=Math.cos(car.yaw),rx=fz,rz=-fx,pt=(f,s)=>toScreen(projectActor({x:car.x+fx*f+rx*s,y:car.y+.05,z:car.z+fz*f+rz*s},projection));
   const a=pt(2.1,-.85),b=pt(2.1,.85),c=pt(24,4.5),d=pt(24,-4.5),near=pt(2.1,0),far=pt(24,0);
   const grad=g.createLinearGradient(near[0],near[1],far[0],far[1]);
   grad.addColorStop(0,`rgba(255,238,196,${.62*night})`);grad.addColorStop(.45,`rgba(255,230,180,${.28*night})`);grad.addColorStop(1,'rgba(255,225,170,0)');
   g.fillStyle=grad;g.beginPath();g.moveTo(...a);g.lineTo(...b);g.lineTo(...c);g.lineTo(...d);g.closePath();g.fill();
   // Soft red tail glow on the pavement behind.
   const t=pt(-3.2,0),tr=Math.hypot(...[0,1].map(i=>pt(-3.2,1.6)[i]-t[i]))||2,rg=g.createRadialGradient(t[0],t[1],0,t[0],t[1],tr*1.6);
   rg.addColorStop(0,`rgba(255,40,20,${.35*night})`);rg.addColorStop(1,'rgba(255,40,20,0)');g.fillStyle=rg;g.beginPath();g.arc(t[0],t[1],tr*1.6,0,Math.PI*2);g.fill();
   state.cones++;
  }
  // Light falls only on pavement: keep cone pixels where the mask is road/parking.
  g.globalCompositeOperation='destination-in';
  const rows=new Map();for(const k of masks.keys())rows.set(k,masks.get(k));
  const mask=new OffscreenCanvas(layer.width,layer.height),mg=mask.getContext('2d');mg.setTransform(dpr,0,0,dpr,0,0);
  for(const m of rows.values()){if(m.status!=='ready')continue;const r=m.tile.rect_px,p0=[R[0]+r[0]/W*(R[2]-R[0]),R[3]-r[1]/H*(R[3]-R[1])],p1=[R[0]+r[2]/W*(R[2]-R[0]),R[3]-r[3]/H*(R[3]-R[1])];if(!overlaps(view,[p0[0],p1[1],p1[0],p0[1]]))continue;const s0=toScreen(p0),s1=toScreen(p1);mg.drawImage(m.bitmap,s0[0],s0[1],s1[0]-s0[0],s1[1]-s0[1]);}
  g.setTransform(1,0,0,1,0,0);g.drawImage(mask,0,0);
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='lighter';ctx.drawImage(layer,0,0);ctx.restore();
 }
}
