"""Private-workspace HotSpot service. Python standard library only."""
import argparse, hashlib, json, math, os, re, secrets, shutil, subprocess, threading, time, uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOTSPOT = Path(os.environ.get('HOTSPOT_ROOT', ROOT.parent / 'HotSpot')).resolve()
RUNS = ROOT / 'runs'
LOCK = threading.Lock()
TOKEN = secrets.token_urlsafe(32)
LEGACY_ARTIFACTS = ('gcc.steady', 'gcc.ttrace')
CUSTOM_INPUTS = ('submitted.experiment.json', 'input.flp', 'input.ptrace')
CUSTOM_OUTPUTS = ('temperatures.steady', 'temperatures.grid.steady')

def run_kind(result):
    return result.get('experiment', {}).get('kind', 'bundled_ev6_gcc')

def file_digest(file):
    data = file.read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

def artifact_manifest(folder, result):
    artifacts = {}
    custom = run_kind(result) == 'custom_2d_steady'
    names = CUSTOM_INPUTS + CUSTOM_OUTPUTS if custom else LEGACY_ARTIFACTS
    for name in names:
        if name == 'gcc.steady' and (result.get('steadyExitCode', 0) != 0 or
                                    ('steadyExitCode' not in result and result.get('status') != 'completed')):
            continue
        if name in CUSTOM_OUTPUTS and result.get('steadyOutputValid') is not True:
            continue
        if name == 'gcc.ttrace' and result.get('status') != 'completed':
            continue
        if name == 'temperatures.grid.steady' and result.get('experiment', {}).get('model_type') != 'grid':
            continue
        file = folder / name
        if name == 'gcc.steady' and not file.is_file():
            file = folder / 'result.steady'  # Runs saved before artifact downloads existed.
        if file.is_file() and file.stat().st_size:
            artifacts[name] = {'filename': name, **file_digest(file),
                               'url': f'/api/runs/{folder.name}/artifacts/{name}'}
    return artifacts

def parse_config(text):
    values = {}
    for number, line in enumerate(text.splitlines(), 1):
        line = line.split('#', 1)[0].strip()
        if not line: continue
        match = re.fullmatch(r'-([A-Za-z0-9_]+)\s+(\S+)', line)
        if not match: raise ValueError(f'Invalid configuration on line {number}')
        key, value = match.groups()
        if key in values: raise ValueError(f'Duplicate parameter: {key}')
        if len(value) > 80: raise ValueError(f'Value too long: {key}')
        values[key] = value
    if not values: raise ValueError('Configuration is empty')
    return values

def validate(text):
    values = parse_config(text)
    defaults = parse_config((HOTSPOT / 'template.config').read_text())
    allowed = set(defaults) | {'material_chip', 'material_sink', 'material_spreader', 'material_interface'}
    enums = {'model_type': {'block','grid'}, 'grid_map_mode': {'avg','min','max','center'}}
    files = {'init_file': '(null)', 'grid_layer_file': '(null)', 'steady_file': '(null)', 'grid_steady_file': '(null)', 'package_config_file': 'package.config'}
    materials = {'material_chip','material_sink','material_spreader','material_interface','coolant_material','wall_material'}
    for key, value in values.items():
        if key not in allowed: raise ValueError(f'Unsupported backend parameter: {key}')
        if key in files:
            if value != files[key]: raise ValueError(f'{key} must be {files[key]}; Studio assigns run input and output files.')
        elif key in enums:
            if value not in enums[key]: raise ValueError(f'Invalid {key}')
        elif key in materials or key == 'l2_label':
            if not re.fullmatch(r'[A-Za-z0-9_]+', value): raise ValueError(f'Invalid {key}')
        else:
            try: number = float(value)
            except ValueError: raise ValueError(f'{key} must be numeric')
            if not math.isfinite(number) or number < 0 or number > 1e12: raise ValueError(f'{key} is out of range')
    v = defaults | values
    for key in ['t_chip','t_interface','t_sink','s_sink','t_spreader','s_spreader','k_chip','k_interface','k_sink','k_spreader','r_convec','sampling_intvl']:
        if float(v[key]) <= 0: raise ValueError(f'{key} must be positive')
    for key in ['grid_rows','grid_cols']:
        n = float(v[key])
        if not n.is_integer() or not 1 <= n <= 128: raise ValueError(f'{key} must be an integer from 1 to 128')
        if v['model_type'] == 'grid' and int(n) & (int(n)-1): raise ValueError(f'{key} must be a power of two for this backend build')
    if v['model_secondary'] == '1' and v['model_type'] != 'grid': raise ValueError('Secondary heat paths require grid mode')
    if v['use_microfluidic_cooling'] != '0': raise ValueError('Microfluidic cooling is not supported by Studio')
    if v['leakage_used'] != '0': raise ValueError('A calibrated leakage model is not configured for this backend')
    if float(v['s_sink']) < float(v['s_spreader']): raise ValueError('Heat sink must be at least as wide as spreader')
    return values

def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError(f'Duplicate JSON key: {key}')
        result[key] = value
    return result

def reject_constant(value):
    raise ValueError(f'Non-finite JSON number: {value}')

def finite_number(value, field, minimum=0, maximum=0.1, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{field} must be a finite number')
    try: finite = math.isfinite(value)
    except OverflowError: finite = False
    if not finite: raise ValueError(f'{field} must be a finite number')
    if value < minimum or value > maximum or (positive and value == 0):
        raise ValueError(f'{field} must be {">" if positive else ">="} {minimum} and <= {maximum}')
    return value

def validate_experiment(experiment, config):
    if not isinstance(experiment, dict): raise ValueError('experiment must be an object')
    if set(experiment) != {'kind', 'floorplan', 'power_w'}:
        raise ValueError('experiment must contain only kind, floorplan, and power_w')
    if experiment['kind'] != 'custom_2d_steady': raise ValueError('experiment.kind must be custom_2d_steady')
    blocks = experiment['floorplan']
    if not isinstance(blocks, list) or not 1 <= len(blocks) <= 128:
        raise ValueError('experiment.floorplan must contain 1 to 128 blocks')
    normalized = []
    names = set()
    for index, block in enumerate(blocks):
        prefix = f'experiment.floorplan[{index}]'
        if not isinstance(block, dict) or set(block) != {'name','x_m','y_m','width_m','height_m'}:
            raise ValueError(f'{prefix} must contain only name, x_m, y_m, width_m, and height_m')
        name = block['name']
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,31}', name):
            raise ValueError(f'{prefix}.name is invalid')
        if name in names: raise ValueError(f'{prefix}.name is duplicated: {name}')
        names.add(name)
        item = {'name': name}
        for key in ('x_m','y_m','width_m','height_m'):
            item[key] = finite_number(block[key], f'{prefix}.{key}', positive=key in ('width_m','height_m'))
        for axis, size in (('x_m','width_m'),('y_m','height_m')):
            if item[axis] + item[size] > 0.1:
                raise ValueError(f'{prefix}.{axis} + {size} must be <= 0.1 m')
        for prior in normalized:
            if (item['x_m'] < prior['x_m'] + prior['width_m'] and prior['x_m'] < item['x_m'] + item['width_m'] and
                item['y_m'] < prior['y_m'] + prior['height_m'] and prior['y_m'] < item['y_m'] + item['height_m']):
                raise ValueError(f'{prefix} overlaps {prior["name"]}')
        normalized.append(item)
    powers = experiment['power_w']
    if not isinstance(powers, dict): raise ValueError('experiment.power_w must be an object')
    missing, extra = sorted(names - powers.keys()), sorted(powers.keys() - names)
    if missing or extra: raise ValueError(f'experiment.power_w names mismatch; missing: {missing}; extra: {extra}')
    ordered_power = {block['name']: finite_number(powers[block['name']], f'experiment.power_w.{block["name"]}', maximum=10000)
                     for block in normalized}
    if sum(ordered_power.values()) > 100000: raise ValueError('experiment.power_w total must be <= 100000 W')
    values = parse_config((HOTSPOT / 'template.config').read_text()) | parse_config(config)
    if float(values['model_secondary']) != 0: raise ValueError('model_secondary must be 0 for custom_2d_steady')
    for dimension, extent in (('width', max(b['x_m'] + b['width_m'] for b in normalized) - min(b['x_m'] for b in normalized)),
                              ('height', max(b['y_m'] + b['height_m'] for b in normalized) - min(b['y_m'] for b in normalized))):
        for field in ('s_spreader','s_sink'):
            if extent > float(values[field]):
                raise ValueError(f'floorplan {dimension} {extent:g} m exceeds {field} {values[field]} m')
    return {'kind':'custom_2d_steady','floorplan':normalized,'power_w':ordered_power}

def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True) + '\n'

def numeric(value):
    return repr(value)

def input_digest(folder, filenames):
    digest = hashlib.sha256()
    for name in filenames:
        data = (folder / name).read_bytes()
        digest.update(name.encode() + b'\0' + str(len(data)).encode() + b'\0' + data)
    return digest.hexdigest()

def parse_steady(file):
    rows = []
    for line in file.read_text().splitlines():
        name, value = line.split()
        kelvin = float(value)
        if not math.isfinite(kelvin): raise ValueError('Non-finite temperature returned')
        rows.append({'name':name,'kelvin':kelvin,'celsius':round(kelvin-273.15,3)})
    return rows

def run_simulation(text, experiment=None):
    validate(text)
    if experiment is not None: experiment = validate_experiment(experiment, text)
    binary = HOTSPOT / 'hotspot'
    if not binary.is_file(): raise ValueError('HotSpot is not built. Run bash hotspot-studio/setup.sh first.')
    if not LOCK.acquire(blocking=False): raise BlockingIOError('A simulation is already running. Try again when it finishes.')
    try:
        RUNS.mkdir(exist_ok=True)
        if len(list(RUNS.iterdir())) >= 100: raise ValueError('Run storage limit reached (100). Archive old run folders before continuing.')
        run_id = uuid.uuid4().hex
        folder = RUNS / run_id
        folder.mkdir()
        (folder / 'submitted.config').write_text(text)
        # Execute only a canonicalized, validated configuration, not arbitrary commands.
        config_items = parse_config(text).items()
        if experiment: config_items = sorted(config_items)
        (folder / 'tuned.config').write_text('\n'.join(f'-{k} {v}' for k,v in config_items)+'\n')
        for name in (['example.materials','package.config'] if experiment else
                     ['ev6.flp','gcc.ptrace','example.materials','package.config']):
            shutil.copyfile(HOTSPOT / 'examples/example1' / name, folder / name)
        if experiment:
            (folder / 'submitted.experiment.json').write_text(canonical_json(experiment))
            (folder / 'input.flp').write_text(''.join(
                f'{b["name"]}\t{numeric(b["width_m"])}\t{numeric(b["height_m"])}\t{numeric(b["x_m"])}\t{numeric(b["y_m"])}\n'
                for b in experiment['floorplan']))
            (folder / 'input.ptrace').write_text(
                '\t'.join(b['name'] for b in experiment['floorplan']) + '\n' +
                '\t'.join(numeric(experiment['power_w'][b['name']]) for b in experiment['floorplan']) + '\n')
        config_values = parse_config((HOTSPOT / 'template.config').read_text()) | parse_config(text)
        summary = {'kind':'custom_2d_steady','block_count':len(experiment['floorplan']),
                   'total_power_w':sum(experiment['power_w'].values()),'model_type':config_values['model_type'],
                   'assumptions':'Bundled example.materials and package.config',
                   'input_sha256':input_digest(folder, ['tuned.config','submitted.experiment.json','example.materials','package.config'])} if experiment else {'kind':'bundled_ev6_gcc'}
        result = {'id':run_id,'created':datetime.now(timezone.utc).isoformat(),'status':'running','rows':[],'log':'','experiment':summary}
        if experiment: result['steadyOutputValid'] = False
        save_result(folder,result)
        args = [str(binary),'-c','tuned.config','-f','input.flp' if experiment else 'ev6.flp',
                '-p','input.ptrace' if experiment else 'gcc.ptrace','-materials_file','example.materials']
        deadline = time.monotonic() + 60
        try:
            phases = [('steady', ['-steady_file','temperatures.steady'] +
                       (['-grid_steady_file','temperatures.grid.steady'] if summary.get('model_type') == 'grid' else []))] if experiment else [
                       ('steady', ['-steady_file','gcc.steady']),
                       ('transient', ['-init_file','gcc.steady','-o','gcc.ttrace'])]
            for phase, options in phases:
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise subprocess.TimeoutExpired(args + options, 60)
                with (folder / 'run.log').open('a') as log:
                    log.write(f'=== {phase} ===\n');log.flush()
                    proc = subprocess.run(args + options,cwd=folder,stdout=log,
                                          stderr=subprocess.STDOUT,timeout=remaining,check=False)
                result[f'{phase}ExitCode'] = proc.returncode
                result['exitCode'] = proc.returncode
                if proc.returncode != 0:
                    result['status'] = 'failed'
                    break
                if phase == 'steady':
                    result['rows'] = parse_steady(folder / ('temperatures.steady' if experiment else 'gcc.steady'))
                    if experiment:
                        missing = set(experiment['power_w']) - {row['name'] for row in result['rows']}
                        if missing: raise ValueError(f'Steady output missing blocks: {sorted(missing)}')
                        if summary['model_type'] == 'grid':
                            grid_file = folder / 'temperatures.grid.steady'
                            if not grid_file.is_file() or not grid_file.stat().st_size:
                                raise ValueError('Grid steady output is missing or empty')
                        result['steadyOutputValid'] = True
            else:
                result['status'] = 'completed'
        except subprocess.TimeoutExpired:
            result['status']='timed_out'; result['log']='Simulation exceeded the 60-second limit.\n'+((folder/'run.log').read_text(errors='replace') if (folder/'run.log').exists() else '')[-64000:]
        except Exception as exc:
            result['status']='failed';result['log']=str(exc)
            if experiment: result['rows'] = []
        if not result['log'] and (folder/'run.log').exists():
            result['log'] = (folder / 'run.log').read_text(errors='replace')[-64000:]
        result['artifacts'] = artifact_manifest(folder,result)
        save_result(folder,result)
        return result
    finally: LOCK.release()

def save_result(folder,result):
    tmp=folder/'result.tmp';tmp.write_text(json.dumps(result));tmp.replace(folder/'result.json')

class Handler(BaseHTTPRequestHandler):
    def send(self,status,body,kind='application/json',download=None):
        data=json.dumps(body).encode() if kind=='application/json' else body
        self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
        if download:self.send_header('Content-Disposition',f'attachment; filename="{download}"')
        self.end_headers();self.wfile.write(data)
    def do_GET(self):
        path=self.path.split('?',1)[0]
        if path=='/api/status': return self.send(200,{'ready':(HOTSPOT/'hotspot').is_file(),'token':TOKEN,'solver':'off','experiment':'EV6 · gcc power trace · steady state'})
        if path=='/api/runs':
            results=[]
            for file in sorted(RUNS.glob('*/result.json'),key=lambda p:p.stat().st_mtime,reverse=True):
                result=json.loads(file.read_text());results.append({**{k:result[k] for k in ['id','created','status']},
                    'experiment': {'kind': run_kind(result)}})
            return self.send(200,results)
        artifact=re.fullmatch(r'/api/runs/([a-f0-9]{32})/artifacts/([A-Za-z0-9_.]+)',path)
        if artifact:
            folder=RUNS/artifact[1]
            result_file=folder/'result.json'
            if not result_file.is_file():return self.send(404,{'error':'Run not found'})
            result=json.loads(result_file.read_text())
            if artifact[2] not in artifact_manifest(folder,result):
                return self.send(404,{'error':'Artifact not found'})
            file=folder/artifact[2]
            if artifact[2]=='gcc.steady' and not file.is_file():file=folder/'result.steady'
            return self.send(200,file.read_bytes(),'application/octet-stream',artifact[2])
        match=re.fullmatch(r'/api/runs/([a-f0-9]{32})(/config)?',path)
        if match:
            file=RUNS/match[1]/('submitted.config' if match[2] else 'result.json')
            if file.is_file():
                if match[2]:return self.send(200,file.read_bytes(),'text/plain; charset=utf-8')
                result=json.loads(file.read_text());result['artifacts']=artifact_manifest(file.parent,result)
                return self.send(200,result)
            return self.send(404,{'error':'Run not found'})
        assets={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.mjs':'app.mjs','/model.mjs':'model.mjs','/run.mjs':'run.mjs','/custom.mjs':'custom.mjs','/example.config':'example.config'}
        if path not in assets:return self.send(404,{'error':'Not found'})
        file=ROOT/'dist'/assets[path]
        kind={'.html':'text/html; charset=utf-8','.css':'text/css','.mjs':'text/javascript','.config':'text/plain'}[file.suffix]
        return self.send(200,file.read_bytes(),kind)
    def do_POST(self):
        if self.path!='/api/runs':return self.send(404,{'error':'Not found'})
        if self.headers.get('X-Studio-Token')!=TOKEN:return self.send(403,{'error':'Refresh Studio before submitting a run'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=100000:raise ValueError('Run request must be 100 KB or smaller')
            body=json.loads(self.rfile.read(length), object_pairs_hook=json_object, parse_constant=reject_constant)
            if not isinstance(body,dict) or not isinstance(body.get('config'),str):raise ValueError('config must be text')
            if set(body) - {'config','experiment'}: raise ValueError(f'Unknown request fields: {sorted(set(body)-{"config","experiment"})}')
            result=run_simulation(body['config'],body['experiment'] if 'experiment' in body else None)
            return self.send(201,result)
        except BlockingIOError as exc:return self.send(409,{'error':str(exc)})
        except (ValueError,UnicodeError) as exc:return self.send(400,{'error':str(exc)})
        except Exception:return self.send(500,{'error':'Backend error; inspect the server log'})

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--port',type=int,default=8000);p.add_argument('--host',default='127.0.0.1');a=p.parse_args()
    # Saved unfinished jobs cannot still be running after a service restart.
    for file in RUNS.glob('*/result.json'):
        result=json.loads(file.read_text())
        if result['status']=='running':result.update(status='interrupted',log='Backend restarted before this run completed.');save_result(file.parent,result)
    print(f'HotSpot Studio: http://{a.host}:{a.port}',flush=True)
    ThreadingHTTPServer((a.host,a.port),Handler).serve_forever()
