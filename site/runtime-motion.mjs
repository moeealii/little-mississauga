// Small raster-viewer adapter over actual source-viewer motion/footprint math.
// No routes, elevations, visibility or artwork registration are inferred here.
import {pointAt,rectangle} from './motion-source.mjs';
import {supportedProjection} from './projection.mjs';
export const VISIBILITY_ENCODING='R-safe-car-volume-v1';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const localAsset=(a,ext)=>a&&hash(a.sha256)&&typeof a.url==='string'&&new RegExp('^art/[a-zA-Z0-9_./-]+\\.'+ext+'$').test(a.url)&&!a.url.split('/').includes('..');
const reviewed=v=>v?.status==='accepted'&&typeof v.reviewed_at==='string'&&Number.isFinite(Date.parse(v.reviewed_at));
const keys=['geometry_sha256','terrain_sha256','roads_sha256','surfaces_sha256'];
const sameSource=(a,b)=>keys.every(k=>hash(a?.[k])&&a[k]===b?.[k]);
export function motionEligibility(canvas){
 const m=canvas.motion;
 if(!m)return {allowed:false,reason:'No same-frame road, height and actor-visibility binding. Cars withheld.'};
 if(m.frame_id!==canvas.frame_id||!localAsset(m.plan,'json')||!localAsset(m.visibility,'(?:png|webp)')||m.visibility.frame_id!==canvas.frame_id||m.visibility.encoding!==VISIBILITY_ENCODING||!sameSource(m.source_binding,canvas.source_binding))return {allowed:false,reason:'Motion frame/source/visibility binding is incomplete or mismatched. Cars withheld.'};
 if(m.visibility.raw&&(!localAsset(m.visibility.raw,'rgba')||m.visibility.raw.encoding!=='RGBA-binary-motion-visibility-v1'||m.visibility.raw.source_png_sha256!==m.visibility.sha256||m.visibility.raw.frame_id!==canvas.frame_id||JSON.stringify(m.visibility.raw.pixels)!==JSON.stringify(canvas.pixels)))return {allowed:false,reason:'Raw actor visibility derivation/frame/pixels do not match the reviewed PNG. Cars withheld.'};
 if(!reviewed(m.review)||m.review.artwork_alignment!=='accepted'||m.review.clean_roads!=='accepted'||m.review.occlusion!=='accepted'||m.review.road_clearance!=='accepted')return {allowed:false,reason:'Road alignment, clean backdrop and full car-volume occlusion review required. Cars withheld.'};
 return {allowed:true,reason:'Registered simulated road actors, not live traffic.'};
}
export const HIDE_ZONE_WRAP='reviewed-car-volume-hide-zone-v1';
// Conservative whole projected actor volume, including lamps and a three-pixel
// halo. A partially covered actor is hidden, never sliced by the raster mask.
export function actorVisibleByMask(car,projection,rect,mask,hidden=false){
 if(!mask||!Number.isInteger(mask.width)||!Number.isInteger(mask.height)||mask.width<=0||mask.height<=0||mask.data?.length!==mask.width*mask.height||!Number.isFinite(car.yaw)||!rect||rect[2]<=rect[0]||rect[3]<=rect[1])return false;
 const points=rectangle(car.x,car.z,4.3,1.9,car.yaw).slice(0,4).flatMap(([x,z])=>[0,2].map(h=>projectActor({x,y:car.y+h,z},projection)));
 if(!points.flat().every(Number.isFinite))return false;
 const xs=points.map(p=>(p[0]-rect[0])/(rect[2]-rect[0])*mask.width),ys=points.map(p=>(rect[3]-p[1])/(rect[3]-rect[1])*mask.height);
 const bounds=[Math.floor(Math.min(...xs))-3,Math.floor(Math.min(...ys))-3,Math.ceil(Math.max(...xs))+3,Math.ceil(Math.max(...ys))+3];
 if(!hidden&&(bounds[0]<0||bounds[1]<0||bounds[2]>=mask.width||bounds[3]>=mask.height))return false;
 for(let y=Math.max(0,bounds[1]);y<=Math.min(mask.height-1,bounds[3]);y++)for(let x=Math.max(0,bounds[0]);x<=Math.min(mask.width-1,bounds[2]);x++)if(hidden?mask.data[y*mask.width+x]!==0:mask.data[y*mask.width+x]!==255)return false;
 return true;
}
export function validateMotionPlan(plan,canvas,projection,{visibilityMask=null}={}){
 if(!motionEligibility(canvas).allowed)throw Error('Motion binding not accepted');
 if(!supportedProjection(projection?.id)||![projection.right,projection.up,projection.target_local].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)))throw Error('Canonical camera binding required');
 if(plan.schema_version!==1||plan.frame_id!==canvas.frame_id||plan.projection_id!==projection.id||plan.coordinates!=='canonical-city-east-up-south-metres'||!sameSource(plan.source_binding,canvas.motion.source_binding))throw Error('Motion plan source/frame/projection mismatch');
 const tiles=canvas.levels.flatMap(l=>l.tiles.map(t=>({level:l.id,tile:t.id,sha256:t.base.sha256})));
 if(JSON.stringify(plan.artwork_tiles)!==JSON.stringify(tiles))throw Error('Motion plan does not bind every exact artwork tile');
 if(!Array.isArray(plan.routes)||!plan.routes.length||plan.routes.length>8||!Array.isArray(plan.cars)||!plan.cars.length||plan.cars.length>192)throw Error('Invalid bounded motion plan');
 for(const route of plan.routes){
  const hiddenWrap=route.wrap_mode===HIDE_ZONE_WRAP;
  if(!Number.isFinite(route.length)||route.length<=0||!Number.isFinite(route.speed)||route.speed<=0||route.speed>15||(hiddenWrap?route.wrapEndpointsOffscreen!==false:route.wrapEndpointsOffscreen!==true)||(!hiddenWrap&&route.wrap_mode!==undefined)||!Array.isArray(route.samples)||route.samples.length<2||route.samples.length>20000)throw Error('Invalid source road route');
  let last=null;
  for(const p of route.samples){
   if(!['x','y','z','distance'].every(k=>Number.isFinite(p[k]))||Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z))>100000)throw Error('Missing or invalid source road elevation');
   if(last&&(p.distance<=last.distance||Math.abs((p.distance-last.distance)-Math.hypot(p.x-last.x,p.z-last.z))>.01))throw Error('Road distance samples do not match source motion parameterization');
   last=p;
  }
  if(route.samples[0].distance!==0||Math.abs(last.distance-route.length)>.001)throw Error('Invalid route extent');
  // Native motion wraps outside its source view. Require the entire actor to
  // disappear outside this artwork crop too, including when the city is zoomed out.
  if(hiddenWrap){
   if(canvas.motion.review.wrap_policy!==HIDE_ZONE_WRAP||!visibilityMask||visibilityMask.width!==canvas.pixels[0]||visibilityMask.height!==canvas.pixels[1]||visibilityMask.data.length!==visibilityMask.width*visibilityMask.height||!visibilityMask.data.every(v=>v===0||v===255))throw Error('Reviewed hide-zone policy and exact binary mask bytes required');
   for(const distance of [0,Math.max(0,route.length-1e-6)])if(!actorVisibleByMask(atHeight(route,distance),projection,canvas.projected_rect_m,visibilityMask,true))throw Error('Full wrap actor volume overlaps visible mask');
   if(!route.samples.some(p=>actorVisibleByMask(atHeight(route,Math.min(p.distance,route.length-1e-6)),projection,canvas.projected_rect_m,visibilityMask)))throw Error('Hide-zone route has no wholly visible actor volume');
  }else for(const p of [route.samples[0],last]){const [x,y]=projectActor(p,projection),b=canvas.projected_rect_m;if(x>=b[0]-4&&x<=b[2]+4&&y>=b[1]-4&&y<=b[3]+4)throw Error('Route wrap endpoint lies inside the artwork crop');}
 }
 for(const car of plan.cars)if(!Number.isInteger(car.route)||!plan.routes[car.route]||!Number.isFinite(car.distance)||car.distance<0||car.distance>=plan.routes[car.route].length||!Number.isInteger(car.paint)||car.paint<0||car.paint>6)throw Error('Invalid source road actor');
 return plan;
}
export function projectActor(p,projection){
 const v=[p.x-projection.target_local[0],p.y-projection.target_local[1],p.z-projection.target_local[2]];
 return [v.reduce((s,n,i)=>s+n*projection.right[i],0),v.reduce((s,n,i)=>s+n*projection.up[i],0)];
}
function atHeight(route,distance){
 const p=pointAt(route,distance);let low=0,high=route.samples.length-1;
 while(high-low>1){const mid=(low+high)>>1;if(route.samples[mid].distance<distance)low=mid;else high=mid;}
 const a=route.samples[low],b=route.samples[high],t=Math.max(0,Math.min(1,(distance-a.distance)/(b.distance-a.distance)));
 return {...p,y:a.y+(b.y-a.y)*t};
}
export function createRoadActors(plan){
 const cars=plan.cars.map(c=>({...c,...atHeight(plan.routes[c.route],c.distance)}));
 return {cars,advance(dt){
  // Same bounded timestep/wrap behavior as addMiniatureMotion; never catch up a hidden tab.
  const step=Math.max(0,Math.min(Number.isFinite(dt)?dt:0,.3));
  for(const car of cars){const path=plan.routes[car.route];car.distance=(car.distance+step*path.speed)%path.length;Object.assign(car,atHeight(path,car.distance));}
 }};
}
// Source-viewer car dimensions/palette, projected into the raster camera. This
// adapts the existing miniature actor, not independently invented road positions.
const paints=['#f2f0e6','#b64d43','#467999','#526774','#c7b58a','#dbbb54','#3e454b'];
export function drawRoadActors(ctx,actors,projection,toScreen,night=0){
 const cars=[...actors.cars].sort((a,b)=>(a.x+a.z)-(b.x+b.z));
 for(const car of cars){
  for(const [length,width,low,high,color]of [[4.1,1.8,.29,.91,paints[car.paint]],[2.25,1.45,.775,1.325,'#355d70']]){
   const corners=rectangle(car.x,car.z,length,width,car.yaw).slice(0,4);
   const points=corners.map(([x,z])=>toScreen(projectActor({x,y:car.y+high,z},projection)));
   const bottoms=corners.map(([x,z])=>toScreen(projectActor({x,y:car.y+low,z},projection)));
   ctx.fillStyle=color;
   for(const face of [[points[0],points[1],bottoms[1],bottoms[0]],[points[1],points[2],bottoms[2],bottoms[1]],[points[2],points[3],bottoms[3],bottoms[2]],[points[3],points[0],bottoms[0],bottoms[3]],points]){
    ctx.beginPath();face.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fill();
    // Ambient body grading; night lamps below are separate source-sized emitters.
    ctx.fillStyle=`rgba(8,18,43,${Math.max(0,Math.min(1,night))*.65})`;ctx.fill();ctx.fillStyle=color;
   }
  }
  if(night>0){
   // Same actual source-car lamp dimensions/offsets as the reviewed private
   // renderer. The caller still clips the full actor through its reviewed
   // same-frame safe-volume matte, so no building/road light pools are invented.
   const co=Math.cos(car.yaw),si=Math.sin(car.yaw),front=si+co,side=co-si;
   ctx.save();ctx.globalAlpha=Math.max(0,Math.min(1,night));
   for(const [z,color,facing]of [[2.06,'#fff0cf',front],[-2.06,'#ff210c',-front]])for(const x of [-.73,.73]){
    if(facing<-.3||Math.abs(facing)<.3&&Math.sign(x)!==Math.sign(side))continue;
    const cx=car.x+x*co+z*si,cz=car.z-x*si+z*co,corners=rectangle(cx,cz,.16,.38,car.yaw).slice(0,4),top=corners.map(([px,pz])=>toScreen(projectActor({x:px,y:car.y+.74,z:pz},projection))),bottom=corners.map(([px,pz])=>toScreen(projectActor({x:px,y:car.y+.50,z:pz},projection)));
    ctx.fillStyle=color;for(const face of [[top[0],top[1],bottom[1],bottom[0]],[top[1],top[2],bottom[2],bottom[1]],[top[2],top[3],bottom[3],bottom[2]],[top[3],top[0],bottom[0],bottom[3]],top]){ctx.beginPath();face.forEach((p,i)=>i?ctx.lineTo(...p):ctx.moveTo(...p));ctx.closePath();ctx.fill();}
   }
   ctx.restore();
  }
 }
}
