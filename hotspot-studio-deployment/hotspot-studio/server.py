"""Private-workspace HotSpot service. Python standard library only."""
import argparse, json, math, os, re, secrets, shutil, subprocess, threading, time, uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOTSPOT = Path(os.environ.get('HOTSPOT_ROOT', ROOT.parent / 'HotSpot')).resolve()
RUNS = ROOT / 'runs'
LOCK = threading.Lock()
TOKEN = secrets.token_urlsafe(32)
ARTIFACTS = {'gcc.steady': 'gcc.steady', 'gcc.ttrace': 'gcc.ttrace'}

def artifact_manifest(folder, result):
    artifacts = {}
    for name, filename in ARTIFACTS.items():
        if name == 'gcc.steady' and (result.get('steadyExitCode', 0) != 0 or
                                    ('steadyExitCode' not in result and result.get('status') != 'completed')):
            continue
        if name == 'gcc.ttrace' and result.get('status') != 'completed':
            continue
        file = folder / filename
        if name == 'gcc.steady' and not file.is_file():
            file = folder / 'result.steady'  # Runs saved before artifact downloads existed.
        if file.is_file() and file.stat().st_size:
            artifacts[name] = {'filename': name, 'bytes': file.stat().st_size,
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
            if value != files[key]: raise ValueError(f'{key} must be {files[key]} for the bundled EV6 experiment. Other input files are not yet supported.')
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
    if v['use_microfluidic_cooling'] != '0': raise ValueError('This backend supports the bundled EV6 experiment without microfluidic cooling')
    if v['leakage_used'] != '0': raise ValueError('A calibrated leakage model is not configured for this backend')
    if float(v['s_sink']) < float(v['s_spreader']): raise ValueError('Heat sink must be at least as wide as spreader')
    return values

def run_simulation(text):
    validate(text)
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
        (folder / 'tuned.config').write_text('\n'.join(f'-{k} {v}' for k,v in parse_config(text).items())+'\n')
        for name in ['ev6.flp','gcc.ptrace','example.materials','package.config']:
            shutil.copyfile(HOTSPOT / 'examples/example1' / name, folder / name)
        result = {'id':run_id,'created':datetime.now(timezone.utc).isoformat(),'status':'running','rows':[],'log':''}
        save_result(folder,result)
        args = [str(binary),'-c','tuned.config','-f','ev6.flp','-p','gcc.ptrace','-materials_file','example.materials']
        deadline = time.monotonic() + 60
        try:
            for phase, options in [('steady', ['-steady_file','gcc.steady']),
                                   ('transient', ['-init_file','gcc.steady','-o','gcc.ttrace'])]:
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
                    for line in (folder / 'gcc.steady').read_text().splitlines():
                        name, value = line.split()
                        kelvin = float(value)
                        if not math.isfinite(kelvin): raise ValueError('Non-finite temperature returned')
                        result['rows'].append({'name':name,'kelvin':kelvin,'celsius':round(kelvin-273.15,3)})
            else:
                result['status'] = 'completed'
        except subprocess.TimeoutExpired:
            result['status']='timed_out'; result['log']='Simulation exceeded the 60-second limit.\n'+((folder/'run.log').read_text(errors='replace') if (folder/'run.log').exists() else '')[-64000:]
        except Exception as exc:
            result['status']='failed';result['log']=str(exc)
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
                result=json.loads(file.read_text());results.append({k:result[k] for k in ['id','created','status']})
            return self.send(200,results)
        artifact=re.fullmatch(r'/api/runs/([a-f0-9]{32})/artifacts/(gcc\.(?:steady|ttrace))',path)
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
        assets={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.mjs':'app.mjs','/model.mjs':'model.mjs','/run.mjs':'run.mjs','/example.config':'example.config'}
        if path not in assets:return self.send(404,{'error':'Not found'})
        file=ROOT/'dist'/assets[path]
        kind={'.html':'text/html; charset=utf-8','.css':'text/css','.mjs':'text/javascript','.config':'text/plain'}[file.suffix]
        return self.send(200,file.read_bytes(),kind)
    def do_POST(self):
        if self.path!='/api/runs':return self.send(404,{'error':'Not found'})
        if self.headers.get('X-Studio-Token')!=TOKEN:return self.send(403,{'error':'Refresh Studio before submitting a run'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=100000:raise ValueError('Configuration request must be smaller than 100 KB')
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict) or not isinstance(body.get('config'),str):raise ValueError('config must be text')
            result=run_simulation(body['config'])
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
