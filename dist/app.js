const state = { images: [], selected: new Set(), radius: 12, timeLagMinutes: 10, showOnlySelected: false, markers: new Map() };
const map = L.map('map', { zoomControl: false }).setView([39.2, -98.5], 4);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '© OpenStreetMap contributors' }).addTo(map);
const markerLayer = L.layerGroup().addTo(map), selectionLayer = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({ position: 'topright', draw: { marker:false, circle:false, circlemarker:false, polyline:false, polygon:{allowIntersection:false, shapeOptions:{color:'#0e5a45'}}, rectangle:{shapeOptions:{color:'#0e5a45'}} }, edit:{ featureGroup: selectionLayer, edit:false, remove:true } }));
map.on(L.Draw.Event.CREATED, e => { selectionLayer.clearLayers(); selectionLayer.addLayer(e.layer); selectByShape(e.layer); });

const $ = id => document.getElementById(id);
$('radius').addEventListener('input', e => { state.radius = +e.target.value; $('radiusOut').value = `${state.radius} m`; refresh(); });
$('timeLag').addEventListener('input', e => { state.timeLagMinutes = +e.target.value; $('lagOut').value = `${state.timeLagMinutes} min`; refresh(); });
$('imageInput').addEventListener('change', e => ingest([...e.target.files]));
$('folderInput').addEventListener('change', e => { ingest([...e.target.files]); e.target.value=''; });
if (window.flightSelectDesktop) {
  document.body.classList.add('desktop'); $('desktopImport').hidden=false;
  $('nativeFolders').onclick = () => importFromDesktop('folders');
  $('nativeFiles').onclick = () => importFromDesktop('files');
}
$('clearBtn').onclick = () => { state.images.forEach(x=>{if(x.thumbnailUrl)URL.revokeObjectURL(x.thumbnailUrl)}); state.images = []; state.selected.clear(); selectionLayer.clearLayers(); refresh(); };
$('excludeRepeats').onclick = () => { state.images.forEach(x => { if (state.selected.has(x.id)) x.excluded = true; }); state.selected.clear(); refresh(); };
$('selectOldest').onclick = () => selectMatchesByAge('oldest');
$('selectNewest').onclick = () => selectMatchesByAge('newest');
$('removeSelected').onclick = () => { state.images.forEach(x => { if (state.selected.has(x.id)) x.excluded = true; }); state.selected.clear(); refresh(); };
$('keepSelected').onclick = () => { state.images.forEach(x => { if (state.selected.has(x.id)) x.excluded = false; }); refresh(); };
$('showSelected').onclick = () => { state.showOnlySelected = !state.showOnlySelected; $('showSelected').textContent = state.showOnlySelected ? 'Show all' : 'Show selected'; renderList(); };
$('copyFolder').onclick = copyToFolder; $('exportManifest').onclick = exportManifest;
$('helpBtn').onclick = () => $('helpDialog').showModal(); document.querySelector('.close-dialog').onclick = () => $('helpDialog').close();
const dz = $('dropzone'); ['dragenter','dragover'].forEach(t => dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('drag')})); ['dragleave','drop'].forEach(t => dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('drag')})); dz.addEventListener('drop',async e=>{const files=await filesFromDrop(e.dataTransfer);ingest(files)});

async function filesFromDrop(dataTransfer) {
  const entries=[...dataTransfer.items].map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].filter(f=>/jpe?g$/i.test(f.name));
  const files=[]; await Promise.all(entries.map(entry=>readEntry(entry,files))); return files.filter(f=>/jpe?g$/i.test(f.name));
}
async function readEntry(entry, files) {
  if (entry.isFile) return new Promise(resolve=>entry.file(file=>{files.push(file);resolve()},resolve));
  if (!entry.isDirectory) return;
  const reader=entry.createReader(); let batch;
  do { batch=await new Promise(resolve=>reader.readEntries(resolve,()=>resolve([]))); await Promise.all(batch.map(child=>readEntry(child,files))); } while(batch.length);
}

async function ingest(files) {
  if (!files.length) return;
  dz.querySelector('strong').textContent = `Reading ${files.length} image${files.length === 1 ? '' : 's'}…`;
  const results = await Promise.all(files.map(async file => ({ file, gps: await readGPS(file) })));
  let found = 0;
  results.forEach(({file,gps}) => { if (!gps) return; found++; state.images.push({ id: crypto.randomUUID(), file, name:file.name, sourcePath:file._sourcePath || '', relativePath:file._relativePath || file.webkitRelativePath || file.name, lat:gps.lat, lng:gps.lng, capturedAt:gps.capturedAt, capturedMs:exifTimeMs(gps.capturedAt), dataset:'unclassified', excluded:false, repeat:false }); });
  dz.querySelector('strong').textContent = found ? `${found} geotagged image${found===1?'':'s'} added` : 'No EXIF GPS found';
  setTimeout(()=>dz.querySelector('strong').textContent='Import image set', 1800);
  if (state.images.length) map.fitBounds(L.latLngBounds(state.images.map(x=>[x.lat,x.lng])).pad(.15));
  refresh();
}
async function importFromDesktop(type) {
  const picker=type==='folders' ? window.flightSelectDesktop.pickFolders : window.flightSelectDesktop.pickFiles;
  const entries=await picker(); if(!entries.length)return;
  dz.querySelector('strong').textContent=`Reading ${entries.length} image${entries.length===1?'':'s'}…`;
  const loaded=await window.flightSelectDesktop.readImages(entries);
  const files=loaded.map(entry=>{const file=new File([entry.bytes],entry.name,{type:'image/jpeg'});file._sourcePath=entry.path;file._relativePath=entry.relativePath;return file;});
  await ingest(files);
}

function findRepeats() {
  state.images.forEach(x=>x.repeat=false);
  for (let i=0;i<state.images.length;i++) for (let j=i+1;j<state.images.length;j++) {
    const a=state.images[i], b=state.images[j];
    if (!a.capturedMs || !b.capturedMs || Math.abs(a.capturedMs-b.capturedMs)<state.timeLagMinutes*60000 || distance(a,b)>state.radius) continue;
    a.repeat=b.repeat=true;
  }
}
function selectMatchesByAge(choice) {
  const chosen=state.images.filter(x=>state.selected.has(x.id));
  if (chosen.length<2) return alert('Select at least two candidate images with a map shape first.');
  const links=new Map(chosen.map(x=>[x.id,new Set()]));
  for(let i=0;i<chosen.length;i++) for(let j=i+1;j<chosen.length;j++) {
    const a=chosen[i],b=chosen[j];
    if(!a.capturedMs||!b.capturedMs||Math.abs(a.capturedMs-b.capturedMs)<state.timeLagMinutes*60000||distance(a,b)>state.radius)continue;
    links.get(a.id).add(b.id); links.get(b.id).add(a.id);
  }
  const visited=new Set(), result=new Set();
  for(const image of chosen){
    if(visited.has(image.id)||!links.get(image.id).size)continue;
    const group=[], queue=[image.id]; visited.add(image.id);
    while(queue.length){const id=queue.pop(), item=chosen.find(x=>x.id===id);group.push(item);for(const next of links.get(id)){if(!visited.has(next)){visited.add(next);queue.push(next)}}}
    const target=group.reduce((best,item)=>choice==='oldest' ? (item.capturedMs<best.capturedMs?item:best) : (item.capturedMs>best.capturedMs?item:best));
    result.add(target.id);
  }
  if(!result.size) return alert('No time-separated location matches were found in this selection. Try a larger shape or adjust the radius/time gap.');
  state.selected=result;
  refresh();
}
function distance(a,b) { return L.latLng(a.lat,a.lng).distanceTo(L.latLng(b.lat,b.lng)); }
function refresh() { findRepeats(); renderMap(); renderList(); renderSummary(); }
function renderMap() {
  markerLayer.clearLayers(); state.markers.clear();
  state.images.forEach(img => {
    const selected = state.selected.has(img.id);
    const color = selected ? '#d7f55a' : img.excluded ? '#9fa8a3' : img.repeat ? '#e98045' : img.dataset === 'refly' ? '#4d8edf' : img.dataset === 'original' ? '#0e5a45' : '#7c8b84';
    const marker = L.circleMarker([img.lat,img.lng], {radius:selected?7:5, color:selected?'#15221e':'#fff', weight:selected?2:1, fillColor:color, fillOpacity:img.excluded?.3:.92});
    marker.bindTooltip(tooltipContent(img), {direction:'top', offset:[0,-6], opacity:1, className:'flight-tooltip'});
    marker.on('tooltipopen', async()=>{const thumb=await thumbnailFor(img);marker.setTooltipContent(tooltipContent(img,thumb));});
    marker.on('click',()=>{ state.selected.has(img.id) ? state.selected.delete(img.id) : state.selected.add(img.id); refresh(); }); marker.addTo(markerLayer); state.markers.set(img.id,marker);
  });
}
function renderList() {
  const list = $('imageList'); const shown = state.images.filter(x=>!state.showOnlySelected || state.selected.has(x.id));
  if (!shown.length) { list.innerHTML='<p class="empty-list">Import geotagged JPGs to begin.</p>'; return; }
  list.innerHTML = shown.map(x=>`<label class="image-row"><input type="checkbox" data-id="${x.id}" ${state.selected.has(x.id)?'checked':''}><span class="name" title="${safe(x.name)}">${safe(x.name)}</span><span class="badge ${x.dataset}">${x.dataset==='refly'?'REPLACE':x.dataset==='original'?'EARLIER':'CAPTURE'}</span>${x.repeat?'<span class="badge repeat">MATCH</span>':''}${x.excluded?'<span class="badge">OUT</span>':''}</label>`).join('');
  list.querySelectorAll('input').forEach(el=>el.onchange=()=>{ el.checked?state.selected.add(el.dataset.id):state.selected.delete(el.dataset.id); refresh(); });
}
function renderSummary() { const kept=state.images.filter(x=>!x.excluded), repeats=state.images.filter(x=>x.repeat).length; $('totalCount').textContent=state.images.length; $('repeatCount').textContent=repeats; $('queueCount').textContent=`${kept.length} image${kept.length===1?'':'s'}`; $('originalKeep').textContent=kept.filter(x=>x.dataset==='original').length; $('reflyKeep').textContent=kept.filter(x=>x.dataset==='refly').length; }
function labelFor(img) { return img.dataset==='refly' ? 'Later replacement' : img.dataset==='original' ? 'Earlier original' : 'Unclassified capture'; }
function tooltipContent(img, thumbnailUrl='') { return `<div class="thumb-card">${thumbnailUrl?`<img src="${thumbnailUrl}" alt="Preview of ${safe(img.name)}">`:'<div class="thumb-placeholder">Loading preview…</div>'}<div class="thumb-meta"><b>${safe(img.name)}</b><span>${img.capturedAt||'No capture time'}</span><span>${img.lat.toFixed(6)}, ${img.lng.toFixed(6)}</span></div></div>`; }
async function thumbnailFor(img) {
  if(img.thumbnailUrl)return img.thumbnailUrl;
  try {
    const bitmap=await createImageBitmap(img.file), scale=Math.min(240/bitmap.width,160/bitmap.height,1), canvas=document.createElement('canvas');
    canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.76)); img.thumbnailUrl=URL.createObjectURL(blob||img.file);
  } catch { img.thumbnailUrl=URL.createObjectURL(img.file); }
  return img.thumbnailUrl;
}
function selectByShape(layer) {
  let ring; if (layer instanceof L.Rectangle) ring=layer.getLatLngs()[0]; else ring=layer.getLatLngs()[0];
  state.selected.clear(); state.images.forEach(img=>{if(pointInPolygon([img.lat,img.lng],ring.map(p=>[p.lat,p.lng])))state.selected.add(img.id)}); refresh();
}
function pointInPolygon(p, vs) { let inside=false; for(let i=0,j=vs.length-1;i<vs.length;j=i++){const [yi,xi]=vs[i],[yj,xj]=vs[j]; if(((xi>p[1]) !== (xj>p[1])) && p[0] < (yj-yi)*(p[1]-xi)/(xj-xi)+yi)inside=!inside;} return inside; }
async function copyToFolder() {
  const imgs=state.images.filter(x=>!x.excluded), status=$('copyStatus');
  if(!imgs.length)return alert('There are no images in the export queue.');
  if(window.flightSelectDesktop){
    const outputFolder=await window.flightSelectDesktop.chooseOutputFolder(); if(!outputFolder)return;
    status.textContent=`Copying ${imgs.length} image${imgs.length===1?'':'s'}…`;
    try { const result=await window.flightSelectDesktop.copyImages({outputFolder,images:imgs.map(x=>({sourcePath:x.sourcePath,relativePath:x.relativePath,name:x.name}))}); status.textContent=`Copied ${result.copied} image${result.copied===1?'':'s'} to the selected folder.`; } catch(error) { console.error(error); status.textContent='Copy failed. Check the destination folder and try again.'; }
    return;
  }
  if(!window.showDirectoryPicker){alert('Copying directly to a folder requires Chrome or Edge on localhost. Use the local server command, then open http://localhost:8080 in Chrome or Edge.');return;}
  try {
    const root=await window.showDirectoryPicker({mode:'readwrite'}); let copied=0;
    status.textContent=`Preparing ${imgs.length} image${imgs.length===1?'':'s'}…`;
    for(const img of imgs){
      status.textContent=`Copying ${copied+1} of ${imgs.length}: ${img.name}`;
      const destination=await outputFileHandle(root,img.relativePath||img.name);
      const writer=await destination.createWritable(); await writer.write(img.file); await writer.close(); copied++;
    }
    status.textContent=`Copied ${copied} image${copied===1?'':'s'} to ${root.name}.`;
  } catch(error) {
    if(error.name==='AbortError'){status.textContent='Copy cancelled.';} else {console.error(error);status.textContent='Copy failed. Check folder permissions and try again.';}
  }
}
async function outputFileHandle(root,path) {
  const parts=path.replaceAll('\\','/').split('/').filter(Boolean).map(x=>x.replace(/[<>:"|?*]/g,'_'));
  const filename=parts.pop()||'image.jpg'; let folder=root;
  for(const part of parts) folder=await folder.getDirectoryHandle(part,{create:true});
  return folder.getFileHandle(filename,{create:true});
}
function exportManifest() { const rows=[['filename','dataset','latitude','longitude','status','repeat_candidate'],...state.images.map(x=>[x.name,x.dataset,x.lat,x.lng,x.excluded?'excluded':'included',x.repeat?'yes':'no'])]; const csv=rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(',')).join('\n'); download(new Blob([csv],{type:'text/csv'}),'flight-select-manifest.csv'); }
function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function safe(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}

async function readGPS(file) { try { const b=await file.arrayBuffer(), v=new DataView(b); if(v.getUint16(0)!==0xffd8)return null; let p=2; while(p<v.byteLength){if(v.getUint8(p)!==0xff){p++;continue} const mark=v.getUint8(p+1), len=v.getUint16(p+2); if(mark===0xe1 && String.fromCharCode(...new Uint8Array(b,p+4,4))==='Exif'){return gpsFromExif(v,p+10)} p+=2+len;} }catch(e){console.warn('EXIF read failed',file.name,e)} return null; }
function gpsFromExif(v,start) { if(String.fromCharCode(...new Uint8Array(v.buffer,start,4))!=='II*\x00' && String.fromCharCode(...new Uint8Array(v.buffer,start,4))!=='MM\x00*')return null; const le=v.getUint8(start)===0x49, u16=o=>v.getUint16(o,le),u32=o=>v.getUint32(o,le); const ifd=start+u32(start+4); let gpsOff,exifOff; const n=u16(ifd); for(let i=0;i<n;i++){let o=ifd+2+i*12,tag=u16(o);if(tag===0x8825)gpsOff=u32(o+8);if(tag===0x8769)exifOff=u32(o+8)} if(!gpsOff)return null; const g=start+gpsOff, gn=u16(g); let lat,lon,latRef,lonRef; for(let i=0;i<gn;i++){let o=g+2+i*12,tag=u16(o),val=u32(o+8); if(tag===1)latRef=String.fromCharCode(v.getUint8(o+8)); if(tag===3)lonRef=String.fromCharCode(v.getUint8(o+8)); if(tag===2)lat=dms(v,start+val,u32(o+4),le); if(tag===4)lon=dms(v,start+val,u32(o+4),le);} if(lat==null||lon==null)return null; let capturedAt=''; if(exifOff){const e=start+exifOff,en=u16(e);for(let i=0;i<en;i++){let o=e+2+i*12;if(u16(o)===0x9003){const count=u32(o+4),pos=count<=4?o+8:start+u32(o+8);capturedAt=String.fromCharCode(...new Uint8Array(v.buffer,pos,count)).replace(/\0/g,'');}}} return {lat:latRef==='S'?-lat:lat,lng:lonRef==='W'?-lon:lon,capturedAt}; }
function dms(v,o,count,le){if(count<3)return null;const r=i=>v.getUint32(o+i*8,le)/v.getUint32(o+i*8+4,le);return r(0)+r(1)/60+r(2)/3600;}
function exifTimeMs(value){const m=/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(value||'');return m?new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]).getTime():null;}
