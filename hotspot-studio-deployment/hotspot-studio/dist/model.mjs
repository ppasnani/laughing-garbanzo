export const groups = [
 ['Environment', [['ambient','Ambient temperature','°C',1,-273.15],['init_temp','Initial temperature','°C',1,-273.15],['sampling_intvl','Power trace interval','ms',1000],['model_type','Thermal model',['block','grid']]]],
 ['Silicon & interface', [['t_chip','Chip thickness','µm',1e6],['k_chip','Chip conductivity','W/(m·K)'],['p_chip','Chip heat capacity','J/(m³·K)'],['t_interface','Interface thickness','µm',1e6],['k_interface','Interface conductivity','W/(m·K)'],['p_interface','Interface heat capacity','J/(m³·K)']]],
 ['Cooling package', [['s_sink','Heat sink side','mm',1000],['t_sink','Heat sink thickness','mm',1000],['k_sink','Heat sink conductivity','W/(m·K)'],['r_convec','Convection resistance','K/W'],['c_convec','Convection capacitance','J/K'],['s_spreader','Spreader side','mm',1000],['t_spreader','Spreader thickness','mm',1000],['k_spreader','Spreader conductivity','W/(m·K)']]],
 ['Grid & model options', [['grid_rows','Grid rows','cells'],['grid_cols','Grid columns','cells'],['grid_map_mode','Block temperature mapping',['avg','min','max','center']],['model_secondary','Secondary heat paths',['0','1']],['use_microfluidic_cooling','Microfluidic cooling',['0','1']],['package_model_used','Detailed package model',['0','1']]]]
];
export const fields=groups.flatMap(g=>g[1]);
export function parse(text){
 const values={}, duplicates=[], malformed=[];
 text.split(/\r?\n/).forEach((line,i)=>{const body=line.split('#')[0].trim();if(!body)return;const m=body.match(/^-([\w]+)\s+(\S+)\s*$/);if(!m){malformed.push(i+1);return;}if(m[1] in values)duplicates.push(m[1]);else values[m[1]]=m[2];});
 return {values,duplicates,malformed};
}
export function serialize(text,changes){
 const seen=new Set();const lines=text.split(/\r?\n/).map(line=>{const m=line.match(/^(\s*)-([\w]+)(\s+)(\S+)(.*)$/);if(!m||!(m[2] in changes))return line;seen.add(m[2]);return `${m[1]}-${m[2]}${m[3]}${changes[m[2]]}${m[5]}`;});
 for(const [key,value] of Object.entries(changes))if(!seen.has(key))lines.push(`-${key} ${value}`);
 return lines.join('\n');
}
export const display=(value,f)=>Number(value)*(f[3]??1)+(f[4]??0);
export const native=(value,f)=>String(Number(((Number(value)-(f[4]??0))/(f[3]??1)).toPrecision(12)));
export function validate(text,solver='unknown'){
 const {values:v,duplicates,malformed}=parse(text), issues=[];
 const add=(level,message)=>issues.push({level,message});
 duplicates.forEach(k=>add('error',`Duplicate setting: ${k}. Remove the duplicate in the source.`));
 malformed.forEach(n=>add('error',`Line ${n}: expected -parameter value.`));
 if(!Object.keys(v).length)add('error','No configuration settings found.');
 for(const f of fields){const [k,label,unit]=f;if(!(k in v))continue;if(Array.isArray(unit)){if(!unit.includes(v[k]))add('error',`${label}: unsupported value “${v[k]}”.`);}else if(!Number.isFinite(Number(v[k]))||Number(v[k])<0||(!['ambient','init_temp'].includes(k)&&Number(v[k])===0))add('error',`${label} must be a finite ${['ambient','init_temp'].includes(k)?'nonnegative':'positive'} number in native units.`);}
 for(const k of ['grid_rows','grid_cols'])if(k in v&&!Number.isInteger(Number(v[k])))add('error',`${k} must be an integer.`);
 if(v.model_secondary==='1'&&v.model_type!=='grid')add('error','Secondary heat paths require grid mode.');
 if(v.use_microfluidic_cooling==='1'){
  if(v.model_type!=='grid')add('error','Microfluidic cooling requires grid mode.');
  if(v.model_secondary==='1')add('error','Microfluidic cooling cannot be combined with secondary heat paths.');
  if(solver==='off')add('error','Microfluidic cooling requires a SuperLU build.');
  if(solver==='unknown')add('warning','Confirm HotSpot was built with SuperLU before using microfluidic cooling.');
  add('warning','Verify the layer file, channel geometry, coolant properties and boundary conditions; this editor does not validate microchannel files.');
 }
 if(v.model_type==='grid')for(const k of ['grid_rows','grid_cols']){const n=Number(v[k]);if(n>0&&Number.isInteger(n)&&!Number.isInteger(Math.log2(n)))add(solver==='off'?'error':'warning',`${k} is not a power of two. This requires SuperLU.`);}
 if(Number(v.s_sink)<Number(v.s_spreader))add('error','Heat sink side must be at least as large as the spreader side.');
 for(const part of ['chip','sink','spreader','interface'])if(v[`material_${part}`])add('warning',`${v[`material_${part}`]} overrides numeric ${part} material properties. Edit the materials file to change the effective values.`);
 if(v.grid_layer_file&&v.grid_layer_file!=='(null)')add('warning','Layer file is active: chip and interface settings may be overridden. Layer file contents are not checked.');
 if(v.package_model_used==='1')add('warning','Detailed package model is active; review package.config for effective cooling settings.');
 if(v.leakage_used==='1')add('warning','Leakage requires a suitable leakage model; transient leakage iteration is unsupported in this release.');
 add('info','Configuration checks only. Referenced files, floorplan geometry, power traces and physical accuracy are not verified. Command-line flags can override these settings.');
 return issues;
}
