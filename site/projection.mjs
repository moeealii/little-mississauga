// Explicit frames. Ontario/CGVD2013 is never an alias for the historical Mapzen frame.
export const LEGACY_PROJECTION_ID='mississauga-utm26917-p30-h45-target40-v1';
export const ONTARIO_PROJECTION_ID='mississauga-utm26917-ontario-cgvd2013-p30-h45-target40-v1';
export const ONTARIO_CONTRACT_ID='rebuild-20261109-02-ontario-primary-cgvd2013-v1';
export const CITY_ORIGIN_UTM=Object.freeze([609535.8929959498,4827537.5180401895]);
export const COMMON_REFERENCE_ELEVATION_M=156.783187866;
export function supportedProjection(id){return id===LEGACY_PROJECTION_ID||id===ONTARIO_PROJECTION_ID;}
const vector=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
export function validateOntarioFrame(p){
 if(p?.id!==ONTARIO_PROJECTION_ID||p.horizontal_crs!=='EPSG:26917'||p.vertical_crs!=='EPSG:6647'||p.terrain_contract_id!==ONTARIO_CONTRACT_ID||!/^([a-f0-9]{64})$/.test(p.terrain_contract_sha256||'')||!vector(p.origin_utm,2)||p.origin_utm.some((n,i)=>Math.abs(n-CITY_ORIGIN_UTM[i])>1e-6)||!Number.isFinite(p.reference_elevation_m)||Math.abs(p.reference_elevation_m-COMMON_REFERENCE_ELEVATION_M)>1e-6||!vector(p.target_local,3)||p.target_local.some((n,i)=>n!==[0,40,0][i])||p.pitch_deg!==30||p.heading_deg!==45)throw Error('Invalid explicit Ontario city frame');
 return p;
}
export function sourceToCity(point,sourceFrame,city){
 validateOntarioFrame(city);
 const f=sourceFrame;
 if(f?.horizontal_crs!=='EPSG26917'||!vector(f.block_origin_easting_northing_m,2)||!vector(f.city_origin_easting_northing_m,2)||f.city_origin_easting_northing_m.some((n,i)=>Math.abs(n-city.origin_utm[i])>1e-6)||!Number.isFinite(f.dem_reference_elevation_m)||Math.abs(f.dem_reference_elevation_m-city.reference_elevation_m)>1e-6||f.local_axes?.x!=='east'||f.local_axes?.y!=='up'||f.local_axes?.z!=='south'||!vector(point,3))throw Error('Source block does not share the Ontario city datum');
 return [point[0]+f.block_origin_easting_northing_m[0]-city.origin_utm[0],point[1],point[2]+city.origin_utm[1]-f.block_origin_easting_northing_m[1]];
}
export function imagePlane(point,city){
 const d=point.map((n,i)=>n-city.target_local[i]),h=Math.PI/4,p=Math.PI/6;
 return [d[0]*Math.cos(h)-d[2]*Math.sin(h),-d[0]*Math.sin(p)*Math.sin(h)+d[1]*Math.cos(p)-d[2]*Math.sin(p)*Math.cos(h)];
}
export function registeredCropPlacement({camera,sourceFrame,crop,nativePixels,outputPixels},city){
 validateOntarioFrame(city);
 if(camera?.pitch_deg!==city.pitch_deg||camera.heading_deg!==city.heading_deg||!vector(camera.target_local,3)||!Number.isFinite(camera.view_width_m)||camera.view_width_m<=0||!vector(nativePixels,2)||!vector(crop,4)||nativePixels.some(n=>!Number.isInteger(n)||n<=0)||crop.some(n=>!Number.isInteger(n))||crop[0]<0||crop[1]<0||crop[2]>nativePixels[0]||crop[3]>nativePixels[1]||crop[2]<=crop[0]||crop[3]<=crop[1]||!vector(outputPixels,2)||outputPixels[0]!==crop[2]-crop[0]||outputPixels[1]!==crop[3]-crop[1])throw Error('Native crop/camera binding is invalid or resized');
 const centre=imagePlane(sourceToCity(camera.target_local,sourceFrame,city),city),metresPerPixel=camera.view_width_m/nativePixels[0],fullHeight=metresPerPixel*nativePixels[1];
 return [centre[0]-camera.view_width_m/2+crop[0]*metresPerPixel,centre[1]+fullHeight/2-crop[3]*metresPerPixel,centre[0]-camera.view_width_m/2+crop[2]*metresPerPixel,centre[1]+fullHeight/2-crop[1]*metresPerPixel];
}
