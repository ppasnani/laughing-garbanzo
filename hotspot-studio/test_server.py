import importlib.util, io, json, os, re, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('studio',Path(__file__).with_name('server.py'))
studio=importlib.util.module_from_spec(spec);spec.loader.exec_module(studio)
class BackendTests(unittest.TestCase):
    def setUp(self):
        self.config=(studio.ROOT/'dist/example.config').read_text()
        self.experiment={'kind':'custom_2d_steady','floorplan':[
            {'name':'core0','x_m':0,'y_m':0,'width_m':0.005,'height_m':0.005},
            {'name':'core1','x_m':0.005,'y_m':0,'width_m':0.005,'height_m':0.005}],
            'power_w':{'core0':8,'core1':6}}
    def compatible_binary(self):
        binary=studio.HOTSPOT/'hotspot'
        if not binary.exists():self.skipTest('HotSpot binary unavailable')
        if sys.platform=='darwin' and binary.read_bytes()[:4]==b'\x7fELF':
            self.skipTest('Bundled HotSpot binary targets Linux; run integration on Codespace')
    def grid_config(self):
        config=re.sub(r'(-model_type\s+)block',r'\1grid',self.config)
        config=re.sub(r'(-grid_(?:rows|cols)\s+)39',r'\g<1>32',config)
        return config
    def test_default(self): studio.validate(self.config)
    def test_reject_files_and_commands(self):
        for flag in ['-d /tmp/leak','-p /etc/passwd','-materials_file /etc/passwd','-grid_layer_file ../../etc/passwd']:
            with self.subTest(flag=flag),self.assertRaises(ValueError):studio.validate(self.config+'\n'+flag)
    def test_reject_invalid(self):
        for config in ['-ambient NaN','-t_chip -1','-grid_rows 129','-model_type grid\n-grid_rows 39','-model_secondary 1\n-model_type block','-use_microfluidic_cooling 1']:
            with self.subTest(config=config),self.assertRaises(ValueError):studio.validate(config)
    def test_artifact_downloads(self):
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            run_id='a'*32;folder=studio.RUNS/run_id;folder.mkdir()
            (folder/'gcc.steady').write_bytes(b'Core 320.0\n')
            (folder/'gcc.ttrace').write_bytes(b'partial trace')
            (folder/'result.json').write_text(json.dumps({'id':run_id,'status':'failed','steadyExitCode':0,'transientExitCode':1,'rows':[],'log':''}))
            try:
                handler=object.__new__(studio.Handler)
                handler.send=lambda status,body,kind='application/json',download=None:(status,body,kind,download)
                handler.path=f'/api/runs/{run_id}'
                status,body,_,_=studio.Handler.do_GET(handler)
                self.assertEqual(status,200)
                self.assertIn('gcc.steady',body['artifacts'])
                self.assertNotIn('gcc.ttrace',body['artifacts'])
                handler.path=f'/api/runs/{run_id}/artifacts/gcc.steady'
                status,body,kind,download=studio.Handler.do_GET(handler)
                self.assertEqual((status,body,kind,download),(200,b'Core 320.0\n','application/octet-stream','gcc.steady'))
                handler.path=f'/api/runs/{run_id}/artifacts/gcc.ttrace'
                status,_,_,_=studio.Handler.do_GET(handler)
                self.assertEqual(status,404)
            finally:
                studio.RUNS=old
    def test_custom_validation(self):
        import copy
        cases=[]
        def changed(update):
            value=copy.deepcopy(self.experiment);update(value);cases.append(value)
        changed(lambda e:e['power_w'].pop('core1'))
        changed(lambda e:e['power_w'].update(extra=2))
        changed(lambda e:e['floorplan'][1].update(name='core0'))
        changed(lambda e:e['floorplan'][1].update(x_m=0.004))
        changed(lambda e:e['floorplan'][0].update(width_m=-1))
        changed(lambda e:e['floorplan'][0].update(width_m=float('nan')))
        changed(lambda e:e['floorplan'][0].update(x_m=True))
        changed(lambda e:e['floorplan'][0].update(x_m=10**400))
        changed(lambda e:e['power_w'].update(core0=-1))
        changed(lambda e:e['power_w'].update(core0=float('inf')))
        changed(lambda e:e['power_w'].update(core0=True))
        changed(lambda e:e.update(output='bad'))
        changed(lambda e:e['floorplan'][0].update(filename='bad'))
        for experiment in cases:
            with self.subTest(experiment=experiment),self.assertRaises(ValueError):
                studio.validate_experiment(experiment,self.config)
        with self.assertRaisesRegex(ValueError,'s_spreader'):
            wide=copy.deepcopy(self.experiment);wide['floorplan'][1]['width_m']=0.04
            studio.validate_experiment(wide,self.config)
        with self.assertRaisesRegex(ValueError,'model_secondary'):
            studio.validate_experiment(self.experiment,self.config.replace('-model_secondary\t0','-model_secondary\t1'))
        self.assertEqual(studio.validate_experiment(self.experiment,self.config),self.experiment)
    def post(self,raw):
        handler=object.__new__(studio.Handler)
        handler.path='/api/runs';handler.headers={'X-Studio-Token':studio.TOKEN,'Content-Length':str(len(raw))}
        handler.rfile=io.BytesIO(raw)
        handler.send=lambda status,body,kind='application/json',download=None:(status,body)
        return studio.Handler.do_POST(handler)
    def test_reject_bad_json_before_run(self):
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            try:
                for raw in [b'{"config":"a","config":"b"}',b'{"config":"a","experiment":{"kind":"custom_2d_steady","kind":"bad"}}',
                            b'{"config":"a","extra":1}',b'{"config":"a","experiment":{"power_w":{"x":NaN}}}',b' ' * 100001]:
                    with self.subTest(raw=raw[:80]):self.assertEqual(self.post(raw)[0],400)
                invalid=json.loads(json.dumps(self.experiment));invalid['power_w'].pop('core1')
                with patch.object(studio.subprocess,'run') as solver:
                    self.assertEqual(self.post(json.dumps({'config':self.config,'experiment':invalid}).encode())[0],400)
                    solver.assert_not_called()
                self.assertEqual(list(studio.RUNS.iterdir()),[])
            finally:studio.RUNS=old
    def test_custom_run_artifacts_and_no_transient(self):
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            calls=[]
            def solver(args,**kwargs):
                calls.append(args)
                (Path(kwargs['cwd'])/'temperatures.steady').write_text('core0\t320\ncore1\t315\n')
                return type('Process',(),{'returncode':0})()
            try:
                with patch.object(studio.subprocess,'run',side_effect=solver):
                    result=studio.run_simulation(self.config,self.experiment)
                self.assertEqual(result['status'],'completed',result['log'])
                self.assertEqual(len(calls),1)
                self.assertNotIn('-o',calls[0])
                self.assertEqual([r['name'] for r in result['rows']],['core0','core1'])
                self.assertEqual(set(result['artifacts']),set(studio.CUSTOM_INPUTS)|{'temperatures.steady'})
                self.assertNotIn('gcc.ttrace',result['artifacts'])
                folder=studio.RUNS/result['id']
                self.assertEqual((folder/'input.ptrace').read_text(),'core0\tcore1\n8\t6\n')
                self.assertEqual(result['experiment']['input_sha256'],studio.input_digest(folder,['tuned.config','submitted.experiment.json','example.materials','package.config']))
                with patch.object(studio.subprocess,'run',side_effect=solver):
                    repeated=studio.run_simulation(self.config,self.experiment)
                self.assertEqual(result['experiment']['input_sha256'],repeated['experiment']['input_sha256'])
                for name,artifact in result['artifacts'].items():
                    self.assertEqual(artifact['sha256'],studio.file_digest(folder/name)['sha256'])
                handler=object.__new__(studio.Handler)
                handler.send=lambda status,body,kind='application/json',download=None:(status,body,kind,download)
                for name in result['artifacts']:
                    handler.path=f'/api/runs/{result["id"]}/artifacts/{name}'
                    status,body,kind,download=studio.Handler.do_GET(handler)
                    self.assertEqual((status,kind,download),(200,'application/octet-stream',name))
                    self.assertEqual(body,(folder/name).read_bytes())
                handler.path='/api/runs'
                _,listing,_,_=studio.Handler.do_GET(handler)
                self.assertEqual(listing[0]['experiment'],{'kind':'custom_2d_steady'})
            finally:studio.RUNS=old
    def test_custom_failure_withholds_outputs_and_grid_mode(self):
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            try:
                def failed_solver(args,**kwargs):
                    (Path(kwargs['cwd'])/'temperatures.steady').write_text('partial\t320\n')
                    return type('Process',(),{'returncode':1})()
                with patch.object(studio.subprocess,'run',side_effect=failed_solver):
                    failed=studio.run_simulation(self.config,self.experiment)
                self.assertEqual(failed['status'],'failed')
                self.assertEqual(set(failed['artifacts']),set(studio.CUSTOM_INPUTS))
                def incomplete_solver(args,**kwargs):
                    (Path(kwargs['cwd'])/'temperatures.steady').write_text('core0\t320\n')
                    return type('Process',(),{'returncode':0})()
                with patch.object(studio.subprocess,'run',side_effect=incomplete_solver):
                    incomplete=studio.run_simulation(self.config,self.experiment)
                self.assertEqual(incomplete['status'],'failed')
                self.assertEqual(incomplete['rows'],[])
                self.assertEqual(set(incomplete['artifacts']),set(studio.CUSTOM_INPUTS))
                grid_config=self.grid_config()
                self.assertNotEqual(grid_config,self.config)
                def grid_solver(args,**kwargs):
                    self.assertIn('-grid_steady_file',args)
                    folder=Path(kwargs['cwd'])
                    (folder/'temperatures.steady').write_text('core0\t320\ncore1\t315\n')
                    (folder/'temperatures.grid.steady').write_text('0\t320\n')
                    return type('Process',(),{'returncode':0})()
                with patch.object(studio.subprocess,'run',side_effect=grid_solver):
                    grid=studio.run_simulation(grid_config,self.experiment)
                self.assertEqual(grid['status'],'completed',grid['log'])
                self.assertIn('temperatures.grid.steady',grid['artifacts'])
            finally:studio.RUNS=old
    def test_real_run(self):
        self.compatible_binary()
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            try:
                result=studio.run_simulation(self.config)
                self.assertEqual(result['status'],'completed',result['log']);self.assertGreater(len(result['rows']),0)
                folder=studio.RUNS/result['id'];self.assertEqual((folder/'submitted.config').read_text(),self.config)
                self.assertEqual(json.loads((folder/'result.json').read_text())['status'],'completed')
                for name in ['gcc.steady','gcc.ttrace']:
                    self.assertGreater((folder/name).stat().st_size,0)
                    self.assertEqual(result['artifacts'][name]['url'],f'/api/runs/{result["id"]}/artifacts/{name}')
                studio.LOCK.acquire()
                try:
                    with self.assertRaises(BlockingIOError):studio.run_simulation(self.config)
                finally:studio.LOCK.release()
            finally:studio.RUNS=old
    def test_real_custom(self):
        self.compatible_binary()
        with tempfile.TemporaryDirectory() as temp:
            old=studio.RUNS;studio.RUNS=Path(temp)
            try:
                first=studio.run_simulation(self.config,self.experiment)
                self.assertEqual(first['status'],'completed',first['log'])
                self.assertTrue({'core0','core1'} <= {row['name'] for row in first['rows']})
                self.experiment['power_w']['core0']=16
                second=studio.run_simulation(self.config,self.experiment)
                self.assertEqual(second['status'],'completed',second['log'])
                temperatures=lambda result:{row['name']:row['kelvin'] for row in result['rows']}
                self.assertGreater(temperatures(second)['core0'],temperatures(first)['core0'])
                grid=studio.run_simulation(self.grid_config(),self.experiment)
                self.assertEqual(grid['status'],'completed',grid['log'])
                self.assertIn('temperatures.grid.steady',grid['artifacts'])
            finally:studio.RUNS=old
if __name__=='__main__':unittest.main()
